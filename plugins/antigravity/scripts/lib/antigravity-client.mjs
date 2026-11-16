import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const execDefault = promisify(execCallback);
const SERVICE = 'exa.language_server_pb.LanguageServerService';
const DONE = 'CORTEX_STEP_STATUS_DONE';
const PLANNER = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';

export async function rpc(server, method, body, opts = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (opts.signal?.aborted) abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, opts.requestTimeoutMs ?? 10_000);
  try {
    const address = server.address.replace(/^http:\/\//, '').replace(/\/$/, '');
    const response = await (opts.fetch ?? globalThis.fetch)(`http://${address}/${SERVICE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': server.csrfToken },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.ok === false) throw new Error('HTTP failure');
    return await response.json();
  } catch {
    // Do not propagate server bodies or transport errors: they may contain credentials.
    throw new Error(controller.signal.aborted ? 'Antigravity RPC aborted or timed out' : 'Antigravity RPC failed');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }
}

export async function discoverServer(opts = {}) {
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? execDefault;
  const stdout = async command => {
    const result = await exec(command);
    return typeof result === 'string' ? result : result.stdout;
  };
  const probe = async server => {
    try {
      const result = await rpc(server, 'GetUserStatus', {}, { ...opts, requestTimeoutMs: opts.requestTimeoutMs ?? 2000 });
      return result?.userStatus ? server : null;
    } catch { return null; }
  };
  try {
    if (env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN) {
      const server = await probe({ address: env.ANTIGRAVITY_LS_ADDRESS, csrfToken: env.ANTIGRAVITY_CSRF_TOKEN });
      if (server) return server;
    }
    const processes = await stdout('ps -axo pid=,args=');
    for (const line of processes.split('\n')) {
      if (!line.includes('Antigravity.app/Contents/Resources/bin/language_server')) continue;
      const pid = line.match(/^\s*(\d+)\s/)?.[1];
      if (!pid) continue;
      try {
        const args = await stdout(`ps -o args= -p ${pid}`);
        const token = args.match(/(?:^|\s)--csrf_token(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
        const csrfToken = env.ANTIGRAVITY_CSRF_TOKEN || token?.slice(1).find(Boolean);
        if (!csrfToken) continue;
        const ports = env.ANTIGRAVITY_LS_ADDRESS ? [] : [...(await stdout(`lsof -nP -a -p ${pid} -iTCP -sTCP:LISTEN`)).matchAll(/TCP\s+\S+:(\d+)\s+\(LISTEN\)/g)].map(match => match[1]);
        const addresses = env.ANTIGRAVITY_LS_ADDRESS ? [env.ANTIGRAVITY_LS_ADDRESS] : [...new Set(ports)].map(port => `127.0.0.1:${port}`);
        for (const address of addresses) {
          const server = await probe({ address, csrfToken });
          if (server) return server;
        }
      } catch { /* A process may exit while discovery is in progress. */ }
    }
  } catch { /* Keep process output and credentials out of errors. */ }
  throw new Error('Antigravity must be running to connect to its language server');
}

export async function listModels(server, opts = {}) {
  const result = await rpc(server, 'GetUserStatus', {}, opts);
  const config = result.userStatus?.cascadeModelConfigData ?? {};
  const models = (config.clientModelConfigs ?? []).map(item => {
    const label = item.label ?? '';
    const family = label.toLowerCase().match(/hydrogen|argon|flash|opus|sonnet|gpt-oss/)?.[0] ?? 'other';
    const level = label.toLowerCase().match(/\b(xhigh|high|medium|low)\b/)?.[1] ?? null;
    const remaining = typeof item.quotaInfo?.remainingFraction === 'number' ? item.quotaInfo.remainingFraction : null;
    return { label, family, level, model: item.modelOrAlias?.model, remaining, available: !item.disabled && remaining !== 0 };
  });
  return { models, defaultModel: config.defaultOverrideModelConfig?.modelOrAlias?.model ?? null };
}

export function resolveModel(models, wish) {
  const choose = (family, level) => {
    const entries = models.filter(entry => entry.family === family);
    return level ? entries.find(entry => entry.level === level) :
      entries.find(entry => entry.level === 'medium') ?? entries.find(entry => entry.level === 'high') ?? entries[0];
  };
  let requested;
  if (wish == null || /^auto$/i.test(wish.trim())) requested = choose('hydrogen', 'medium');
  else {
    requested = models.find(entry => entry.model === wish || entry.label.toLowerCase() === wish.toLowerCase());
    if (!requested) {
      const alias = wish.toLowerCase().trim().match(/^(hydrogen|argon|flash|opus|sonnet|gpt-oss)(?:[-\s]+(xhigh|high|medium|low))?$/);
      if (alias) requested = choose(alias[1], alias[2]);
    }
  }
  if (!requested) throw new Error('Requested Antigravity model was not found');
  if (requested.available) return { entry: requested, fallbackFrom: null };
  const candidates = requested.family === 'opus' ? [choose('sonnet'), choose('hydrogen', 'high')] :
    requested.family === 'sonnet' ? [choose('hydrogen', 'medium')] :
      requested.family === 'argon' ? [choose('hydrogen')] : [];
  const entry = candidates.find(candidate => candidate?.available) ??
    models.find(candidate => candidate.family === 'hydrogen' && candidate.available) ?? models.find(candidate => candidate.available);
  if (!entry) throw new Error('No Antigravity models are available');
  return { entry, fallbackFrom: requested.label };
}

export async function startConversation(server, { cwd }, opts = {}) {
  const result = await rpc(server, 'StartCascade', {
    source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT', workspaceUris: [pathToFileURL(resolve(cwd)).href],
  }, opts);
  return result.cascadeId;
}

export async function sendMessage(server, { cascadeId, text, model }, opts = {}) {
  return rpc(server, 'SendUserCascadeMessage', {
    cascadeId, items: [{ text }],
    cascadeConfig: { plannerConfig: { conversational: {}, requestedModel: { model } } },
  }, opts);
}

export async function getTrajectory(server, cascadeId, opts = {}) {
  return rpc(server, 'GetCascadeTrajectory', { cascadeId }, opts);
}

export async function waitForCompletion(server, cascadeId, { pollMs = 1500, timeoutMs = 30 * 60_000, onStep, signal, minSteps = 0 } = {}, opts = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let seen = 0;
  try {
    while (!controller.signal.aborted) {
      const response = await getTrajectory(server, cascadeId, { ...opts, signal: controller.signal });
      const steps = response.trajectory?.steps ?? [];
      for (; seen < steps.length; seen++) await onStep?.(steps[seen], seen);
      const last = steps.at(-1);
      if (controller.signal.aborted) break;
      // minSteps: steps that existed before this message; the new turn adds at least a user input and a reply.
      if (steps.length >= minSteps + 2 && response.status === 'CASCADE_RUN_STATUS_IDLE' && last?.type === PLANNER && last.status === DONE) return response;
      await delay(pollMs, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  throw new Error(signal?.aborted ? 'Antigravity completion aborted' : 'Antigravity completion timed out');
}

const numberOrNull = value => value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const assistantText = step => step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || '';

export function summarizeTrajectory(response) {
  const steps = response.trajectory?.steps ?? [];
  const summary = { finalText: '', thinking: [], fileChanges: [], commands: [], errors: [], model: null, steps: steps.length };
  for (const metadata of response.trajectory?.generatorMetadata ?? []) {
    if (metadata.chatModel?.model) summary.model = metadata.chatModel.model;
  }
  for (const step of steps) {
    if (step.error) summary.errors.push(typeof step.error === 'string' ? step.error : step.error.message ?? JSON.stringify(step.error));
    if (step.metadata?.modelUsage?.model) summary.model = step.metadata.modelUsage.model;
    if (step.type === PLANNER) {
      if (assistantText(step)) summary.finalText = assistantText(step);
      if (step.plannerResponse?.thinking) summary.thinking.push(step.plannerResponse.thinking);
    }
    if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION') {
      const action = step.codeAction;
      const edit = action?.actionResult?.edit;
      if (edit?.absoluteUri) {
        let path = edit.absoluteUri;
        try { path = fileURLToPath(path); } catch { /* Retain unknown URI formats. */ }
        summary.fileChanges.push({ path, additions: numberOrNull(action.diffStats?.additions) ?? 0, deletions: numberOrNull(action.diffStats?.deletions) ?? 0, created: Boolean(edit.createFile || action.actionSpec?.createFile) });
      }
    }
    if (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && step.runCommand) {
      const command = step.runCommand;
      summary.commands.push({ command: command.commandLine ?? '', exitCode: numberOrNull(command.exitCode), output: (command.combinedOutput?.full ?? '').slice(-2000) });
    }
  }
  return summary;
}

export function describeStep(step) {
  if (step.type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && step.runCommand) {
    const command = step.runCommand;
    return step.status === DONE ? `Command completed: ${command.commandLine} (exit ${numberOrNull(command.exitCode) ?? 'unknown'})` : `Running command: ${command.commandLine}`;
  }
  if (step.type === 'CORTEX_STEP_TYPE_CODE_ACTION') return 'Applying 1 file change(s).';
  if (step.type === PLANNER && assistantText(step)) return `Assistant message captured: ${assistantText(step).slice(0, 200)}`;
  return null;
}
