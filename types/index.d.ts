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
  /** How a job completed: message (sent, then stopped), tool or result_file. */
  via?: string
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

export type BgRow = {
  id: string
  paneId: string
  command: string
  status: string
  exitCode: number | null
  outputFile: string
  monitor: boolean
  description: string
  /** A monitor's output lines new since the last poll. */
  newLines: string[]
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
      bg: BgRow[]
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
      /** Job event keys and background ids that already woke the session. */
      announced: string[]
    }
  }
}
