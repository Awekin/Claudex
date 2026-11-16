import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  discoverServer, rpc, listModels, resolveModel, startConversation, sendMessage,
  getTrajectory, waitForCompletion, summarizeTrajectory, describeStep,
} from '../plugins/antigravity/scripts/lib/antigravity-client.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/antigravity-trajectory.json', import.meta.url), 'utf8'));
const server = { address: '127.0.0.1:1234', csrfToken: 'test-secret' };
const json = value => ({ ok: true, json: async () => value });
const entry = (family, level, remaining = 1) => ({ label: `${family} ${level}`, family, level, model: `MODEL_${family}_${level}`, remaining, available: remaining !== 0 });
const models = [entry('hydrogen', 'high'), entry('hydrogen', 'medium'), entry('hydrogen', 'xhigh'), entry('sonnet', 'low'), entry('sonnet', 'medium'), entry('opus', 'high'), entry('flash', 'low'), entry('argon', 'medium')];

test('resolveModel supports aliases, levels, ids, labels, and auto', () => {
  for (const [wish, expected] of [
    ['hydrogen', models[1]], ['hydrogen-high', models[0]], ['Hydrogen XHigh', models[2]],
    ['opus', models[5]], ['sonnet-low', models[3]], ['flash', models[6]],
    [models[2].model, models[2]], [models[3].label, models[3]], [null, models[1]], ['auto', models[1]],
  ]) assert.deepEqual(resolveModel(models, wish), { entry: expected, fallbackFrom: null });
  assert.equal(resolveModel([models[0], models[2]], 'hydrogen').entry, models[0]);
  assert.throws(() => resolveModel(models, 'missing'), /not found/);
});

test('resolveModel follows availability fallback chains', () => {
  const unavailable = indexes => models.map((model, index) => indexes.includes(index) ? { ...model, remaining: 0, available: false } : model);
  assert.deepEqual(resolveModel(unavailable([5]), 'opus'), { entry: models[4], fallbackFrom: models[5].label });
  assert.equal(resolveModel(unavailable([5, 4]), 'opus').entry.model, models[0].model);
  assert.equal(resolveModel(unavailable([4]), 'sonnet').entry.model, models[1].model);
  assert.equal(resolveModel(unavailable([7]), 'argon').entry.model, models[1].model);
  assert.equal(resolveModel(unavailable([6]), 'flash').entry.model, models[0].model);
  assert.equal(resolveModel(unavailable([0, 1, 2, 6]), 'flash').entry.model, models[3].model);
  assert.throws(() => resolveModel(unavailable(models.map((_, index) => index)), 'auto'), /No Antigravity models/);
});

test('summarizeTrajectory extracts the real finished conversation', () => {
  const summary = summarizeTrajectory(fixture);
  assert.match(summary.finalText, /^Created/);
  assert.deepEqual(summary.fileChanges, [{ path: '/tmp/ag-probe/hello.txt', additions: 2, deletions: 0, created: true }]);
  assert.equal(summary.commands.length, 1);
  assert.equal(summary.commands[0].command, 'ls -la');
  assert.equal(summary.commands[0].exitCode, 0);
  assert.match(summary.commands[0].output, /hello.txt/);
  assert.equal(summary.thinking.length, 1);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.model, 'MODEL_PLACEHOLDER_M527');
  assert.equal(summary.steps, 6);
});

test('summary handles string numbers, errors, URI decoding, unknown steps, and output limits', () => {
  const summary = summarizeTrajectory({ trajectory: { steps: [
    { type: 'FUTURE_STEP', error: { message: 'failed' } },
    { type: 'CORTEX_STEP_TYPE_CODE_ACTION', codeAction: { actionResult: { edit: { absoluteUri: 'file:///tmp/hello%20world.txt', createFile: true } }, diffStats: { additions: '3', deletions: '2' } } },
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: { commandLine: 'pwd', exitCode: '0', combinedOutput: { full: 'x'.repeat(2001) } } },
    { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', runCommand: {} },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'original', modifiedResponse: 'edited' } },
  ] } });
  assert.equal(summary.finalText, 'edited');
  assert.deepEqual(summary.errors, ['failed']);
  assert.deepEqual(summary.fileChanges[0], { path: '/tmp/hello world.txt', created: true, additions: 3, deletions: 2 });
  assert.equal(summary.commands[0].output.length, 2000);
  assert.equal(summary.commands[0].exitCode, 0);
  assert.equal(summary.commands[1].exitCode, null);
  assert.equal(summarizeTrajectory({}).steps, 0);
});

for (const tokenArg of ['--csrf_token test-secret', '--csrf_token=test-secret']) {
  test(`discoverServer parses ${tokenArg.split('test-secret')[0]} and probes ports`, async () => {
    const commands = [];
    const probes = [];
    const result = await discoverServer({ env: {}, exec: async command => {
      commands.push(command);
      if (command === 'ps -axo pid=,args=') return { stdout: ' 41 other-server\n 42 /Applications/Antigravity.app/Contents/Resources/bin/language_server\n' };
      if (command === 'ps -o args= -p 42') return { stdout: `/Applications/Antigravity.app/Contents/Resources/bin/language_server ${tokenArg}` };
      if (command === 'lsof -nP -a -p 42 -iTCP -sTCP:LISTEN') return { stdout: 'server 42 user 1u IPv4 TCP 127.0.0.1:8001 (LISTEN)\nserver 42 user 2u IPv6 TCP [::1]:8002 (LISTEN)\nserver 42 user 3u IPv4 TCP *:8003 (LISTEN)' };
      throw new Error('Unexpected command');
    }, fetch: async (url, init) => {
      probes.push(url);
      assert.equal(init.headers['x-codeium-csrf-token'], 'test-secret');
      if (url.includes(':8001/')) throw new Error('HTTPS only');
      if (url.includes(':8002/')) return json({ unrelated: true });
      return json({ userStatus: {} });
    } });
    assert.deepEqual(result, { address: '127.0.0.1:8003', csrfToken: 'test-secret' });
    assert.equal(probes.length, 3);
    assert.equal(commands.length, 3);
  });
}

