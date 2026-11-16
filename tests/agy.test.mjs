import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  resolveAgyBinary, parseModels, listModels, buildArgs, createStreamParser,
  createRunState, applyEvent, describeEvent, runAgy, isQuotaError,
} from '../plugins/antigravity/scripts/lib/agy.mjs';

const stream = await readFile(new URL('./fixtures/agy-stream.ndjson', import.meta.url), 'utf8');
const modelsText = await readFile(new URL('./fixtures/agy-models.txt', import.meta.url), 'utf8');
const events = stream.trim().split('\n').map(line => JSON.parse(line));
const conversationId = '5aacb202-4052-48f3-8e04-cdd4667c7206';
const stepEvent = update => ({ event: 'step_update', step_update: update });
const tool = (index, name, state = 'DONE', parameters = {}, output) => stepEvent({
  step_index: index, step_type: 'tool', state, tool_name: name,
  tool_info: { name, parameters, output },
});
const replay = chunks => {
  const state = createRunState();
  const parser = createStreamParser(event => applyEvent(state, event));
  chunks.forEach(chunk => parser.push(chunk));
  parser.end();
  return state;
};

test('binary resolution prefers the override, then PATH, then the home fallback', () => {
  assert.equal(resolveAgyBinary({ env: { ANTIGRAVITY_AGY_BIN: '/custom/agy' }, exists: () => assert.fail('override should be used directly') }), '/custom/agy');
  const env = { PATH: '/first:/second', HOME: '/home/test' };
  assert.equal(resolveAgyBinary({ env, exists: path => ['/second/agy', '/home/test/.local/bin/agy'].includes(path) }), '/second/agy');
  assert.equal(resolveAgyBinary({ env, exists: path => path === '/home/test/.local/bin/agy' }), '/home/test/.local/bin/agy');
  assert.equal(resolveAgyBinary({ env, exists: () => false }), null);
});

test('parseModels parses all 18 real models, families, labels, and levels', () => {
  const models = parseModels(`Fetching available models...\r\n${modelsText}`);
  assert.equal(models.length, 18);
  for (const [family, count] of Object.entries({ hydrogen: 4, argon: 3, flash: 3, opus: 3, sonnet: 3, 'gpt-oss': 1, orchestrator: 1 })) {
    assert.equal(models.filter(model => model.family === family).length, count, family);
  }
  assert.deepEqual(models.find(model => model.model === 'gemini-4-hydrogen-xhigh'), {
    model: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)', family: 'hydrogen', level: 'xhigh',
  });
  for (const family of ['opus', 'sonnet']) {
    assert.deepEqual(models.filter(model => model.family === family).map(model => model.level), ['low', 'medium', 'high']);
  }
  assert.equal(models.find(model => model.family === 'orchestrator').level, null);
  assert.deepEqual(parseModels('progress\nnew-slug\tNew Model\n\t\n'), [{ model: 'new-slug', label: 'New Model', family: 'other', level: null }]);
  assert.equal(parseModels('alias\tClaude Sonnet (High)')[0].family, 'sonnet');
});

test('listModels executes agy models and accepts exec stdout or a string', async () => {
  for (const result of [{ stdout: modelsText }, modelsText]) {
    assert.deepEqual(await listModels({ exec: async command => {
      assert.equal(command, 'agy models');
      return result;
    } }), parseModels(modelsText));
  }
  await assert.rejects(listModels({ exec: async () => { throw new Error('missing CLI'); } }), /missing CLI/);
});

