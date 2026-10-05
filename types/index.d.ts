// herdr-commander's $.state contract.

export type Role = 'plain' | 'commander' | 'worker'

export type Gate = {
  /** HERDR_ENV=1 and a pane id: every other hook passes through when false. */
  inHerdr: boolean
  paneId: string
  workspaceId: string
  role: Role
}

export type AgentStatus = 'working' | 'idle' | 'done' | 'blocked' | 'unknown'

export type AgentRow = {
  paneId: string
  name: string | null
  kind: string
  status: AgentStatus
  /** When this pane entered its status (ms since epoch). */
  since: number
  title: string
  cwd: string
  workspaceId: string
  role: Role
  jobId: string | null
  isMine: boolean
  isSelf: boolean
  focused: boolean
}

export type JobRow = {
  jobId: string
  from: string
  to: string
  kind: string
  status: string
  summary: string
  body: string
  resultPath: string
}

export type BgRow = {
  id: string
  paneId: string
  command: string
  status: string
  exitCode: number | null
}

export type Preview = { paneId: string; text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'herdr-commander': {
      gate: Gate
      agents: AgentRow[]
      jobs: JobRow[]
      bg: BgRow[]
      lease: string | null
      selected: string | null
      preview: Preview | null
      herdrUp: boolean
      lastError: string | null
      pendingInterrupt: string | null
      paneOpen: boolean
      notice: string | null
      /** Job ids and background ids whose completion already woke the session. */
      announced: string[]
    }
  }
}
