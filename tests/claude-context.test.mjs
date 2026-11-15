import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildClaudeContextPreamble, readClaudeConversation } from "../plugins/codex/scripts/lib/claude-context.mjs";

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ctx-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

const at = (minute) => `2026-11-09T10:${String(minute).padStart(2, "0")}:00.000Z`;

test("reads visible user and assistant text, skipping tools and noise", () => {
  const file = writeTranscript([
    { type: "user", timestamp: at(1), message: { content: "Fix the login bug" } },
    { type: "assistant", timestamp: at(2), message: { content: [{ type: "thinking", thinking: "x" }, { type: "tool_use", name: "Read" }] } },
    { type: "user", timestamp: at(3), message: { content: [{ type: "tool_result", content: "file body" }] } },
    { type: "assistant", timestamp: at(4), message: { content: [{ type: "text", text: "The token is never refreshed." }] } },
    { type: "user", timestamp: at(5), isMeta: true, message: { content: "meta" } },
    { type: "user", timestamp: at(6), message: { content: "<command-name>/codex:rescue</command-name>" } }
  ]);
  const messages = readClaudeConversation(file);
  assert.deepEqual(messages.map((m) => [m.role, m.text]), [
    ["User", "Fix the login bug"],
    ["Claude", "The token is never refreshed."]
  ]);
});

test("preamble drops the trailing user request and honours sinceMs", () => {
  const file = writeTranscript([
    { type: "user", timestamp: at(1), message: { content: "old question" } },
    { type: "assistant", timestamp: at(2), message: { content: [{ type: "text", text: "old answer" }] } },
    { type: "user", timestamp: at(3), message: { content: "new question" } },
    { type: "assistant", timestamp: at(4), message: { content: [{ type: "text", text: "new answer" }] } },
    { type: "user", timestamp: at(5), message: { content: "ask codex to do it" } }
  ]);
  const full = buildClaudeContextPreamble({ transcriptPath: file });
  assert.match(full, /<claude_code_context>/);
  assert.match(full, /old question/);
  assert.doesNotMatch(full, /ask codex to do it/);

  const delta = buildClaudeContextPreamble({ transcriptPath: file, sinceMs: Date.parse(at(2)) });
  assert.doesNotMatch(delta, /old answer/);
  assert.match(delta, /new answer/);

  assert.equal(buildClaudeContextPreamble({ transcriptPath: file, disabled: true }), "");
});
