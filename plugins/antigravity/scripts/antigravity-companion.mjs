#!/usr/bin/env node
// Antigravity companion: runs tasks through the official Antigravity CLI (`agy`) from Claude Code.
//
//   models [--json]
//   task [--model <alias|slug|auto>] [--background] [--fresh] [--no-context] [--read-only] <prompt>
//   status [job-id] [--json]
//   result [job-id]
//
// Jobs are written in the same shape as the Codex companion's (state.json + jobs/<id>.json
// + jobs/<id>.log) so the agents panel shows them too. Model quota comes from the Antigravity
// app when it happens to be running; without it the quota is simply unknown.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describeEvent, isQuotaError, listModels as listAgyModels, resolveAgyBinary, runAgy } from "./lib/agy.mjs";
import { discoverServer, listModels as listAppModels, resolveModel } from "./lib/antigravity-client.mjs";
import { buildClaudeContextPreamble } from "./lib/claude-context.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const MAX_JOBS = 50;
const TASK_TIMEOUT_MS = 60 * 60_000;
const nowIso = () => new Date().toISOString();
const pct = (fraction) => (typeof fraction === "number" ? `${Math.round(fraction * 100)}%` : null);

// ---------- state ----------

function workspaceRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd;
  } catch {
    return cwd;
  }
}