test('discovery honors environment overrides without process discovery', async () => {
  const result = await discoverServer({ env: { ANTIGRAVITY_LS_ADDRESS: server.address, ANTIGRAVITY_CSRF_TOKEN: server.csrfToken }, exec: () => assert.fail('unexpected exec'), fetch: async () => json({ userStatus: {} }) });
  assert.deepEqual(result, server);
});

test('discovery and RPC errors never reveal credentials', async () => {
  await assert.rejects(discoverServer({ env: {}, exec: async () => { throw new Error(server.csrfToken); } }), /Antigravity must be running/);
  for (const fetch of [async () => { throw new Error(server.csrfToken); }, async () => ({ ok: false }), async () => ({ json: async () => { throw new Error(server.csrfToken); } })]) {
    await assert.rejects(rpc(server, 'GetUserStatus', {}, { fetch }), error => !error.message.includes(server.csrfToken) && /RPC failed/.test(error.message));
  }
});

test('listModels normalizes labels, quota, disabled flags and default', async () => {
  const result = await listModels(server, { fetch: async () => json({ userStatus: { cascadeModelConfigData: {
    clientModelConfigs: [
      { label: 'Gemini 4 Hydrogen (High)', modelOrAlias: { model: 'MODEL_A' }, quotaInfo: { remainingFraction: 0 } },
      { label: 'GPT-OSS 120B (Medium)', modelOrAlias: { model: 'MODEL_B' }, disabled: true },
      { label: 'New Model', modelOrAlias: { model: 'MODEL_C' } },
    ], defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_C' } },
  } } }) });
  assert.deepEqual(result, { models: [
    { label: 'Gemini 4 Hydrogen (High)', family: 'hydrogen', level: 'high', model: 'MODEL_A', remaining: 0, available: false },
    { label: 'GPT-OSS 120B (Medium)', family: 'gpt-oss', level: 'medium', model: 'MODEL_B', remaining: null, available: false },
    { label: 'New Model', family: 'other', level: null, model: 'MODEL_C', remaining: null, available: true },
  ], defaultModel: 'MODEL_C' });
});

test('conversation methods send Connect JSON with encoded workspace URIs', async () => {
  const calls = [];
  const opts = { fetch: async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    return json(url.endsWith('/StartCascade') ? { cascadeId: 'cascade' } : {});
  } };
  assert.equal(await startConversation(server, { cwd: '/tmp/project with space/#tag' }, opts), 'cascade');
  await sendMessage(server, { cascadeId: 'cascade', text: 'Hello', model: 'MODEL_A' }, opts);
  await getTrajectory(server, 'cascade', opts);
  assert.equal(calls[0].url, `http://${server.address}/exa.language_server_pb.LanguageServerService/StartCascade`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(calls[0].body, { source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT', workspaceUris: ['file:///tmp/project%20with%20space/%23tag'] });
  assert.deepEqual(calls[1].body, { cascadeId: 'cascade', items: [{ text: 'Hello' }], cascadeConfig: { plannerConfig: { conversational: {}, requestedModel: { model: 'MODEL_A' } } } });
  assert.deepEqual(calls[2].body, { cascadeId: 'cascade' });
});

test('polling waits for an idle, completed final planner and reports each index once', async () => {
  const responses = [
    { ...fixture, trajectory: { steps: fixture.trajectory.steps.slice(0, 2) }, status: 'RUNNING' },
    { ...fixture, trajectory: { steps: fixture.trajectory.steps.slice(0, 5) } },
    { ...fixture, trajectory: { steps: [...fixture.trajectory.steps.slice(0, 5), { ...fixture.trajectory.steps[5], status: 'RUNNING' }] } }, fixture,
  ];
  const seen = [];
  const result = await waitForCompletion(server, 'cascade', { pollMs: 1, onStep: (_, index) => seen.push(index) }, { fetch: async () => json(responses.shift()) });
  assert.equal(result, fixture);
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5]);
});

test('polling supports pre-abort, in-flight abort, and timeout', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForCompletion(server, 'cascade', { signal: controller.signal }, { fetch: () => assert.fail('unexpected fetch') }), /aborted/);
  const pendingFetch = async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  await assert.rejects(waitForCompletion(server, 'cascade', { timeoutMs: 10 }, { fetch: pendingFetch }), /timed out/);
  const activeController = new AbortController();
  const pending = waitForCompletion(server, 'cascade', { signal: activeController.signal }, { fetch: pendingFetch });
  activeController.abort();
  await assert.rejects(pending, /aborted/);
});

test('describeStep uses the exact progress prefixes and ignores unknown steps', () => {
  assert.equal(describeStep(fixture.trajectory.steps[4]), 'Command completed: ls -la (exit 0)');
  assert.equal(describeStep({ ...fixture.trajectory.steps[4], status: 'RUNNING' }), 'Running command: ls -la');
  assert.equal(describeStep(fixture.trajectory.steps[2]), 'Applying 1 file change(s).');
  assert.equal(describeStep(fixture.trajectory.steps[5]), `Assistant message captured: ${fixture.trajectory.steps[5].plannerResponse.modifiedResponse.slice(0, 200)}`);
  assert.equal(describeStep(fixture.trajectory.steps[1]), null);
  assert.equal(describeStep({ type: 'UNKNOWN' }), null);
});
