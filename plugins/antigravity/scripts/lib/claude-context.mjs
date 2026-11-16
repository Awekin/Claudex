import fs from "node:fs";
import process from "node:process";

const TRANSCRIPT_PATH_ENV = "ANTIGRAVITY_COMPANION_TRANSCRIPT_PATH";

export const NO_CLAUDE_CONTEXT_ENV = "ANTIGRAVITY_COMPANION_NO_CLAUDE_CONTEXT";
const DEFAULT_MAX_CHARS = 16000;
const PER_MESSAGE_MAX_CHARS = 2500;

function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function isNoise(text) {
  const trimmed = text.trim();
  return (
    !trimmed ||
    trimmed.startsWith("<command-") ||
    trimmed.startsWith("<local-command-") ||
    trimmed.startsWith("<system-reminder>") ||
    trimmed.startsWith("<task-notification>") ||
    trimmed.startsWith("[Request interrupted")
  );
}

function clip(text, limit) {
  const normalized = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 20)}\n…[truncated]`;
}

/**
 * Reads the visible user/assistant text from a Claude Code transcript (no tool calls, tool
 * output or thinking). `sinceMs` keeps only messages newer than that time.
 */
export function readClaudeConversation(transcriptPath, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return [];
  }
  const sinceMs = Number(options.sinceMs) || 0;
  const messages = [];
  for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if ((entry.type !== "user" && entry.type !== "assistant") || entry.isSidechain || entry.isMeta) {
      continue;
    }
    const at = Date.parse(entry.timestamp ?? "") || 0;
    if (sinceMs && at && at <= sinceMs) {
      continue;
    }
    const text = textOf(entry.message?.content);
    if (isNoise(text)) {
      continue;
    }
    const role = entry.type === "user" ? "User" : "Claude";
    const previous = messages[messages.length - 1];
    if (previous && previous.role === role) {
      previous.text += `\n\n${text.trim()}`;
    } else {
      messages.push({ role, text: text.trim(), at });
    }
  }
  return messages;
}

/**
 * Builds a "context from Claude Code" preamble for a Codex prompt, newest messages kept first
 * when the budget runs out. Returns "" when there is nothing to add or it is disabled.
 */
export function buildClaudeContextPreamble(options = {}) {
  if (options.disabled || process.env[NO_CLAUDE_CONTEXT_ENV] === "1") {
    return "";
  }
  const transcriptPath = options.transcriptPath ?? process.env[TRANSCRIPT_PATH_ENV];
  let messages = readClaudeConversation(transcriptPath, { sinceMs: options.sinceMs });
  // The last user message is usually the request that is being forwarded to Codex right now.
  if (messages.length && messages[messages.length - 1].role === "User") {
    messages = messages.slice(0, -1);
  }
  if (!messages.length) {
    return "";
  }

  const budget = Number(options.maxChars) || DEFAULT_MAX_CHARS;
  const parts = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const block = `### ${messages[i].role}\n${clip(messages[i].text, PER_MESSAGE_MAX_CHARS)}`;
    if (used + block.length > budget && parts.length) {
      break;
    }
    parts.unshift(block);
    used += block.length;
  }
  const omitted = messages.length - parts.length;

  const heading = options.sinceMs
    ? "Since your last turn, the conversation in Claude Code continued. New messages, for context:"
    : "The task above comes from a Claude Code session. Recent conversation there, for context:";
  return [
    "<claude_code_context>",
    heading,
    omitted > 0 ? `(${omitted} earlier message(s) omitted)` : null,
    "",
    parts.join("\n\n"),
    "</claude_code_context>"
  ]
    .filter((line) => line !== null)
    .join("\n");
}