test('buildArgs uses the verified headless flags, both permission modes, and optional timeout', () => {
  const base = ['-p', 'Fix "calc"; $(false)', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash-low'];
  assert.deepEqual(buildArgs({ prompt: base[1], model: base.at(-1) }), [...base, '--dangerously-skip-permissions']);
  assert.deepEqual(buildArgs({ prompt: base[1], model: base.at(-1), conversationId, readOnly: true, timeout: '30m' }), [
    ...base, '--conversation', conversationId, '--mode', 'plan', '--print-timeout', '30m',
  ]);
  assert.deepEqual(buildArgs({ prompt: 'Hello' }), ['-p', 'Hello', '--output-format', 'stream-json', '--dangerously-skip-permissions']);
});

test('the real stream produces final text, unique file changes, commands, and result metadata', () => {
  const state = replay([stream]);
  assert.equal(state.conversationId, conversationId);
  assert.equal(state.model, 'gemini-3.8-flash-low');
  assert.equal(Object.keys(state.steps).length, 14);
  assert.equal(state.finalText, events.at(-1).result.response);
  assert.ok(state.finalText.length > 0);
  assert.deepEqual(state.fileChanges, [
    { path: '/tmp/agy-s/calc.py', created: false },
    { path: '/tmp/agy-s/notes.txt', created: true },
  ]);
  assert.deepEqual(state.commands.map(command => command.exitCode), [0, 0, 1]);
  assert.deepEqual(state.commands.map(command => command.command), ['ls -la', "python3 -c 'import calc; print(calc.add(2,3))'", 'false']);
  assert.match(state.commands[0].output, /calc.py/);
  assert.equal(state.commands[1].output, '5\r\n');
  assert.equal(state.commands[2].output, '');
  assert.equal(state.status, 'SUCCESS');
  assert.equal(state.durationSeconds, 30.820404);
  assert.deepEqual(state.usage, events.at(-1).result.usage);
  assert.equal(state.error, null);
});

test('stream parser handles arbitrary chunks, UTF-8 byte splits, noise, CRLF, and an unterminated final line', () => {
  const expected = replay([stream]);
  const bytes = Buffer.from(stream);
  for (const size of [1, 7, 127, 1024]) {
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.subarray(offset, offset + size));
    assert.deepEqual(replay(chunks), expected);
  }
  const seen = [];
  const parser = createStreamParser(event => seen.push(event));
  const input = Buffer.from('Fetching...\r\n{broken}\nnull\n[]\n42\n{"text":"Zażółć 🐈"}\r\n{"event":"last"}');
  for (const byte of input) parser.push(Buffer.from([byte]));
  parser.end();
  parser.end();
  parser.push('{"ignored":true}\n');
  assert.deepEqual(seen, [{ text: 'Zażółć 🐈' }, { event: 'last' }]);
});

test('state accumulates per-step text and usage, and final result takes precedence', () => {
  const state = createRunState();
  for (const update of [
    { step_index: 2, text_delta: 'Earlier', usage: { input_tokens: 2 } },
    { step_index: 5, text_delta: 'Hello ' },
    { step_index: 5, text_delta: 'world', state: 'DONE', usage: { input_tokens: 3, output_tokens: 4 } },
  ]) applyEvent(state, stepEvent({ step_type: 'agent_response', ...update }));
  assert.equal(state.steps[5].text, 'Hello world');
  assert.equal(state.finalText, 'Hello world');
  assert.deepEqual(state.usage, { input_tokens: 5, output_tokens: 4 });
  applyEvent(state, stepEvent({ step_index: 5, state: 'DONE' }));
  assert.deepEqual(state.usage, { input_tokens: 5, output_tokens: 4 });
  applyEvent(state, { event: 'result', result: { response: 'Final', status: 'FAILED', error: { message: 'quota' }, usage: { input_tokens: 7 } } });
  applyEvent(state, stepEvent({ step_index: 2, step_type: 'agent_response', text_delta: ' late' }));
  assert.equal(state.finalText, 'Final');
  assert.equal(state.status, 'FAILED');
  assert.deepEqual(state.error, { message: 'quota' });
  assert.deepEqual(state.usage, { input_tokens: 7 });
});

test('state merges partial tool updates, deduplicates steps and paths, and bounds command output', () => {
  const state = createRunState();
  const active = tool(0, 'run_command', 'ACTIVE', { CommandLine: 'echo huge' });
  applyEvent(state, active);
  const done = stepEvent({ step_index: 0, state: 'DONE', tool_info: { output: `Command exited with code 12.\nCommand output:\n${'x'.repeat(2100)}END` } });
  applyEvent(state, done);
  applyEvent(state, done);
  assert.deepEqual(state.commands, [{ command: 'echo huge', exitCode: 12, output: `${'x'.repeat(1997)}END` }]);
  applyEvent(state, tool(1, 'run_command', 'DONE', { CommandLine: 'unknown' }));
  assert.equal(state.commands[1].exitCode, null);
  for (const event of [tool(2, 'write_file', 'DONE', { Path: '/new' }), tool(3, 'edit_file', 'DONE', { Path: '/new' }), tool(4, 'edit_file', 'ACTIVE', { Path: '/pending' })]) applyEvent(state, event);
  assert.deepEqual(state.fileChanges, [{ path: '/new', created: true }]);
  assert.equal(applyEvent(state, { event: 'future' }), state);
});

