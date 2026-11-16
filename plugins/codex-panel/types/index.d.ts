export type ActivityTone = 'step' | 'ok' | 'error' | 'message' | 'thought' | 'edit'

/** One readable line of what Codex did, built from the plugin's job log. */
export type ActivityRow = {
  icon: string
  text: string
  tone: ActivityTone
}

export type PanelJob = {
  id: string
  project: string
  title: string
  summary: string
  kind: string
  /** Model label for Antigravity jobs, empty for Codex. */
  model: string
  status: string
  phase: string
  write: boolean
  startedAt: number | null
  completedAt: number | null
  updatedAt: number
  threadId: string | null
  activity: ActivityRow[]
  commands: number
  failures: number
  edits: number
  output: string | null
  error: string | null
}

export type Snapshot = { now: number; jobs: PanelJob[] }

declare module 'claude-code' {
  interface PluginState {
    'codex-panel': {
      snapshot: Shaped<Snapshot>
      expanded: Shaped<string[]>
    }
  }
}
