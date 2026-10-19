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

/** What the sender of a job is told about, once each (keyed job id + seq). */
export type JobEvent = {
  seq: number
  type: string
  at: string
  message_seq?: number
  note?: string
  by?: string
  /** How a job completed: answer (a Claude worker's final reply), tool, result_file, or message (before 0.2.2). */
  via?: string
  /** An event its Claude worker sends the sender by Claude's cross-session messages: sending, sent or failed. */
  relay?: string
  /** When `relay` last changed (ISO). */
  relay_at?: string
}

export type JobRow = {
  jobId: string
  from: string
  to: string
  /** The herdr id of the worker, for a job of a herdr worker. */
  worker: string | null
  kind: string
  status: string
  summary: string
  body: string
  resultPath: string
  messages: Array<{ seq: number; from: string; text: string }>
  events: JobEvent[]
}

/** A herdr worker this pane started (Agent takeover or herdr_worker_spawn). */
export type WorkerRow = {
  herdrId: string
  kind: string
  name: string | null
  agentName: string | null
  paneId: string | null
  status: string
  cwd: string
  outputFile: string
  note: string
  jobId: string | null
  queued: number
}

export type Preview = { paneId: string; text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'herdr-commander': {
      gate: Gate
      agents: AgentRow[]
      jobs: JobRow[]
      workers: WorkerRow[]
      /** The bridge's folder of pane screen files (from the last poll). */
      panesDir: string | null
      lease: string | null
      selected: string | null
      preview: Preview | null
      herdrUp: boolean
      lastError: string | null
      pendingInterrupt: string | null
      paneOpen: boolean
      notice: string | null
      /** Job event keys that already woke the session. */
      announced: string[]
    }
  }
}
