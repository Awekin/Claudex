#!/usr/bin/env node
// Antigravity companion: runs tasks on the local Antigravity agent from Claude Code.
//
//   models [--json]
//   task [--model <alias|auto>] [--background] [--fresh] [--no-context] [--read-only] <prompt>
//   status [job-id] [--json]
//   result [job-id]
//
// Jobs are written in the same shape as the Codex companion's (state.json + jobs/<id>.json
// + jobs/<id>.log) so the Codex panel shows them too.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  describeStep,
  discoverServer,
  listModels,
  resolveModel,
  sendMessage,
  startConversation,
  summarizeTrajectory,
  waitForCompletion
} from "./lib/antigravity-client.mjs";
import { buildClaudeContextPreamble } from "./lib/claude-context.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const MAX_JOBS = 50;
const nowIso = () => new Date().toISOString();

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
  const { rendered, result, ...summary } = job;
  upsertJob(dir, summary);
}

function log(file, message) {
  if (file && message) fs.appendFileSync(file, `[${nowIso()}] ${String(message).trim()}\n`);
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
  if (ms == null || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин ${s % 60} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function renderCard(job, summary) {
  const ok = job.status === "completed";
  const title = job.summary.length > 60 ? `${job.summary.slice(0, 57)}…` : job.summary;
  const took = duration(Date.parse(job.completedAt) - Date.parse(job.startedAt));
  const lines = [
    `${ok ? "✅" : "❌"} **Antigravity: ${ok ? "готово" : "ошибка"}** · «${title}» · ${job.modelLabel}${took ? ` · ${took}` : ""}`,
    ""
  ];
  if (job.fallbackFrom) lines.push(`_${job.fallbackFrom} недоступна (квота), использована ${job.modelLabel}._`, "");
  lines.push(summary?.finalText?.trim() || job.errorMessage || "(пустой ответ)", "");
  const files = summary?.fileChanges ?? [];
  if (files.length) {
    const add = files.reduce((n, f) => n + (Number(f.additions) || 0), 0);
    const del = files.reduce((n, f) => n + (Number(f.deletions) || 0), 0);
    lines.push(`**Изменённые файлы (${files.length})** · +${add} −${del}`);
    for (const f of files) {
      const rel = path.relative(job.workspaceRoot, f.path || "") || f.path;
      lines.push(`- \`${rel}\`${f.created ? " (новый)" : ""} +${f.additions || 0} −${f.deletions || 0}`);
    }
    lines.push("");
  }
  const cmds = summary?.commands ?? [];
  if (cmds.length) {
    const sorted = [...cmds].sort((a, b) => Number((b.exitCode ?? 0) !== 0) - Number((a.exitCode ?? 0) !== 0));
    lines.push(`**Команды (${cmds.length})**`);
    for (const c of sorted.slice(0, 12)) lines.push(`- ${c.exitCode === 0 ? "✓" : "✗"} \`${String(c.command).slice(0, 100)}\``);
    lines.push("");
  }
  if (summary?.errors?.length) lines.push(`**Ошибки:** ${summary.errors.slice(0, 3).join("; ")}`, "");
  lines.push(`Разговор в Antigravity: \`${job.threadId}\``);
  return `${lines.join("\n").trim()}\n`;
}

// ---------- task ----------

const PHASE_BY_STEP = {
  CORTEX_STEP_TYPE_CODE_ACTION: "editing",
  CORTEX_STEP_TYPE_RUN_COMMAND: "verifying",
  CORTEX_STEP_TYPE_PLANNER_RESPONSE: "investigating"
};

async function runJob(dir, job) {
  const file = logFile(dir, job.id);
  job.status = "running";
  job.phase = "starting";
  job.pid = process.pid;
  job.startedAt = nowIso();
  writeJob(dir, job);
  try {
    const server = await discoverServer();
    let cascadeId = job.threadId;
    if (!cascadeId) {
      cascadeId = await startConversation(server, { cwd: job.workspaceRoot });
      log(file, `Started Antigravity conversation ${cascadeId}.`);
    } else {
      log(file, `Continuing Antigravity conversation ${cascadeId}.`);
    }
    job.threadId = cascadeId;
    writeJob(dir, job);
    if (job.sessionId) {
      updateState(dir, (s) => {
        s.threads[job.sessionId] = { cascadeId, lastTaskAt: job.startedAt };
      });
    }
    await sendMessage(server, { cascadeId, text: job.request.prompt, model: job.model });
    log(file, `Sent task to ${job.modelLabel}.`);
    let seen = 0;
    const final = await waitForCompletion(server, cascadeId, {
      minSteps: job.request.skipSteps ?? 0,
      onStep(step, index) {
        if (index < (job.request.skipSteps ?? 0)) return;
        seen = index + 1;
        log(file, describeStep(step));
        const phase = PHASE_BY_STEP[step.type];
        if (phase && phase !== job.phase && !(job.phase === "verifying" && phase === "investigating")) {
          job.phase = phase;
          upsertJob(dir, { id: job.id, phase });
        }
      }
    });
    const steps = final?.trajectory?.steps ?? [];
    const summary = summarizeTrajectory({ ...final, trajectory: { ...final.trajectory, steps: steps.slice(job.request.skipSteps ?? 0) } });
    job.status = summary.finalText ? "completed" : "failed";
    job.phase = job.status === "completed" ? "done" : "failed";
    job.completedAt = nowIso();
    job.pid = null;
    job.result = { rawOutput: summary.finalText, fileChanges: summary.fileChanges, commands: summary.commands, errors: summary.errors, steps: seen };
    job.rendered = renderCard(job, summary);
    writeJob(dir, job);
    upsertJob(dir, { id: job.id, summary: job.summary });
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
  const cwd = flags.cwd || process.cwd();
  const root = workspaceRoot(cwd);
  const dir = stateDir(root);
  const sessionId = process.env.ANTIGRAVITY_COMPANION_SESSION_ID || null;

  const server = await discoverServer();
  const { models } = await listModels(server);
  const { entry, fallbackFrom } = resolveModel(models, flags.model || "auto");
  if (!entry) throw new Error("В Antigravity нет доступных моделей (закончилась квота?). Проверьте: antigravity-companion models");

  // Continue this Claude session's conversation unless asked for a fresh one.
  const thread = !flags.fresh && sessionId ? loadState(dir).threads[sessionId] : null;
  let skipSteps = 0;
  if (thread?.cascadeId) {
    try {
      const { getTrajectory } = await import("./lib/antigravity-client.mjs");
      const existing = await getTrajectory(server, thread.cascadeId);
      skipSteps = existing?.trajectory?.steps?.length ?? 0;
    } catch {
      skipSteps = 0;
    }
  }
  const continuing = Boolean(thread?.cascadeId) && skipSteps > 0;
  const context = flags.noContext
    ? ""
    : buildClaudeContextPreamble({ sinceMs: continuing ? Date.parse(thread.lastTaskAt) : undefined, disabled: false }) || "";
  const guard = flags.readOnly ? "Do not modify any files and do not run commands that change state. Only read, analyse and answer.\n\n" : "";
  const prompt = `${guard}${text}${context ? `\n\n${context}` : ""}`;

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
    fallbackFrom: fallbackFrom ?? null,
    workspaceRoot: root,
    sessionId,
    threadId: continuing ? thread.cascadeId : null,
    createdAt: nowIso(),
    logFile: logFile(dir, id),
    request: { prompt, skipSteps }
  };
  fs.writeFileSync(job.logFile, "");
  log(job.logFile, `Starting Antigravity task on ${entry.label}.`);

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
      `Antigravity-задача запущена в фоне: ${id} (${entry.label}${fallbackFrom ? `, вместо ${fallbackFrom}` : ""}).\n` +
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
  const server = await discoverServer();
  const { models, defaultModel } = await listModels(server);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ models, defaultModel }, null, 2)}\n`);
    return;
  }
  const lines = ["| Модель | Алиас | Квота |", "|---|---|---|"];
  for (const m of models) {
    const quota = m.remaining == null ? "—" : `${Math.round(m.remaining * 100)}%`;
    const alias = m.family !== "other" ? `${m.family}${m.level ? `-${m.level}` : ""}` : m.model;
    lines.push(`| ${m.available ? "" : "~~"}${m.label}${m.available ? "" : "~~"} | \`${alias}\` | ${quota} |`);
  }
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
      "  task [--model <alias|auto>] [--background] [--fresh] [--no-context] [--read-only] <prompt>\n"
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
