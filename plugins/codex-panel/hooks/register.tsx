import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ActivityRow, PanelJob, Snapshot } from '../types'

const PANE = 'codex-panel'
const TITLE = 'Codex'
const POLL_MS = 2000
const MAX_JOBS = 10
const MAX_OUTPUT = 8000

// Bump the shape tag when PanelJob changes: a value an older version stored is then dropped.
const snapshot = atom({ plugin: 'codex-panel', key: 'snapshot' } as const, { now: 0, jobs: [] }, { shape: 'snapshot-2' })
const expanded = atom({ plugin: 'codex-panel', key: 'expanded' } as const, [], { shape: 'expanded-1' })

type RawJob = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const time = (v: unknown): number | null => {
  const t = Date.parse(str(v))
  return Number.isFinite(t) ? t : null
}
const isActive = (status: string) => status === 'running' || status === 'queued'

function unwrapCommand(text: string): string {
  return text
    .replace(/^\/bin\/(?:ba|z)?sh -lc /, '')
    .replace(/(?:\.\.\.|…)$/, '')
    .replace(/^['"]/, '')
    .replace(/['"]$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const base = (path: string) => path.replace(/['"]/g, '').split('/').filter(Boolean).pop() ?? path

/** Says in words what a shell command Codex ran is for. */
function describeCommand(raw: string): { icon: string; text: string } {
  const cmd = unwrapCommand(raw)
  const parts = cmd.split(/\s*(?:;|&&|\|\||\|)\s*/).filter(Boolean)
  const words = (part: string) => part.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  const args = (part: string) => words(part).slice(1).filter(w => !w.startsWith('-') && !/^'?\d+(,\d+)?p'?$/.test(w))

  const reads = new Set<string>()
  let search: string | null = null
  for (const part of parts) {
    const tool = words(part)[0] ?? ''
    if (/^(cat|sed|head|tail|nl|less|bat)$/.test(tool)) for (const a of args(part)) reads.add(base(a))
    else if (/^(rg|grep|ag|ack)$/.test(tool) && !search) search = (args(part)[0] ?? '').replace(/^['"]|['"]$/g, '')
  }
  const first = parts[0] ?? cmd
  const tool = words(first)[0] ?? ''
  const full = cmd.toLowerCase()

  if (/apply_patch/.test(full)) return { icon: '✎', text: 'Правит файлы' }
  if (/\b(test|tests|pytest|jest|vitest|xctest)\b|test_[\w.]+\.sh/.test(full)) return { icon: '🧪', text: `Запускает тесты · ${clip(first, 48)}` }
  if (/\b(build|xcodebuild|tsc|cargo build|swift build|make)\b/.test(full)) return { icon: '🔨', text: `Собирает · ${clip(first, 48)}` }
  if (reads.size > 0 && (search == null || /^(cat|sed|head|tail|nl)$/.test(tool)))
    return { icon: '📖', text: `Читает ${clip([...reads].join(', '), 60)}` }
  if (search) return { icon: '🔍', text: `Ищет «${clip(search, 40)}»` }
  if (/^(ls|tree|find|fd)$/.test(tool)) return { icon: '📂', text: `Смотрит ${clip(base(args(first)[0] ?? '.'), 40)}` }
  if (tool === 'git') return { icon: '🌿', text: clip(first, 60) }
  return { icon: '▶', text: clip(first, 60) }
}

type LogSummary = { activity: ActivityRow[]; commands: number; failures: number; edits: number }

/** Turns the plugin's job log into a few readable lines of what Codex is doing. */
function activityFromLog(log: string): LogSummary {
  const rows: (ActivityRow & { cmd?: string })[] = []
  let commands = 0
  let failures = 0
  let edits = 0
  for (const line of log.split('\n')) {
    const m = /^\[[^\]]+\] (.*)$/.exec(line)
    if (!m) continue
    const msg = (m[1] ?? '').trim()
    let r: RegExpExecArray | null
    if ((r = /^Running command: (.*)$/.exec(msg))) {
      commands++
      const cmd = unwrapCommand(r[1] ?? '')
      const prev = rows[rows.length - 1]
      const d = describeCommand(r[1] ?? '')
      // Consecutive reads fold into one line.
      if (prev && prev.icon === '📖' && d.icon === '📖' && prev.tone === 'step') {
        const names = new Set([...prev.text.replace(/^Читает /, '').split(', '), ...d.text.replace(/^Читает /, '').split(', ')])
        prev.text = `Читает ${clip([...names].join(', '), 60)}`
        prev.cmd = cmd
      } else rows.push({ ...d, tone: 'step', cmd })
    } else if ((r = /^Command (\w+): (.*) \(exit (-?\d+|\?)\)$/.exec(msg))) {
      const code = r[3] ?? ''
      if (code !== '0') {
        failures++
        const cmd = unwrapCommand(r[2] ?? '')
        const row = [...rows].reverse().find(x => x.cmd === cmd)
        if (row) {
          row.tone = 'error'
          row.text = `${row.text} — ошибка${code !== '?' ? ` (код ${code})` : ''}`
        } else rows.push({ ...describeCommand(r[2] ?? ''), tone: 'error' })
      }
    } else if ((r = /^Assistant message captured: (.*)$/.exec(msg))) rows.push({ icon: '💬', text: clip(r[1] ?? '', 200), tone: 'message' })
    else if ((r = /^Applying (\d+) file change/.exec(msg))) {
      const n = Number(r[1] ?? 0)
      edits += n
      rows.push({ icon: '✎', text: `Правит ${n} ${n === 1 ? 'файл' : n < 5 ? 'файла' : 'файлов'}`, tone: 'edit' })
    } else if ((r = /^Reasoning summary captured: (.*)$/.exec(msg))) rows.push({ icon: '🧠', text: clip(r[1] ?? '', 200), tone: 'thought' })
    else if ((r = /^Calling (.*)\.$/.exec(msg)) || (r = /^Running tool: (.*)\.$/.exec(msg))) rows.push({ icon: '🔧', text: clip(r[1] ?? '', 60), tone: 'step' })
    else if (/^Starting subagent/.test(msg)) rows.push({ icon: '👥', text: clip(msg, 60), tone: 'step' })
  }
  return { activity: rows.slice(-6).map(({ icon, text, tone }) => ({ icon, text, tone })), commands, failures, edits }
}

function projectName(job: RawJob, dirName: string): string {
  const root = str(job.workspaceRoot)
  return root ? root.split('/').filter(Boolean).pop() ?? root : dirName.replace(/-[0-9a-f]{16}$/, '')
}

function phaseLabel(job: PanelJob): string {
  if (job.status === 'queued') return 'в очереди'
  if (job.status === 'completed') return 'готово'
  if (job.status === 'failed') return 'ошибка'
  if (job.status === 'cancelled') return 'отменено'
  const phases: Record<string, string> = {
    starting: 'запускается',
    running: 'работает',
    investigating: 'изучает код',
    editing: 'правит файлы',
    verifying: 'проверяет',
    reviewing: 'делает ревью',
    finalizing: 'подводит итог',
  }
  return phases[job.phase] ?? job.phase ?? 'работает'
}

function kindLabel(kind: string): string {
  if (kind === 'review') return 'ревью'
  if (kind === 'adversarial-review') return 'жёсткое ревью'
  return 'задача'
}

function icon(status: string): string {
  if (status === 'completed') return '✓'
  if (status === 'failed') return '✗'
  if (status === 'cancelled') return '⏹'
  if (status === 'queued') return '⏳'
  return '🔵'
}

function duration(ms: number | null): string {
  if (ms == null || ms < 0) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} мин ${s % 60} с`
  return `${Math.floor(m / 60)} ч ${m % 60} мин`
}

function ago(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1) return 'только что'
  if (m < 60) return `${m} мин назад`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч назад`
  return `${Math.round(h / 24)} дн назад`
}

let busy = false
let seenActive = new Set<string>()

async function readText($: any, path: string): Promise<string | null> {
  try {
    return (await $.fs.read(path)) as string
  } catch {
    return null
  }
}

async function collect($: any): Promise<PanelJob[]> {
  const home = await $.env.get('HOME')
  if (!home) return []
  const dataRoot = `${home}/.claude/plugins/data`
  let pluginDirs: { name: string; kind: string }[] = []
  try {
    pluginDirs = (await $.fs.list(dataRoot)).filter((d: any) => d.kind === 'dir' && d.name.startsWith('codex-'))
  } catch {
    return []
  }

  const jobs: { raw: RawJob; dir: string; project: string }[] = []
  for (const plugin of pluginDirs) {
    const stateRoot = `${dataRoot}/${plugin.name}/state`
    let projects: { name: string; kind: string }[] = []
    try {
      projects = (await $.fs.list(stateRoot)).filter((d: any) => d.kind === 'dir')
    } catch {
      continue
    }
    for (const project of projects) {
      const dir = `${stateRoot}/${project.name}`
      const text = await readText($, `${dir}/state.json`)
      if (!text) continue
      try {
        const state = JSON.parse(text)
        for (const raw of Array.isArray(state.jobs) ? state.jobs : []) {
          jobs.push({ raw, dir, project: projectName(raw, project.name) })
        }
      } catch {
        // A state file mid-write: picked up on the next poll.
      }
    }
  }

  jobs.sort((a, b) => str(b.raw.updatedAt).localeCompare(str(a.raw.updatedAt)))
  const picked = jobs.slice(0, MAX_JOBS)
  const result: PanelJob[] = []
  for (const [index, { raw, dir, project }] of picked.entries()) {
    const id = str(raw.id)
    const status = str(raw.status) || 'running'
    const job: PanelJob = {
      id,
      project,
      title: str(raw.title) || 'Codex',
      summary: cleanSummary(str(raw.summary)),
      kind: str(raw.kind) || 'task',
      status,
      phase: str(raw.phase),
      write: raw.write === true,
      startedAt: time(raw.startedAt) ?? time(raw.createdAt),
      completedAt: time(raw.completedAt),
      updatedAt: time(raw.updatedAt) ?? 0,
      threadId: str(raw.threadId) || null,
      activity: [],
      commands: 0,
      failures: 0,
      edits: 0,
      output: null,
      error: str(raw.errorMessage) || null,
    }
    // The job file keeps the original request as its summary; state.json
    // swaps it for the first line of the answer once the job finishes.
    const stored = await readText($, `${dir}/jobs/${id}.json`)
    let parsed: any = null
    if (stored) {
      try {
        parsed = JSON.parse(stored)
      } catch {
        // mid-write: next poll
      }
    }
    const requested = cleanSummary(str(parsed?.summary) || str(parsed?.request?.prompt))
    if (requested) job.summary = requested
    // Details only for the jobs worth showing: active ones and the newest few.
    if (isActive(status) || index < 5) {
      const logFile = str(raw.logFile) || `${dir}/jobs/${id}.log`
      const log = await readText($, logFile)
      if (log) Object.assign(job, activityFromLog(log))
      if (!isActive(status) && parsed) {
        const text = stripCardHeader(str(parsed.rendered)) || str(parsed.result?.rawOutput)
        job.output = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n\n…(обрезано)` : text || null
        job.error = job.error ?? (str(parsed.errorMessage) || null)
      }
    }
    result.push(job)
  }
  return result
}

async function refresh($: any) {
  if (busy) return
  busy = true
  try {
    const jobs = await collect($)
    const now = await $.clock.now()
    const anyActive = jobs.some(j => isActive(j.status))
    const previous = await read($, snapshot)
    // Redraw on any change; while a job runs, every poll so its timer moves.
    if (anyActive || JSON.stringify(previous.jobs) !== JSON.stringify(jobs)) {
      await update($, snapshot, () => ({ now, jobs }))
    }
    // A job that just started opens the pane by itself.
    const active = new Set(jobs.filter(j => isActive(j.status)).map(j => j.id))
    const fresh = [...active].some(id => !seenActive.has(id))
    seenActive = active
    if (fresh) void $.ui.open({ id: PANE, title: TITLE })
  } catch {
    // Keep polling; a bad read now is usually a file being rewritten.
  } finally {
    busy = false
  }
}

function cleanSummary(text: string): string {
  return text
    .replace(/^<task>\s*/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// The panel already shows status, title and time; drop the card's own header line.
function stripCardHeader(text: string): string {
  return text.replace(/^(?:✅|❌|⚠️|⏹️?)[^\n]*\*\*Codex[^\n]*\n+/u, '').trim()
}

const TASK_STEPS: [string, string][] = [
  ['investigating', 'изучает'],
  ['editing', 'правит'],
  ['verifying', 'проверяет'],
  ['finalizing', 'итог'],
]

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10
  const h = n % 100
  if (d === 1 && h !== 11) return one
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few
  return many
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'codex-panel',
      description: 'Открыть панель Codex: задачи, что Codex делает сейчас, его ответы',
    })
    await refresh($)
    const current = await read($, snapshot)
    seenActive = new Set(current.jobs.filter(j => isActive(j.status)).map(j => j.id))
    if (seenActive.size > 0) void $.ui.open({ id: PANE, title: TITLE })
    $.clock.every(POLL_MS, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'codex-panel' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Панель Codex открыта.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const { now, jobs } = await read($, snapshot)
    const open = await read($, expanded)

    if (jobs.length === 0) {
      return (
        <Box flexDirection="column" padding={1} gap={1}>
          <Text weight="semibold">Задач Codex пока нет</Text>
          <Text dimColor>
            Отправьте задачу через /codex:rescue или попросите Claude отдать её Codex. Ход работы появится здесь.
          </Text>
        </Box>
      )
    }

    const active = jobs.filter(j => isActive(j.status))
    const finished = jobs.filter(j => !isActive(j.status))
    const failedCount = finished.filter(j => j.status === 'failed').length
    const newestFinished = finished[0]?.id
    const isOpen = (job: PanelJob) =>
      open.includes(job.id) || (job.id === newestFinished && active.length === 0 && !open.includes(`hide:${job.id}`))
    const toggle = (job: PanelJob) => () =>
      update($, expanded, list => {
        const shown = list.includes(job.id) || (job.id === newestFinished && active.length === 0 && !list.includes(`hide:${job.id}`))
        const rest = list.filter(x => x !== job.id && x !== `hide:${job.id}`)
        return (shown ? (job.id === newestFinished ? [...rest, `hide:${job.id}`] : rest) : [...rest, job.id]).slice(-20)
      })

    const toneColor = (row: ActivityRow) =>
      row.tone === 'error' ? 'error' : row.tone === 'edit' ? 'warning' : row.tone === 'ok' ? 'success' : undefined

    const elapsedOf = (job: PanelJob) =>
      isActive(job.status)
        ? duration(job.startedAt != null ? now - job.startedAt : null)
        : duration(job.startedAt != null && job.completedAt != null ? job.completedAt - job.startedAt : null)

    const meta = (job: PanelJob) =>
      [
        job.project,
        kindLabel(job.kind) + (job.kind === 'task' ? (job.write ? ' · правит' : ' · чтение') : ''),
      ].join(' · ')

    const stats = (job: PanelJob) =>
      [
        job.commands ? `${job.commands} ${plural(job.commands, 'команда', 'команды', 'команд')}` : '',
        job.failures ? `${job.failures} ✗` : '',
        job.edits ? `${job.edits} ${plural(job.edits, 'правка', 'правки', 'правок')}` : '',
      ]
        .filter(Boolean)
        .join(' · ')

    const Activity = (job: PanelJob) => (
      <Box flexDirection="column" gap={0}>
        {job.activity.map((row, i) => (
          <Box key={`a-${job.id}-${i}`} flexDirection="row" gap={1}>
            <Text>{row.icon}</Text>
            <Text
              size="footnote"
              color={toneColor(row)}
              italic={row.tone === 'message' || row.tone === 'thought'}
              dimColor={row.tone === 'thought'}
              wrap={row.tone === 'message' ? 'wrap' : 'truncate-end'}
            >
              {row.text}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const Steps = (job: PanelJob) => {
      const current = TASK_STEPS.findIndex(([phase]) => phase === job.phase)
      return (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {TASK_STEPS.map(([phase, label], i) => (
            <Text
              key={`s-${job.id}-${phase}`}
              size="footnote"
              color={i < current ? 'success' : i === current ? 'suggestion' : undefined}
              weight={i === current ? 'semibold' : 'regular'}
              dimColor={i > current}
            >
              {i < current ? '✓' : i === current ? '●' : '○'} {label}
              {i < TASK_STEPS.length - 1 ? '  ›' : ''}
            </Text>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text color={active.length ? 'suggestion' : undefined} dimColor={!active.length} weight="medium">
            {active.length ? `● в работе ${active.length}` : '○ сейчас тихо'}
          </Text>
          <Text color="success">✓ {finished.length - failedCount}</Text>
          {failedCount > 0 && <Text color="error">✗ {failedCount}</Text>}
        </Box>

        {active.map(job => (
          <Box
            key={`job-${job.id}`}
            flexDirection="column"
            borderStyle="round"
            borderColor="suggestion"
            paddingX={1}
            paddingY={0}
            gap={1}
          >
            <Box flexDirection="column">
              <Text weight="semibold" wrap="wrap">
                {clip(job.summary || job.title, 140)}
              </Text>
              <Text dimColor size="footnote">
                {meta(job)}
              </Text>
            </Box>
            <Box flexDirection="row" justifyContent="space-between">
              <Text color="suggestion" weight="semibold">
                ● {phaseLabel(job)}
              </Text>
              <Text color="suggestion" tabular>
                {elapsedOf(job)}
              </Text>
            </Box>
            {job.kind === 'task' && Steps(job)}
            {job.activity.length > 0 ? Activity(job) : <Text dimColor>Codex начинает работу…</Text>}
            {stats(job) && (
              <Text dimColor size="caption">
                {stats(job)}
              </Text>
            )}
          </Box>
        ))}

        {finished.length > 0 && (
          <Text dimColor size="caption" weight="medium">
            ГОТОВО
          </Text>
        )}

        {finished.map(job => {
          const shown = isOpen(job)
          const failed = job.status === 'failed'
          const canOpen = Boolean(job.output || job.error || job.activity.length)
          return (
            <Box
              key={`job-${job.id}`}
              flexDirection="column"
              borderStyle={shown ? 'round' : undefined}
              borderColor={failed ? 'error' : undefined}
              borderDimColor={!failed}
              paddingX={shown ? 1 : 0}
              gap={shown ? 1 : 0}
            >
              <Box flexDirection="row" gap={1}>
                <Text color={failed ? 'error' : job.status === 'completed' ? 'success' : undefined}>{icon(job.status)}</Text>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text weight="medium" wrap={shown ? 'wrap' : 'truncate-end'}>
                    {job.summary || job.title}
                  </Text>
                  <Box flexDirection="row" justifyContent="space-between" gap={1}>
                    <Text dimColor size="footnote" wrap="truncate-end">
                      {meta(job)} · {elapsedOf(job)}
                      {job.completedAt ? ` · ${ago(now - job.completedAt)}` : ''}
                    </Text>
                    {canOpen && (
                      <Button key={`t-${job.id}`} label={shown ? 'Скрыть' : 'Ответ'} plain onPress={toggle(job)} />
                    )}
                  </Box>
                </Box>
              </Box>
              {shown && stats(job) && (
                <Text dimColor size="caption">
                  {stats(job)}
                </Text>
              )}
              {shown && job.error && <Text color="error">{job.error}</Text>}
              {shown && job.output && <Markdown key={`out-${job.id}`} text={job.output} />}
              {shown && !job.output && job.activity.length > 0 && Activity(job)}
            </Box>
          )
        })}
      </Box>
    )
  })
}
