import process from "node:process";

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatCodexResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `codex resume ${job.threadId}`;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Codex Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/codex:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/codex:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Codex session ID: ${job.threadId}`);
  }
  const resumeCommand = formatCodexResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Codex: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /codex:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /codex:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /codex:review --wait");
    lines.push("  Stricter review: /codex:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

export function renderSetupReport(report) {
  const lines = [
    "# Codex Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- codex: ${report.codex.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      "Codex did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Codex returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Codex review completed without any stdout output.");
  } else {
    lines.push("Codex review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderPlainTaskResult(parsedResult) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Codex did not return a final message.";
  return `${message}\n`;
}

function countDiffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function relativeTo(root, file) {
  if (root && typeof file === "string" && file.startsWith(`${root}/`)) {
    return file.slice(root.length + 1);
  }
  return file;
}

/** Collapses fileChange items into one row per path with +/- line counts. */
export function summarizeFileChanges(fileChanges, root = null) {
  const byPath = new Map();
  for (const item of fileChanges ?? []) {
    for (const change of item?.changes ?? []) {
      if (!change?.path) {
        continue;
      }
      const key = relativeTo(root, change.path);
      const entry = byPath.get(key) ?? { path: key, kind: null, added: 0, removed: 0 };
      const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
      entry.kind = entry.kind ?? kind ?? "update";
      const counts = countDiffLines(change.diff);
      entry.added += counts.added;
      entry.removed += counts.removed;
      byPath.set(key, entry);
    }
  }
  return [...byPath.values()];
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} с`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${seconds % 60} с`;
}

function shortCommand(command) {
  const text = String(command ?? "").replace(/^\/bin\/(?:ba|z)?sh -lc /, "").replace(/^(['"])(.*)\1$/s, "$2");
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}

/**
 * Markdown card for a finished Codex task: status line, Codex's own answer, files changed,
 * commands run, reasoning summary and where to open the thread. Set
 * CODEX_COMPANION_PLAIN_OUTPUT=1 for the bare final message instead.
 */
export function renderTaskResult(parsedResult, meta = {}) {
  if (process.env.CODEX_COMPANION_PLAIN_OUTPUT === "1") {
    return renderPlainTaskResult(parsedResult);
  }
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput.trim() : "";
  const failed = meta.status != null ? meta.status !== 0 : !rawOutput;
  const files = summarizeFileChanges(meta.fileChanges, meta.workspaceRoot);
  const commands = (meta.commandExecutions ?? []).filter((item) => item?.command);
  const duration = formatDuration(meta.durationMs);

  const head = [failed ? "❌ **Codex: задача не выполнена**" : "✅ **Codex: готово**"];
  if (meta.threadName) {
    head.push(`«${meta.threadName.replace(/^Claude → Codex:\s*/, "")}»`);
  }
  if (duration) {
    head.push(duration);
  }
  const lines = [head.join(" · "), ""];

  if (rawOutput) {
    lines.push(rawOutput, "");
  } else {
    const message = String(parsedResult?.failureMessage ?? "").trim() || "Codex did not return a final message.";
    lines.push(`> ${message.split("\n").join("\n> ")}`, "");
  }

  lines.push("---", "");
  if (files.length) {
    const added = files.reduce((sum, file) => sum + file.added, 0);
    const removed = files.reduce((sum, file) => sum + file.removed, 0);
    lines.push(`**Изменённые файлы (${files.length})** · +${added} −${removed}`);
    for (const file of files.slice(0, 15)) {
      const mark = file.kind === "add" ? "🆕 " : file.kind === "delete" ? "🗑 " : "";
      lines.push(`- ${mark}\`${file.path}\` +${file.added} −${file.removed}`);
    }
    if (files.length > 15) {
      lines.push(`- …и ещё ${files.length - 15}`);
    }
  } else {
    lines.push(meta.write ? "**Файлы не менялись.**" : "**Только чтение:** файлы не менялись.");
  }

  if (commands.length) {
    const failedCommands = commands.filter((item) => item.exitCode != null && item.exitCode !== 0);
    lines.push("", `**Команды (${commands.length})** · ✓ ${commands.length - failedCommands.length} · ✗ ${failedCommands.length}`);
    const shown = [...failedCommands, ...commands.filter((item) => !failedCommands.includes(item))].slice(0, 6);
    for (const item of shown) {
      const ok = item.exitCode == null || item.exitCode === 0;
      lines.push(`- ${ok ? "✓" : "✗"} \`${shortCommand(item.command)}\`${ok ? "" : ` (exit ${item.exitCode})`}`);
    }
    if (commands.length > shown.length) {
      lines.push(`- …и ещё ${commands.length - shown.length}`);
    }
  }

  const reasoning = Array.isArray(parsedResult?.reasoningSummary) ? parsedResult.reasoningSummary : [];
  if (reasoning.length) {
    lines.push("", "**Как рассуждал (кратко)**");
    for (const section of reasoning.slice(0, 5)) {
      lines.push(`- ${String(section).replace(/\s+/g, " ").trim()}`);
    }
  }

  const limits = formatRateLimits(meta.rateLimits);
  if (limits) lines.push("", limits);
  if (meta.threadId) {
    lines.push("", `Тред в Codex: \`${meta.threadId}\`${meta.projectHint ? ` · ${meta.projectHint}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatWindowName(mins) {
  if (mins === 300) return "5 ч";
  if (mins === 10080) return "неделя";
  if (mins == null) return "лимит";
  return mins % 1440 === 0 ? `${mins / 1440} дн` : mins % 60 === 0 ? `${mins / 60} ч` : `${mins} мин`;
}

function formatResetTime(resetsAt, now = Date.now()) {
  if (!resetsAt) return "";
  const date = new Date(resetsAt * 1000);
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (date.getTime() - now < 24 * 3600 * 1000) return `сброс в ${time}`;
  return `сброс ${date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })} ${time}`;
}

/** "Лимиты Codex: 5 ч — осталось 94% (сброс в 14:20) · неделя — осталось 72% (…)", or "" without data. */
export function formatRateLimits(limits, now = Date.now()) {
  if (!limits) return "";
  const parts = [limits.primary, limits.secondary]
    .filter(Boolean)
    .map((w) => {
      const left = Math.max(0, 100 - Math.round(w.usedPercent));
      const reset = formatResetTime(w.resetsAt, now);
      return `${formatWindowName(w.windowMins)} — осталось ${left}%${reset ? ` (${reset})` : ""}`;
    });
  if (!parts.length) return "";
  return `${limits.reached ? "⚠️ " : ""}**Лимиты Codex:** ${parts.join(" · ")}`;
}

export function renderStatusReport(report) {
  const lines = [
    "# Codex Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Codex adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Codex Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `codex resume ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  // Finished tasks keep their rendered card; show it unless plain output was asked for.
  const isCard = typeof storedJob?.rendered === "string" && /^(?:✅|❌|⚠️|⏹)[^\n]*\*\*Codex/u.test(storedJob.rendered);
  if (isCard && process.env.CODEX_COMPANION_PLAIN_OUTPUT !== "1") {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    return resumeCommand ? `${output}\nПродолжить в терминале: \`${resumeCommand}\`\n` : output;
  }

  const rawOutput =
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    (typeof storedJob?.result?.codex?.stdout === "string" && storedJob.result.codex.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Codex Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Codex session ID: ${threadId}`);
    lines.push(`Resume in Codex: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = [
    "# Codex Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/codex:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}
