import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'codex-panel',
  component: 'Pane',
  requestId: 'codex-panel',
  props: {
    title: 'Codex',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const DATA = '/home/u/.claude/plugins/data'
const DIR = `${DATA}/codex-claudex/state/Demo-0123456789abcdef`

const files: Record<string, string> = {
  [`${DIR}/state.json`]: JSON.stringify({
    jobs: [
      {
        id: 'task-run', kind: 'task', title: 'Codex Task', summary: 'Build the backend', status: 'running',
        phase: 'editing', write: true, workspaceRoot: '/p/Demo', updatedAt: '2026-11-14T10:05:00.000Z',
        startedAt: '2026-11-14T10:00:00.000Z', logFile: `${DIR}/jobs/task-run.log`,
      },
      {
        id: 'task-done', kind: 'task', title: 'Codex Task', summary: 'Fix login', status: 'completed',
        phase: 'done', write: false, workspaceRoot: '/p/Demo', updatedAt: '2026-11-14T09:00:00.000Z',
        startedAt: '2026-11-14T08:58:00.000Z', completedAt: '2026-11-14T09:00:00.000Z',
      },
      {
        id: 'task-old', kind: 'task', title: 'Codex Task', summary: 'Согласно [FORK.md](/x) отличия', status: 'completed',
        phase: 'done', write: false, workspaceRoot: '/p/Demo', updatedAt: '2026-11-14T08:00:00.000Z',
        startedAt: '2026-11-14T07:58:00.000Z', completedAt: '2026-11-14T08:00:00.000Z',
      },
    ],
  }),
  [`${DIR}/jobs/task-run.log`]: [
    '[2026-11-14T10:00:01.000Z] Thread ready (t1).',
    '[2026-11-14T10:00:02.000Z] Running command: /bin/zsh -lc \'npm test\'',
    '[2026-11-14T10:00:03.000Z] Command failed: /bin/zsh -lc \'npm test\' (exit 1)',
    '[2026-11-14T10:00:04.000Z] Assistant message captured: Tests fail, fixing auth.ts',
  ].join('\n'),
  [`${DIR}/jobs/task-done.log`]: '',
  [`${DIR}/jobs/task-done.json`]: JSON.stringify({ summary: 'Fix login', rendered: '✅ **Codex: готово**\n\nThe login works now.' }),
  [`${DIR}/jobs/task-old.json`]: JSON.stringify({ summary: 'Read [FORK.md](/x/FORK.md) and list **changes**' }),
}

test('the pane shows a running job with its activity and a finished answer', async ($, on) => {
  on('env.get', () => ({ value: '/home/u' }))
  on('clock.now', () => ({ value: Date.parse('2026-11-14T10:02:05.000Z') }))
  on('clock.every', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'codex-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.list', (_, e: any) => {
    const path = e.args?.[0] ?? e.path
    if (path === DATA) return { value: [{ name: 'codex-claudex', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    return { value: [{ name: 'Demo-0123456789abcdef', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
  })
  on('fs.read', (_, e: any) => {
    const path = e.args?.[0] ?? e.path
    if (path in files) return { value: files[path] }
    throw new Error('missing')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/p/Demo', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Build the backend/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 мин 5 с/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Запускает тесты · npm test — ошибка \(код 1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /изучает/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 команда · 1 ✗/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Tests fail, fixing auth\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Fix login/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Read FORK\.md and list changes$/ })).toBeDefined()
    await ui.unmount()
  }
})
