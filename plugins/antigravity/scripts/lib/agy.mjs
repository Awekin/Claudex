import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { exec as execCallback, spawn as spawnDefault } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';

const execDefault = promisify(execCallback);

export function resolveAgyBinary({ env = process.env, exists = existsSync } = {}) {
  if (env.ANTIGRAVITY_AGY_BIN) return env.ANTIGRAVITY_AGY_BIN;
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(directory, 'agy');
    if (exists(candidate)) return candidate;
  }
  const fallback = join(env.HOME || homedir(), '.local', 'bin', 'agy');
  return exists(fallback) ? fallback : null;
}

export function parseModels(stdout) {
  return String(stdout).split(/\r?\n/).flatMap(line => {
    const tab = line.indexOf('\t');
    if (tab < 0) return [];
    const model = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!model || !label) return [];
    const description = `${model} ${label}`.toLowerCase();
    // Orchestrator labels can also mention Argon.
    const family = /\borchestrator\b/.test(description) ? 'orchestrator' :
      description.match(/\b(hydrogen|argon|flash|opus|sonnet|gpt-oss)\b/)?.[1] ?? 'other';
    const level = description.match(/\b(xhigh|high|medium|low)\b/)?.[1] ?? null;
    return [{ model, label, family, level }];
  });
}

export async function listModels({ exec = execDefault } = {}) {
  const result = await exec('agy models');
  return parseModels(typeof result === 'string' ? result : result.stdout);
}

export function buildArgs({ prompt, model, conversationId, readOnly = false, timeout } = {}) {
  const args = ['-p', prompt, '--output-format', 'stream-json'];
  if (model) args.push('--model', model);
  if (conversationId) args.push('--conversation', conversationId);
  args.push(...(readOnly ? ['--mode', 'plan'] : ['--dangerously-skip-permissions']));
  if (timeout != null) args.push('--print-timeout', String(timeout));
  return args;
}

export function createStreamParser(onEvent) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let ended = false;
  const line = value => {
    let event;
    try { event = JSON.parse(value); } catch { return; }
    if (event && typeof event === 'object' && !Array.isArray(event)) onEvent(event);
  };
  const consume = text => {
    pending += text;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      line(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  };
  return {
    push(chunk) {
      if (!ended) consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    },
    end() {
      if (ended) return;
      ended = true;
      consume(decoder.end());
      if (pending.trim()) line(pending);
      pending = '';
    },
  };
}

export function createRunState() {
  return {
    conversationId: null, model: null, steps: {}, finalText: '', fileChanges: [],
    commands: [], usage: null, status: null, error: null, durationSeconds: null,
    stderr: '', exitCode: null, result: null,
  };
}

function commandResult(step) {
  const output = String(step.tool_info?.output ?? '');
  const code = output.match(/exited with code\s+(-?\d+)/i);
  const marker = output.indexOf('Command output:');
  return {
    command: step.tool_info?.parameters?.CommandLine ?? '',
    exitCode: code ? Number(code[1]) : null,
    output: marker < 0 ? '' : output.slice(marker + 'Command output:'.length).replace(/^\r?\n/, '').slice(-2000),
  };
}