function stateDir(root) {
  const dataRoot =
    process.env.ANTIGRAVITY_COMPANION_DATA ||
    path.join(os.homedir(), ".claude", "plugins", "data", "antigravity-local");
  let canonical = root;
  try {
    canonical = fs.realpathSync.native(root);
  } catch {}
  const slug = (path.basename(root) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const dir = path.join(dataRoot, "state", `${slug}-${hash}`);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function loadState(dir) {
  const state = readJson(path.join(dir, "state.json"), null) ?? {};
  return { version: 1, jobs: [], threads: {}, ...state };
}

function updateState(dir, mutate) {
  const state = loadState(dir);
  mutate(state);
  state.jobs = state.jobs.slice(0, MAX_JOBS);
  writeJson(path.join(dir, "state.json"), state);
  return state;
}

function upsertJob(dir, patch) {
  updateState(dir, (state) => {
    const i = state.jobs.findIndex((j) => j.id === patch.id);
    const merged = { ...(i >= 0 ? state.jobs[i] : {}), ...patch, updatedAt: nowIso() };
    if (i >= 0) state.jobs.splice(i, 1);
    state.jobs.unshift(merged);
  });
}

const jobFile = (dir, id) => path.join(dir, "jobs", `${id}.json`);
const logFile = (dir, id) => path.join(dir, "jobs", `${id}.log`);

function writeJob(dir, job) {
  writeJson(jobFile(dir, job.id), job);
  const { rendered, result, request, ...summary } = job;
  upsertJob(dir, summary);
}

function log(file, message) {
  if (file && message) fs.appendFileSync(file, `[${nowIso()}] ${String(message).replace(/\s+/g, " ").trim()}\n`);
}

// ---------- models + quota ----------

/** agy's model list, with quota from the Antigravity app when it is running. */
async function getModels() {
  const models = await listAgyModels();
  const quota = new Map();
  try {
    const server = await discoverServer();
    const { models: appModels } = await listAppModels(server);
    for (const m of appModels) quota.set(m.label, m.remaining);
  } catch {
    // App closed: quota unknown, every model counts as available.
  }
  return models.map((m) => {
    const remaining = quota.has(m.label) ? quota.get(m.label) : null;
    return { ...m, remaining, available: remaining !== 0 };
  });
}

// ---------- args ----------

function parseArgs(argv) {
  const flags = { model: null, background: false, fresh: false, noContext: false, readOnly: false, json: false, jobId: null, cwd: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") flags.model = argv[++i] ?? null;
    else if (a.startsWith("--model=")) flags.model = a.slice(8);
    else if (a === "--background") flags.background = true;
    else if (a === "--wait") flags.background = false;
    else if (a === "--fresh") flags.fresh = true;
    else if (a === "--no-context") flags.noContext = true;
    else if (a === "--read-only") flags.readOnly = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--job-id") flags.jobId = argv[++i] ?? null;
    else if (a === "--cwd") flags.cwd = argv[++i] ?? null;
    else rest.push(a);
  }
  return { flags, text: rest.join(" ").trim() };
}

// ---------- rendering ----------

function duration(ms) {
  if (ms == null || ms < 0 || Number.isNaN(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин ${s % 60} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function quotaText(job) {
  const before = pct(job.quotaBefore);
  const after = pct(job.quotaAfter);
  if (!before && !after) return "";
  return ` · квота ${before && after && before !== after ? `${before} → ${after}` : after || before}`;
}

/** +/- line counts for the files agy touched, from git (best effort). */
function lineCounts(root, files) {
  const counts = new Map();
  try {
    const out = execFileSync("git", ["diff", "--numstat", "HEAD", "--", ...files.map((f) => f.path)], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    for (const line of out.split("\n")) {
      const [add, del, file] = line.split("\t");
      if (file) counts.set(path.resolve(root, file), { additions: Number(add) || 0, deletions: Number(del) || 0 });
    }
  } catch {}
  for (const f of files) {
    if (!counts.has(path.resolve(f.path)) && f.created) {
      try {
        counts.set(path.resolve(f.path), { additions: fs.readFileSync(f.path, "utf8").split("\n").filter(Boolean).length, deletions: 0 });
      } catch {}
    }
  }
  return counts;
}

function renderCard(job, run) {
  const ok = job.status === "completed";
  const title = job.summary.length > 60 ? `${job.summary.slice(0, 57)}…` : job.summary;
  const took = duration(Date.parse(job.completedAt) - Date.parse(job.startedAt));
  const lines = [
    `${ok ? "✅" : "❌"} **Antigravity: ${ok ? "готово" : "ошибка"}** · «${title}» · ${job.modelLabel}${took ? ` · ${took}` : ""}${quotaText(job)}`,
    ""
  ];
  if (job.fallbackFrom) lines.push(`_${job.fallbackFrom} недоступна (квота), использована ${job.modelLabel}._`, "");
  lines.push(run?.finalText?.trim() || job.errorMessage || "(пустой ответ)", "");
  const files = run?.fileChanges ?? [];
  if (files.length) {
    const counts = lineCounts(job.workspaceRoot, files);
    const stat = (f) => counts.get(path.resolve(f.path)) ?? { additions: 0, deletions: 0 };
    const add = files.reduce((n, f) => n + stat(f).additions, 0);
    const del = files.reduce((n, f) => n + stat(f).deletions, 0);
    lines.push(`**Изменённые файлы (${files.length})** · +${add} −${del}`);
    for (const f of files) {
      const rel = path.relative(job.workspaceRoot, f.path) || f.path;
      lines.push(`- \`${rel}\`${f.created ? " (новый)" : ""} +${stat(f).additions} −${stat(f).deletions}`);
    }
    lines.push("");
  }
  const cmds = run?.commands ?? [];
  if (cmds.length) {
    const failed = (c) => c.exitCode != null && c.exitCode !== 0;
    const sorted = [...cmds].sort((a, b) => Number(failed(b)) - Number(failed(a)));
    lines.push(`**Команды (${cmds.length})**`);
    for (const c of sorted.slice(0, 12)) lines.push(`- ${failed(c) ? "✗" : "✓"} \`${String(c.command).slice(0, 100)}\``);
    lines.push("");
  }
  lines.push(`Разговор agy: \`${job.threadId ?? "—"}\` · продолжить: \`agy --conversation ${job.threadId ?? "<id>"}\``);
  return `${lines.join("\n").trim()}\n`;
}

// ---------- task ----------

function phaseFor(event) {
  const step = event?.step_update;
  if (!step) return null;
  if (step.step_type === "tool") {
    if (step.tool_name === "edit_file" || step.tool_name === "write_file") return "editing";
    if (step.tool_name === "run_command") return "verifying";
    return "investigating";
  }
  return step.step_type === "agent_response" ? "investigating" : null;
}

async function runJob(dir, job) {
  const file = logFile(dir, job.id);
  job.status = "running";
  job.phase = "starting";
  job.pid = process.pid;
  job.startedAt = nowIso();
  writeJob(dir, job);

  const attempt = (model) =>
    runAgy({
      cwd: job.workspaceRoot,
      prompt: job.request.prompt,
      model,
      conversationId: job.threadId,
      readOnly: !job.write,
      timeoutMs: TASK_TIMEOUT_MS,
      onEvent(event, state) {
        if (state.conversationId && state.conversationId !== job.threadId) {
          job.threadId = state.conversationId;
          writeJob(dir, job);
          if (job.sessionId) {
            updateState(dir, (s) => {
              s.threads[job.sessionId] = { agyConversationId: job.threadId, lastTaskAt: job.startedAt };
            });
          }
        }
        log(file, describeEvent(event, state));
        const phase = phaseFor(event);
        if (phase && phase !== job.phase && !(job.phase === "verifying" && phase === "investigating")) {
          job.phase = phase;
          upsertJob(dir, { id: job.id, phase });
        }
      }
    });

  try {
    let run = await attempt(job.model);
    // Out of quota: switch once to the next model for the same wish.
    if (run.status !== "SUCCESS" && isQuotaError(run)) {
      const models = (await getModels()).map((m) => (m.model === job.model ? { ...m, available: false } : m));
      const { entry } = resolveModel(models, job.request.wish);
      if (entry && entry.model !== job.model) {
        log(file, `Quota exhausted for ${job.modelLabel}; retrying on ${entry.label}.`);
        job.fallbackFrom = job.modelLabel;
        job.model = entry.model;
        job.modelLabel = entry.label;
        job.quotaBefore = entry.remaining ?? null;
        writeJob(dir, job);
        run = await attempt(entry.model);
      }
    }
    try {
      job.quotaAfter = (await getModels()).find((m) => m.model === job.model)?.remaining ?? null;
    } catch {
      job.quotaAfter = null;
    }
    const ok = run.status === "SUCCESS" && Boolean(run.finalText);
    job.status = ok ? "completed" : "failed";
    job.phase = ok ? "done" : "failed";
    if (!ok) job.errorMessage = run.error || run.stderr?.trim().split("\n").slice(-3).join(" ") || `agy завершился с кодом ${run.exitCode}`;
    job.completedAt = nowIso();
    job.pid = null;
    job.result = { rawOutput: run.finalText, fileChanges: run.fileChanges, commands: run.commands, usage: run.usage };
    job.rendered = renderCard(job, run);
    writeJob(dir, job);
    return job;
  } catch (error) {
    job.status = "failed";
    job.phase = "failed";
    job.errorMessage = error instanceof Error ? error.message : String(error);
    job.completedAt = nowIso();
    job.pid = null;
    job.rendered = renderCard(job, null);
    log(file, `Failed: ${job.errorMessage}`);
    writeJob(dir, job);
    return job;
  }
}

async function handleTask(flags, text) {
  if (!text) throw new Error("Нужен текст задачи: antigravity-companion task <prompt>");
  if (!resolveAgyBinary()) {
    throw new Error("Не найден Antigravity CLI (agy). Установите: curl -fsSL https://antigravity.google/cli/install.sh | bash, затем один раз запустите agy и войдите.");
  }
  const cwd = flags.cwd || process.cwd();
  const root = workspaceRoot(cwd);
  const dir = stateDir(root);
  const sessionId = process.env.ANTIGRAVITY_COMPANION_SESSION_ID || null;

  const wish = flags.model || "auto";
  const { entry, fallbackFrom } = resolveModel(await getModels(), wish);
  if (!entry) throw new Error("agy не вернул доступных моделей. Проверьте: antigravity-companion models");

  // Continue this Claude session's agy conversation unless asked for a fresh one.
  const thread = !flags.fresh && sessionId ? loadState(dir).threads[sessionId] : null;
  const continuing = Boolean(thread?.agyConversationId);
  const context = flags.noContext
    ? ""
    : buildClaudeContextPreamble({ sinceMs: continuing ? Date.parse(thread.lastTaskAt) : undefined, disabled: false }) || "";
  const prompt = `${text}${context ? `\n\n${context}` : ""}`;

  const id = `ag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    kind: "antigravity",
    kindLabel: "antigravity",
    title: "Antigravity Task",
    summary: text.replace(/\s+/g, " ").slice(0, 100) + (text.length > 100 ? "..." : ""),
    write: !flags.readOnly,
    model: entry.model,
    modelLabel: entry.label,
    quotaBefore: entry.remaining ?? null,
    fallbackFrom: fallbackFrom ?? null,
    workspaceRoot: root,
    sessionId,
    threadId: continuing ? thread.agyConversationId : null,
    createdAt: nowIso(),
    logFile: logFile(dir, id),
    request: { prompt, wish }
  };
  fs.writeFileSync(job.logFile, "");
  log(job.logFile, `Starting Antigravity task on ${entry.label}${pct(entry.remaining) ? ` (quota ${pct(entry.remaining)})` : ""}.`);

  if (flags.background) {
    job.status = "queued";
    job.phase = "queued";
    writeJob(dir, job);
    const child = spawn(process.execPath, [SCRIPT, "task-worker", "--cwd", root, "--job-id", id], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
    process.stdout.write(
      `Antigravity-задача запущена в фоне: ${id} (${entry.label}${pct(entry.remaining) ? `, квота ${pct(entry.remaining)}` : ""}${fallbackFrom ? `, вместо ${fallbackFrom}` : ""}).\n` +
        `Проверить: /antigravity:status ${id}, результат: /antigravity:result ${id}\n`
    );
    return;
  }
  const done = await runJob(dir, job);
  process.stdout.write(done.rendered);
  if (done.status !== "completed") process.exitCode = 1;
}

async function handleWorker(flags) {
  const root = flags.cwd || process.cwd();
  const dir = stateDir(root);
  const job = readJson(jobFile(dir, flags.jobId), null);
  if (!job) throw new Error(`Задача ${flags.jobId} не найдена`);
  await runJob(dir, job);
}

// ---------- models / status / result ----------

async function handleModels(flags) {
  const models = await getModels();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
    return;
  }
  const known = models.some((m) => m.remaining != null);
  const lines = ["| Модель | `--model` | Квота |", "|---|---|---|"];
  for (const m of models) {
    const quota = m.remaining == null ? "—" : pct(m.remaining);
    lines.push(`| ${m.available ? "" : "~~"}${m.label}${m.available ? "" : "~~"} | \`${m.model}\` | ${quota} |`);
  }
  if (!known) lines.push("", "_Квота неизвестна: приложение Antigravity закрыто. Откройте его, чтобы видеть остаток._");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function findJobs(cwd) {
  const dir = stateDir(workspaceRoot(cwd));
  return { dir, jobs: loadState(dir).jobs };
}

function handleStatus(flags, text) {
  const { dir, jobs } = findJobs(flags.cwd || process.cwd());
  const id = flags.jobId || text || null;
  const list = id ? jobs.filter((j) => j.id === id) : jobs.slice(0, 8);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return;
  }
  if (!list.length) {
    process.stdout.write("Задач Antigravity в этой папке пока нет.\n");
    return;
  }
  for (const j of list) {
    const icon = j.status === "completed" ? "✅" : j.status === "failed" ? "❌" : "🔵";
    process.stdout.write(`${icon} ${j.id} · ${j.modelLabel} · ${j.phase ?? j.status} · ${j.summary}\n`);
    if (id) {
      const tail = (fs.existsSync(logFile(dir, j.id)) ? fs.readFileSync(logFile(dir, j.id), "utf8") : "").trim().split("\n").slice(-8);
      if (tail.length) process.stdout.write(`${tail.map((l) => `   ${l}`).join("\n")}\n`);
    }
  }
}

function handleResult(flags, text) {
  const { dir, jobs } = findJobs(flags.cwd || process.cwd());
  const id = flags.jobId || text || jobs.find((j) => j.status !== "running" && j.status !== "queued")?.id;
  const job = id ? readJson(jobFile(dir, id), null) : null;
  if (!job) {
    process.stdout.write("Готовых задач Antigravity не найдено.\n");
    return;
  }
  if (!job.rendered) {
    process.stdout.write(`Задача ${job.id} ещё выполняется (${job.phase}).\n`);
    return;
  }
  process.stdout.write(job.rendered);
}

// ---------- main ----------

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { flags, text } = parseArgs(argv);
  if (command === "models") return handleModels(flags);
  if (command === "task") return handleTask(flags, text);
  if (command === "task-worker") return handleWorker(flags);
  if (command === "status") return handleStatus(flags, text);
  if (command === "result") return handleResult(flags, text);
  process.stdout.write(
    "Usage: antigravity-companion <models|task|status|result>\n" +
      "  task [--model <alias|slug|auto>] [--background] [--fresh] [--no-context] [--read-only] <prompt>\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