test('describeEvent emits the exact panel prefixes and uses accumulated assistant text', () => {
  const state = createRunState();
  const logs = [];
  for (const event of events) {
    applyEvent(state, event);
    const line = describeEvent(event, state);
    if (line) logs.push(line);
  }
  assert.ok(logs.includes('Running command: ls -la'));
  assert.ok(logs.includes('Command completed: ls -la (exit 0)'));
  assert.ok(logs.includes('Command completed: false (exit 1)'));
  assert.equal(logs.filter(line => line === 'Applying 1 file change(s).').length, 2);
  assert.ok(logs.includes('Running tool: read_file.'));
  assert.ok(logs.includes(`Assistant message captured: ${state.steps[13].text.slice(0, 200)}`));
  assert.equal(describeEvent(tool(99, 'run_command', 'DONE', { CommandLine: 'pwd' })), 'Command completed: pwd (exit ?)');
  assert.equal(describeEvent(tool(99, 'future_tool', 'ACTIVE')), 'Running tool: future_tool.');
  assert.equal(describeEvent(tool(99, 'read_file')), null);
  assert.equal(describeEvent({ event: 'init' }), null);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit('exit', null, 'SIGTERM'); return true; };
  return child;
}

test('runAgy spawns with null stdin and project cwd, streams the fixture, and retains stderr tail', async () => {
  const child = fakeChild();
  const seen = [];
  const pending = runAgy({
    cwd: '/project', prompt: 'Fix calc', model: 'gemini-3.8-flash-low', conversationId, readOnly: true,
    bin: '/custom/agy', timeoutMs: 1000,
    onEvent: (event, state) => {
      assert.equal(state.conversationId, conversationId);
      if (event.event === 'result') assert.equal(state.finalText, event.result.response);
      seen.push(event);
    },
    spawn: (bin, args, options) => {
      assert.equal(bin, '/custom/agy');
      assert.deepEqual(args, buildArgs({ prompt: 'Fix calc', model: 'gemini-3.8-flash-low', conversationId, readOnly: true }));
      assert.deepEqual(options, { cwd: '/project', stdio: ['ignore', 'pipe', 'pipe'] });
      return child;
    },
  });
  for (let offset = 0; offset < stream.length; offset += 113) child.stdout.write(stream.slice(offset, offset + 113));
  child.stderr.write('discard' + 'e'.repeat(3996));
  child.stderr.write('TAIL');
  child.emit('exit', 0);
  child.emit('close', 0);
  const state = await pending;
  assert.deepEqual(seen, events);
  assert.equal(state.exitCode, 0);
  assert.equal(state.stderr, 'e'.repeat(3996) + 'TAIL');
  assert.deepEqual(state.fileChanges, replay([stream]).fileChanges);
  assert.deepEqual(state.commands.map(command => command.exitCode), [0, 0, 1]);
});

test('runAgy resolves nonzero exits and kills on timeout; spawn failures reject', async () => {
  const failed = fakeChild();
  const pending = runAgy({ bin: 'agy', prompt: 'x', spawn: () => failed });
  failed.stderr.write('RESOURCE_EXHAUSTED');
  failed.emit('exit', 1);
  const state = await pending;
  assert.equal(state.exitCode, 1);
  assert.equal(isQuotaError(state), true);
  const timed = fakeChild();
  let killed = false;
  timed.kill = () => { killed = true; timed.emit('exit', null); return true; };
  const timeout = await runAgy({ bin: 'agy', prompt: 'x', timeoutMs: 5, spawn: () => timed });
  assert.equal(killed, true);
  assert.equal(timeout.status, 'TIMEOUT');
  assert.match(timeout.error, /timed out/);
  assert.equal(timeout.exitCode, null);
  await assert.rejects(runAgy({ bin: 'agy', spawn: () => { throw new Error('spawn failed'); } }), /spawn failed/);
  const missing = fakeChild();
  const missingRun = runAgy({ bin: 'agy', spawn: () => missing });
  missing.emit('error', new Error('ENOENT'));
  await assert.rejects(missingRun, /ENOENT/);
  const running = fakeChild();
  const runningRun = runAgy({ bin: 'agy', spawn: () => running });
  running.emit('spawn');
  running.emit('error', new Error('kill failed'));
  running.emit('exit', 1);
  assert.equal((await runningRun).error, 'kill failed');
});

test('quota detection covers status, structured errors, stderr, and all supported phrases', () => {
  for (const value of ['quota exceeded', 'RESOURCE_EXHAUSTED', 'Rate limit', 'HTTP 429', 'exhausted']) {
    for (const field of ['status', 'error', 'stderr']) assert.equal(isQuotaError({ [field]: value }), true);
  }
  assert.equal(isQuotaError({ error: { message: 'quota exceeded' } }), true);
  assert.equal(isQuotaError({ status: 'SUCCESS', stderr: '' }), false);
  assert.equal(isQuotaError({}), false);
});