export function applyEvent(state, event) {
  if (!event || typeof event !== 'object') return state;
  const update = event.step_update;
  state.conversationId = event.conversation_id ?? update?.conversation_id ?? event.result?.conversation_id ?? state.conversationId;
  if (event.event === 'init') state.model = event.init?.model ?? state.model;
  if (event.event === 'result' && event.result) {
    state.result = event.result;
    state.status = event.result.status ?? null;
    state.error = event.result.error ?? null;
    state.durationSeconds = event.result.duration_seconds ?? null;
  }
  if (event.event === 'step_update' && update && Number.isInteger(update.step_index)) {
    const previous = state.steps[update.step_index] ?? {};
    state.steps[update.step_index] = {
      ...previous, ...update,
      tool_info: update.tool_info ? {
        ...previous.tool_info, ...update.tool_info,
        parameters: { ...previous.tool_info?.parameters, ...update.tool_info.parameters },
      } : previous.tool_info,
      text: (previous.text ?? '') + (update.text_delta ?? ''),
    };
  }
  const steps = Object.values(state.steps).sort((a, b) => a.step_index - b.step_index);
  state.finalText = state.result?.response ?? steps.filter(step => step.step_type === 'agent_response').at(-1)?.text ?? '';
  const changes = new Map();
  state.commands = [];
  let usage = null;
  for (const step of steps) {
    if (step.usage) {
      usage ??= {};
      for (const [key, value] of Object.entries(step.usage)) {
        if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
      }
    }
    if (step.step_type !== 'tool' || step.state !== 'DONE') continue;
    const name = step.tool_name ?? step.tool_info?.name;
    if (name === 'run_command') state.commands.push(commandResult(step));
    const path = step.tool_info?.parameters?.Path;
    if (path && (name === 'edit_file' || name === 'write_file')) {
      changes.set(path, { path, created: changes.get(path)?.created || name === 'write_file' });
    }
  }
  state.fileChanges = [...changes.values()];
  state.usage = state.result?.usage ?? usage;
  return state;
}

export function describeEvent(event, state) {
  if (event?.event !== 'step_update' || !event.step_update) return null;
  const update = event.step_update;
  const step = state?.steps[update.step_index] ?? update;
  if (step.step_type === 'agent_response' && update.state === 'DONE') {
    const text = step.text ?? step.text_delta ?? '';
    return text ? `Assistant message captured: ${text.slice(0, 200)}` : null;
  }
  if (step.step_type !== 'tool') return null;
  const name = step.tool_name ?? step.tool_info?.name;
  if (name === 'run_command') {
    const command = commandResult(step);
    if (update.state === 'ACTIVE') return `Running command: ${command.command}`;
    if (update.state === 'DONE') return `Command completed: ${command.command} (exit ${command.exitCode ?? '?'})`;
  } else if (update.state === 'DONE' && (name === 'edit_file' || name === 'write_file')) {
    return 'Applying 1 file change(s).';
  } else if (update.state === 'ACTIVE' && name) {
    return `Running tool: ${name}.`;
  }
  return null;
}

export function runAgy({ cwd, prompt, model, conversationId, readOnly, timeoutMs, onEvent, spawn = spawnDefault, bin = resolveAgyBinary() } = {}) {
  return new Promise((resolve, reject) => {
    const state = createRunState();
    state.conversationId = conversationId ?? null;
    state.model = model ?? null;
    if (!bin) { reject(new Error('Antigravity CLI agy was not found')); return; }
    let child;
    try {
      child = spawn(bin, buildArgs({ prompt, model, conversationId, readOnly }), {
        cwd, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { reject(error); return; }
    let timer;
    let settled = false;
    let spawned = false;
    child.once('spawn', () => { spawned = true; });
    const parser = createStreamParser(event => {
      applyEvent(state, event);
      try { onEvent?.(event, state); } catch (error) { state.error = error.message; }
    });
    const stderrDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', chunk => parser.push(chunk));
    child.stderr?.on('data', chunk => {
      state.stderr = (state.stderr + (typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk))).slice(-4000);
    });
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parser.end();
      state.stderr = (state.stderr + stderrDecoder.end()).slice(-4000);
      state.exitCode = code;
      resolve(state);
    };
    child.once('error', error => {
      if (settled) return;
      if (spawned) {
        state.error = error.message;
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', finish);
    child.once('close', finish);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        state.status = 'TIMEOUT';
        state.error = 'Antigravity CLI timed out';
        child.kill();
      }, timeoutMs);
    }
  });
}

export function isQuotaError(state) {
  return /quota|RESOURCE_EXHAUSTED|rate[\s_-]*limit|429|exhausted/i.test(
    [state?.status, state?.error, state?.stderr].map(value => typeof value === 'string' ? value : JSON.stringify(value) ?? '').join(' '),
  );
}
