// herdr-commander. Inside herdr (HERDR_ENV=1) the herdr features switch on;
// outside herdr the gate stays closed and every hook passes through.
//
// With the `takeover` switch on (the default), Claude's own tools go through
// herdr: Agent with a herdr worker type opens a worker pane under a herdr id,
// and SendMessage / TaskStop / ListAgents / Read know those ids. Background
// Bash / PowerShell, Monitor and every other agent type stay Claude's own.
// Off, or outside herdr, every tool is Claude's own.
//
// Every $ call lives in this file (the engine follows $ only within one file);
// pure helpers are in ./pure. herdr itself is only ever run by the bridge
// (../bridge/cli.mjs), which holds the records and the safety rules.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, Gate, JobRow, Preview, Role, WorkerRow } from '../types'
import {
  ACTIVE_JOB,
  AGENT_SPECS,
  COLOR,
  DELIVER_ADDENDUM,
  DIALOG_TOOLS,
  MARK,
  PANE_ID,
  ROLE_TEXT,
  SPAWN_ROLES,
  SPAWN_TOOL,
  WRITE_TOOLS,
  agentLine,
  awaitingRelay,
  bridgeArgv,
  envText,
  errorText,
  eventText,
  herdrKind,
  herdrListing,
  isRuntimePath,
  launchTypes,
  noticeText,
  notices,
  parseReply,
  readOptions,
  runtimeRootOf,
  sentText,
  sortAgents,
  spawnDescription,
  toJobs,
  toRows,
  toWorkers,
  transitions,
} from './pure'
import type { Delivery, LaunchType, Launcher, Options, RawAgent, RawJob, RawWorker, RelayNotice, RouteReply, Snapshot } from './pure'

// State ($.state). Atoms are declared here: the engine reads them per file.

const OFF_GATE: Gate = { inHerdr: false, paneId: '', workspaceId: '', role: 'plain' }

const stGate = atom({ plugin: 'herdr-commander', key: 'gate' } as const, OFF_GATE)
const stAgents = atom({ plugin: 'herdr-commander', key: 'agents' } as const, [] as AgentRow[])
const stJobs = atom({ plugin: 'herdr-commander', key: 'jobs' } as const, [] as JobRow[])
const stWorkers = atom({ plugin: 'herdr-commander', key: 'workers' } as const, [] as WorkerRow[])
const stPanesDir = atom({ plugin: 'herdr-commander', key: 'panesDir' } as const, null as string | null)
const stLease = atom({ plugin: 'herdr-commander', key: 'lease' } as const, null as string | null)
const stSelected = atom({ plugin: 'herdr-commander', key: 'selected' } as const, null as string | null)
const stPreview = atom({ plugin: 'herdr-commander', key: 'preview' } as const, null as Preview | null)
const stHerdrUp = atom({ plugin: 'herdr-commander', key: 'herdrUp' } as const, true)
const stLastError = atom({ plugin: 'herdr-commander', key: 'lastError' } as const, null as string | null)
const stPendingInterrupt = atom({ plugin: 'herdr-commander', key: 'pendingInterrupt' } as const, null as string | null)
const stPaneOpen = atom({ plugin: 'herdr-commander', key: 'paneOpen' } as const, false)
const stNotice = atom({ plugin: 'herdr-commander', key: 'notice' } as const, null as string | null)
const stAnnounced = atom({ plugin: 'herdr-commander', key: 'announced' } as const, [] as string[])

const PANE_ID_UI = 'commander'

const NOTIFY_GAP_MS = 30000
/**
 * A worker's session report: one bridge call took 8.4 s on a loaded machine
 * (2026-10-20), so it gets 30 s, and it is tried again every few seconds until
 * the bridge records it (no work can reach the worker before that, so no
 * prompt would ever retry it). The bridge waits SESSION_WAIT_MS (180 s) from
 * herdr seeing the process; this keeps trying a while past that.
 */
const SESSION_REPORT_TIMEOUT_MS = 30000
const SESSION_RETRY_MS = 5000
const SESSION_RETRY_FOR_MS = 300000
/** The sender's send-take / send-done calls; a lost send-done leaves its job "sending" until it times out. */
const SEND_CALL_TIMEOUT_MS = 30000

// Module state (a reload starts it over; $.state keeps the rest).
let pollTimer: Timer | null = null
let pollMs = 0
let previewTimer: Timer | null = null
let ticking = false
let failures = 0
let seeded = false
const lastNotified = new Map<string, number>()
let toolRegistered = false
let desired: 'working' | 'idle' | 'blocked' | null = null
let reported: 'working' | 'idle' | 'blocked' | null = null
let sending = false
/** A permission dialog was shown during the running tool call. */
let awaitingPermission = false
/** When this pane's current turn began (ms), for the bridge's "stopped" check. */
let turnStartedAt: number | null = null
/** The last prompt this pane took (ms), one delivered into a running turn included. */
let lastPromptAt: number | null = null
/** The role whose herdr text this session's model has been given (prompt context; see prompt.submit). */
let briefedRole: Role | null = null
/** This process's herdr pane from its environment, null outside herdr; undefined until read. */
let paneEnv: Gate | null | undefined
/** A gate being rebuilt after a conversation switch (see gateOf), shared by the hooks that ask meanwhile. */
let adopting: Promise<Gate> | null = null
/**
 * This session's permission mode, which a Claude worker it starts would take
 * (`--permission-mode`). Nothing gives it now: the classic hooks that carry
 * `permission_mode` are bypassed by the built-in policy plugin (debug log,
 * 2026-10-15), so workers start in the person's default mode.
 */
const permissionMode: string | null = null
/** The Claude session this worker last reported to the bridge (the address its work is sent to). */
let sessionReported: string | null = null
/** Retries the session report until the bridge records it (see SESSION_RETRY_MS). */
let sessionRetryTimer: Timer | null = null
/** A session report is on its way (a slow one must not pile up behind the retry timer). */
let reportingSession = false
/** Cross-session sends of this pane, one after another (a tick and a SendMessage may both send). */
let sendChain: Promise<unknown> = Promise.resolve()
/** The main loop's turn is running (turn.start / a prompt, until turn.complete). */
let turnRunning = false
/**
 * Notices that came while a turn runs. A plugin prompt would wait for the
 * turn to end; these go on the next tool result instead (tool.call context,
 * which the model reads at once), or as a prompt when the turn ends first.
 * (A cross-session message to this session itself was tried: the engine
 * refuses it, "no live session on this machine has id ...", 2026-10-19.)
 */
const heldNotices: string[] = []
let runtimeRoot = ''
let options: Options = readOptions({})
/** The launcher registry as the bridge last listed it (herdr_worker_spawn's description). */
let launchers: Launcher[] = []
/** Agent types the launchers' choices give, by type (`herdr-commander:<launcher>-<value>`). */
const launchTypeOf = new Map<string, LaunchType>()

/** Runs a bridge command; `stdinArgs` go on stdin (no command-line length limit). */
async function bridge<T = unknown>($: EngineInterface, command: string, args: Record<string, unknown> = {}, byUser = false, timeoutMs = 30000, stdinArgs: Record<string, unknown> | null = null): Promise<T> {
  const g = await read($, stGate)
  const argv = bridgeArgv($.plugin.root, g, command, args, byUser, stdinArgs !== null)
  const ran = await $.process.run(argv, stdinArgs === null ? { timeoutMs } : { timeoutMs, stdin: JSON.stringify(stdinArgs) })
  return parseReply<T>(ran.stdout, ran.stderr, ran.exitCode)
}

/** Runs `fn` after the current dispatch, so a slow herdr call never delays a turn. */
function later($: EngineInterface, fn: () => Promise<unknown>): void {
  $.clock.after(1, () => {
    void fn().catch(() => {})
  })
}

/** The herdr pane this process runs in, from its environment (which never changes), or null. */
async function envPane($: EngineInterface): Promise<Gate | null> {
  if (paneEnv === undefined) {
    const isHerdr = (await $.env.get('HERDR_ENV')) === '1'
    const paneId = (await $.env.get('HERDR_PANE_ID')) ?? ''
    const workspaceId = (await $.env.get('HERDR_WORKSPACE_ID')) ?? paneId.split(':')[0] ?? ''
    const role: Role = (await $.env.get('HERDR_COMMANDER_ROLE')) === 'worker' ? 'worker' : 'plain'
    paneEnv = isHerdr && paneId !== '' && workspaceId !== '' ? { inHerdr: true, paneId, workspaceId, role } : null
  }
  return paneEnv
}

/**
 * This conversation's gate. $.state belongs to the conversation, and a
 * /resume or /clear in a running process starts a new one with no
 * session.start: an empty gate inside herdr is rebuilt from the environment,
 * the commander role from the bridge's lease (this pane still holds it).
 */
async function gateOf($: EngineInterface): Promise<Gate> {
  const g = await read($, stGate)
  if (g.inHerdr) {
    return g
  }
  const pane = await envPane($)
  if (pane === null) {
    return g
  }
  adopting ??= adopt($, pane).finally(() => {
    adopting = null
  })
  return adopting
}

async function adopt($: EngineInterface, pane: Gate): Promise<Gate> {
  await update($, stGate, () => pane)
  if (pane.role === 'worker') {
    // A new conversation is a new session: its work is sent there now.
    keepReportingSession($)
    return pane
  }
  const held = await bridge<{ lease: { pane_id: string } | null }>($, 'lease', {}, false, 8000).catch(() => null)
  const g: Gate = held?.lease?.pane_id === pane.paneId ? { ...pane, role: 'commander' } : pane
  if (g.role === 'commander') {
    await update($, stGate, () => g)
    startPreview($)
  }
  // The switch stopped the poll; work sent out before it may still be running
  // (runTick stops again when nothing is).
  await ensurePolling($)
  return g
}

/**
 * Whether a call that creates a worker goes to herdr: the switch is on, this is a herdr pane that is not a
 * worker, and the call is the main loop's (a subagent's own calls stay native).
 * The bridge adds the last rule: a plain pane does not start panes while
 * another live pane is this workspace's commander.
 */
function mayCreate(g: Gate, agentId: string | undefined): string | null {
  if (!options.takeover) {
    return 'the herdr takeover switch is off'
  }
  if (!g.inHerdr) {
    return 'this session is not inside herdr'
  }
  if (g.role === 'worker') {
    return 'a herdr worker does not start further workers'
  }
  if (agentId) {
    return 'only the main conversation starts herdr workers'
  }
  return null
}

async function agentsNow($: EngineInterface): Promise<AgentRow[]> {
  const rows = await read($, stAgents)
  if (rows.length > 0) {
    return rows
  }
  const g = await gateOf($)
  return toRows(await bridge<RawAgent[]>($, 'agents'), [], g.paneId, await $.clock.now())
}

/** Starts the pane of a recorded worker in the background, sends it its task, then keeps watching. */
function startWorker($: EngineInterface, herdrId: string): void {
  later($, async () => {
    await bridge($, 'worker-start', { herdr_id: herdrId }, false, 200000).catch(() => null)
    await sendPending($).catch(() => null)
    await ensurePolling($)
    await runTick($)
  })
}

type NewWorker = { worker: RawWorker & { output_file: string }; job: { job_id: string } }

function launchedContext(out: NewWorker): string {
  const id = out.worker.herdr_id
  const answers = out.worker.worker_kind === 'claude'
    ? `Its task, and whatever you SendMessage to ${id} later, reach it by Claude's cross-session messages. Its final reply when it finishes, or a message it sends along the way, comes back to you the same way (a cross-session message from it). You are also told if it stops without a result, or if a message cannot be delivered.`
    : 'You are told when it completes, with the result file to Read, or if it cannot start.'
  return [
    `herdr: ${id} runs as a herdr worker in its own visible pane (a separate session, not an in-process subagent); the pane opens in the background, up to ~90 s.`,
    `Its outputFile is a short Markdown log the herdr bridge keeps (the task, every message both ways, and the worker's latest screen on each Read): Read it whenever you like, whatever the line above says about the file.`,
    `${answers} SendMessage to ${id} gives it more on the same job; TaskStop ends it and closes its pane.`,
  ].join('\n')
}

/**
 * A worker tells the bridge its Claude session (once per conversation): where
 * its work is sent. True once it is recorded, or when there is nothing to report.
 */
async function reportSession($: EngineInterface): Promise<boolean> {
  const g = await read($, stGate)
  if (!g.inHerdr || g.role !== 'worker' || !options.takeover) {
    return true
  }
  const sessionId = await $.session.id()
  if (sessionId === sessionReported) {
    return true
  }
  if (reportingSession) {
    return false
  }
  reportingSession = true
  try {
    const out = await bridge<{ recorded: boolean }>($, 'worker-session', { session_id: sessionId }, false, SESSION_REPORT_TIMEOUT_MS).catch(() => null)
    if (out?.recorded) {
      sessionReported = sessionId
      return true
    }
    return false
  } finally {
    reportingSession = false
  }
}

/** Reports this worker's session now, and again every few seconds until the bridge has it. */
function keepReportingSession($: EngineInterface): void {
  stopReportingSession()
  let tries = Math.ceil(SESSION_RETRY_FOR_MS / SESSION_RETRY_MS)
  const attempt = async () => {
    if (await reportSession($)) {
      stopReportingSession()
    }
  }
  sessionRetryTimer = $.clock.every(SESSION_RETRY_MS, () => {
    tries -= 1
    if (tries < 0) {
      stopReportingSession()
      return
    }
    void attempt().catch(() => {})
  })
  later($, attempt)
}

function stopReportingSession(): void {
  sessionRetryTimer?.cancel()
  sessionRetryTimer = null
}

type SendItem = { job_id: string; send_id: string; session_id: string; text: string }
type Sent = { jobId: string; delivered: boolean; reason: string; event?: string }

/**
 * Sends what waits for this pane's Claude workers by Claude's cross-session
 * messages: the bridge hands each item over with its delivery already
 * recorded (send-take), and hears how it went (send-done). Never typed into a
 * pane instead. Serialized: a tick and a SendMessage may ask at once.
 */
function sendPending($: EngineInterface): Promise<Sent[]> {
  const run = sendChain.then(() => sendRounds($))
  sendChain = run.catch(() => null)
  return run
}

async function sendRounds($: EngineInterface): Promise<Sent[]> {
  const out: Sent[] = []
  // What joins a job while its send is out waits for it: a second round sends that.
  for (let round = 0; round < 3; round += 1) {
    const taken = await bridge<{ items: SendItem[]; failed: Array<{ job_id: string; reason: string; event: string }> }>($, 'send-take', {}, false, SEND_CALL_TIMEOUT_MS)
    out.push(...taken.failed.map(one => ({ jobId: one.job_id, delivered: false, reason: one.reason, event: one.event })))
    let again = false
    for (const item of taken.items) {
      const sent = await $.session.send({ to: { sessionId: item.session_id }, text: item.text })
        .catch((error: unknown) => ({ isDelivered: false as const, reason: errorText(error) }))
      const reason = sent.isDelivered ? '' : sent.reason || 'not delivered'
      // Tried twice: a lost result leaves the job "sending" until the bridge
      // gives up on it, and the sender is then told it may not have arrived.
      const doneArgs = { job_id: item.job_id, send_id: item.send_id, delivered: sent.isDelivered, reason }
      const done = await bridge<{ job: RawJob; event?: string }>($, 'send-done', doneArgs, false, SEND_CALL_TIMEOUT_MS)
        .catch(() => bridge<{ job: RawJob; event?: string }>($, 'send-done', doneArgs, false, SEND_CALL_TIMEOUT_MS))
        .catch(() => null)
      out.push({ jobId: item.job_id, delivered: sent.isDelivered, reason, event: done?.event })
      again ||= done?.job.status === 'pending'
    }
    if (!again) {
      break
    }
  }
  return out
}

/**
 * A worker sends its sender a job event by Claude's cross-session messages,
 * in the words the sender's own notices use, then reports how it went (the
 * sender tells it itself when this fails). True when delivered.
 */
async function relay($: EngineInterface, notice: RelayNotice | undefined): Promise<boolean | null> {
  if (!notice) {
    return null
  }
  const job = toJobs([notice.job])[0]
  const event = job?.events.find(one => one.seq === notice.event_seq)
  const line = job && event ? eventText(job, event, toWorkers(notice.worker ? [notice.worker] : []), job.from) : null
  const sent = line === null
    ? { isDelivered: false as const, reason: 'nothing to send' }
    : await $.session.send({ to: { sessionId: notice.session_id }, text: noticeText([line]) })
      .catch((error: unknown) => ({ isDelivered: false as const, reason: errorText(error) }))
  const reason = sent.isDelivered ? '' : sent.reason || 'not delivered'
  await bridge($, 'relay-done', { job_id: notice.job.job_id, event_seq: notice.event_seq, delivered: sent.isDelivered, reason }, false, 15000).catch(() => null)
  return sent.isDelivered
}

/** Polls while there is something to watch: the commander role, or work this pane sent out. */
async function ensurePolling($: EngineInterface): Promise<void> {
  const g = await gateOf($)
  if (!g.inHerdr) {
    return
  }
  const slow = g.role === 'commander' && !(await read($, stPaneOpen))
  const ms = (slow ? Math.max(10, options.pollSeconds) : options.pollSeconds) * 1000
  if (pollTimer && pollMs === ms) {
    return
  }
  pollTimer?.cancel()
  pollMs = ms
  pollTimer = $.clock.every(ms, () => {
    runTick($).catch(() => {})
  })
  runTick($).catch(() => {})
}

function stopPolling(): void {
  pollTimer?.cancel()
  pollTimer = null
  pollMs = 0
}

async function runTick($: EngineInterface): Promise<void> {
  await tick($)
  const g = await gateOf($)
  if (g.role === 'commander') {
    return
  }
  const jobs = await read($, stJobs)
  const pending = jobs.some(job => job.from === g.paneId && ACTIVE_JOB.includes(job.status))
    || (await read($, stWorkers)).some(one => one.status === 'starting' || one.status === 'blocked')
    // A worker's notice still on its way: told here if it never arrives.
    || awaitingRelay(g.paneId, jobs, await read($, stAnnounced))
  if (!pending) {
    stopPolling()
  }
}

/** Applies a bridge snapshot to the atoms; returns the rows before and after. */
async function absorb($: EngineInterface, snap: Snapshot): Promise<{ before: AgentRow[]; rows: AgentRow[]; jobRows: JobRow[]; workerRows: WorkerRow[] }> {
  const g = await gateOf($)
  const now = await $.clock.now()
  const before = await read($, stAgents)
  const rows = toRows(snap.agents, before, g.paneId, now)
  if (JSON.stringify(rows) !== JSON.stringify(before)) {
    await update($, stAgents, () => rows)
  }
  const jobRows = toJobs(snap.jobs)
  if (JSON.stringify(jobRows) !== JSON.stringify(await read($, stJobs))) {
    await update($, stJobs, () => jobRows)
  }
  const workerRows = toWorkers(snap.workers ?? [])
  if (JSON.stringify(workerRows) !== JSON.stringify(await read($, stWorkers))) {
    await update($, stWorkers, () => workerRows)
  }
  if (snap.panes_dir && snap.panes_dir !== (await read($, stPanesDir))) {
    await update($, stPanesDir, () => snap.panes_dir ?? null)
  }
  const holder = snap.lease?.pane_id ?? null
  if (holder !== (await read($, stLease))) {
    await update($, stLease, () => holder)
  }
  return { before, rows, jobRows, workerRows }
}

async function tick($: EngineInterface): Promise<void> {
  const g = await gateOf($)
  if (!g.inHerdr || ticking) {
    return
  }
  ticking = true
  try {
    const snap = await bridge<Snapshot>($, 'snapshot', {}, false, 25000)
    const now = await $.clock.now()
    const { before, rows, jobRows, workerRows } = await absorb($, snap)
    if (g.role === 'commander' && options.notifications) {
      for (const { row, isBlocked } of transitions(before, rows, g.paneId)) {
        if (now - (lastNotified.get(row.paneId) ?? 0) < NOTIFY_GAP_MS) {
          continue
        }
        lastNotified.set(row.paneId, now)
        const title = isBlocked ? `${row.paneId} needs you` : `${row.paneId} finished`
        $.ui.toast(`${title} (${row.kind}): ${row.title.slice(0, 60)}`)
        later($, () => bridge($, 'notify', { title, body: row.title.slice(0, 200), sound: isBlocked ? 'request' : 'done' }))
      }
    }

    // What waits to be sent to this pane's Claude workers (one whose worker
    // came up since, or has gone too long without a session to send to).
    if (jobRows.some(job => job.from === g.paneId && job.status === 'pending')) {
      later($, () => sendPending($))
    }

    // Wake once per job event; old ones on (re)load stay quiet. Events a
    // worker sends itself by Claude's cross-session messages are not repeated.
    const news = notices(g.paneId, jobRows, workerRows, await read($, stAnnounced), now)
    if (news.keys.length > 0) {
      await update($, stAnnounced, list => [...list, ...news.keys].slice(-400))
    }
    if (seeded && news.lines.length > 0) {
      $.ui.toast((news.lines[0] ?? 'herdr work').split('\n')[0]?.slice(0, 120) ?? 'herdr work')
      if (turnRunning) {
        // Busy: the next tool result carries them (or the turn's end, a prompt).
        heldNotices.push(...news.lines)
      } else {
        void $.prompt.submit({ text: noticeText(news.lines) })
      }
    }
    seeded = true

    failures = 0
    if (!(await read($, stHerdrUp))) {
      await update($, stHerdrUp, () => true)
      $.ui.toast('herdr is reachable again')
    }
    if ((await read($, stLastError)) !== null) {
      await update($, stLastError, () => null)
    }
  } catch (error) {
    failures += 1
    await update($, stLastError, () => errorText(error))
    if (failures === 3) {
      await update($, stHerdrUp, () => false)
      $.ui.toast(`herdr not responding: ${errorText(error).slice(0, 80)}`)
    }
  } finally {
    ticking = false
  }
}

/** Coalescing reporter: the latest wanted state wins, sent off the dispatch. */
function want($: EngineInterface, state: 'working' | 'idle' | 'blocked'): void {
  desired = state
  later($, async () => {
    if (sending) {
      return
    }
    sending = true
    try {
      while (desired !== null && desired !== reported) {
        const next = desired
        await bridge($, 'report', { state: next, agent: 'claude' }).catch(() => {})
        reported = next
      }
    } finally {
      sending = false
    }
  })
}

function startPreview($: EngineInterface): void {
  previewTimer?.cancel()
  previewTimer = $.clock.every(4000, () => {
    refreshPreview($).catch(() => {})
  })
}

async function refreshPreview($: EngineInterface): Promise<void> {
  const g = await gateOf($)
  if (g.role !== 'commander') {
    return
  }
  const rows = await read($, stAgents)
  const working = rows.filter(row => !row.isSelf && row.status === 'working').length
  const blocked = rows.filter(row => !row.isSelf && row.status === 'blocked').length
  $.ui.status(`commander · ${working} working · ${blocked} blocked`)
  const target = await read($, stSelected)
  if (!target || !(await read($, stPaneOpen))) {
    return
  }
  if (!rows.some(row => row.paneId === target)) {
    await update($, stSelected, () => null)
    return
  }
  const at = await $.clock.now()
  try {
    const out = await bridge<{ pane_id: string; text: string }>($, 'read', { target, lines: 30 })
    await update($, stPreview, () => ({ paneId: out.pane_id, text: out.text, at }))
  } catch (error) {
    await update($, stPreview, () => ({ paneId: target, text: `(cannot read: ${errorText(error)})`, at }))
  }
}

/**
 * Reads the launcher registry (the bridge runs each launcher's choices
 * command) and registers an agent type per choice; herdr_worker_spawn's
 * description lists the launchers. In the background: a choices command may
 * take a while, and without it the plain worker types still work.
 */
async function loadLaunchers($: EngineInterface): Promise<void> {
  const out = await bridge<{ launchers: Launcher[] }>($, 'launchers', {}, false, 60000).catch(() => null)
  if (out) {
    await applyLaunchers($, out.launchers ?? [])
  }
}

/**
 * The bridge's last listing (it keeps one in the runtime folder): read at a
 * session's start, so its first turn has the types; loadLaunchers follows.
 */
async function cachedLaunchers($: EngineInterface): Promise<void> {
  try {
    const out = JSON.parse(String(await $.fs.read(`${runtimeRoot}/launchers.json`))) as { launchers?: Launcher[] }
    await applyLaunchers($, out.launchers ?? [])
  } catch {
    // none yet, or unreadable: loadLaunchers brings them
  }
}

async function applyLaunchers($: EngineInterface, list: Launcher[]): Promise<void> {
  launchers = list
  for (const spec of launchTypes(launchers)) {
    if (launchTypeOf.has(spec.type)) {
      continue
    }
    // Routed whether or not this registration goes through: after a reload the
    // name may be registered already, and the type must never run in-process.
    launchTypeOf.set(spec.type, spec)
    await $.agent.register({ name: spec.name, description: spec.description, prompt: AGENT_SPECS[0].prompt }).catch(() => null)
  }
  $.ui.invalidate('tool.describe')
}

async function registerSpawnTool($: EngineInterface, role: Role): Promise<void> {
  if (options.takeover && SPAWN_ROLES.includes(role) && !toolRegistered) {
    await $.tool.register({ name: SPAWN_TOOL.name, description: SPAWN_TOOL.description, inputSchema: SPAWN_TOOL.inputSchema })
    toolRegistered = true
  }
}

async function enterCommander($: EngineInterface): Promise<string> {
  const g = await gateOf($)
  if (!g.inHerdr) {
    return 'Not inside herdr; /commander does nothing here.'
  }
  if (g.role === 'worker') {
    return 'This pane is a herdr worker; a worker cannot become the commander.'
  }
  if (g.role !== 'commander') {
    const claim = await bridge<{ claimed: boolean; holder: { pane_id: string; kind: string } | null }>($, 'claim', { kind: 'claude' })
    if (!claim.claimed) {
      return `The commander of this workspace is ${claim.holder?.pane_id} (${claim.holder?.kind}); release it there first.`
    }
    await update($, stGate, () => ({ ...g, role: 'commander' as const }))
    await bridge($, 'metadata', { display_agent: 'claude · commander' }).catch(() => {})
    await $.store.set('lastRole', 'commander')
  }
  await update($, stPaneOpen, () => true)
  await $.ui.open({ id: PANE_ID_UI, title: 'Commander' })
  startPreview($)
  await ensurePolling($)
  return 'Commander on: the Commander pane lists the herdr agents. Write/Edit/NotebookEdit are blocked in this role; /commander off ends it.'
}

async function leaveCommander($: EngineInterface): Promise<string> {
  const g = await gateOf($)
  if (g.role !== 'commander') {
    return 'This pane is not the commander.'
  }
  await bridge($, 'release', {}).catch(() => {})
  await bridge($, 'metadata', { display_agent: null }).catch(() => {})
  await update($, stGate, () => ({ ...g, role: 'plain' as const }))
  await update($, stPaneOpen, () => false)
  previewTimer?.cancel()
  previewTimer = null
  await $.ui.close({ id: PANE_ID_UI })
  $.ui.status(undefined)
  await $.store.delete('lastRole')
  stopPolling()
  await ensurePolling($)
  return 'Commander off. Write/Edit work again.'
}

/** A panel button: the person pressed it, so the bridge gets --by-user. */
async function panelCall($: EngineInterface, command: string, args: Record<string, unknown>, done: string): Promise<void> {
  try {
    await bridge($, command, args, true)
    await update($, stNotice, () => done)
  } catch (error) {
    await update($, stNotice, () => errorText(error))
  }
}

async function interruptFromPanel($: EngineInterface, paneId: string, hard: boolean): Promise<void> {
  await update($, stPendingInterrupt, () => null)
  await panelCall($, 'interrupt', { target: paneId, hard }, `sent ${hard ? 'Ctrl+C' : 'Esc'} to ${paneId}`)
}

async function choose($: EngineInterface, paneId: string): Promise<void> {
  await update($, stSelected, () => paneId)
  await update($, stPendingInterrupt, () => null)
  await refreshPreview($)
}

export const register: Register = (on, rawOptions) => {
  options = readOptions(rawOptions)
  toolRegistered = false
  launchers = []
  launchTypeOf.clear()
  briefedRole = null

  // The one tool: a herdr worker in another folder ---------------------------------

  on('tool.call', { tool: /^mcp__herdr-commander__herdr_worker_spawn$/ }, async ($, e) => {
    const g = await gateOf($)
    const why = mayCreate(g, e.agentId)
    if (why) {
      return { deny: `herdr_worker_spawn: ${why}` }
    }
    const args = e as unknown as Record<string, unknown>
    const launcher = typeof args.launcher === 'string' && args.launcher !== '' ? args.launcher : undefined
    try {
      const out = await bridge<NewWorker>($, 'worker-new', {
        kind: args.kind ?? 'claude',
        cwd: args.cwd,
        task: args.task,
        name: args.name,
        description: typeof args.name === 'string' ? args.name : undefined,
        launcher,
        params: launcher ? args.params : undefined,
        // A launcher's worker is a different setup, so this session's own folder is fine for it.
        forbid_cwd: launcher ? undefined : await $.session.cwd(),
        from_session: await $.session.id(),
        permission_mode: permissionMode ?? undefined,
      })
      startWorker($, out.worker.herdr_id)
      await ensurePolling($)
      const result = { agentId: out.worker.herdr_id, outputFile: out.worker.output_file, cwd: out.worker.cwd, job_id: out.job.job_id, status: 'starting' }
      return { result: JSON.stringify(result, null, 2), context: [launchedContext(out)] }
    } catch (error) {
      return { deny: errorText(error) }
    }
  })

  // Its description lists the launchers (loadLaunchers; asked again after it).
  on('tool.describe', { tool: /^mcp__herdr-commander__herdr_worker_spawn$/ }, async ($, e, next) => {
    const base = await next(e)
    return launchers.length === 0 ? base : { ...base, description: spawnDescription(launchers) }
  })

  // Session start: the gate ------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    const pane = await envPane($)
    if (pane === null) {
      await update($, stGate, () => OFF_GATE)
      return next(e)
    }
    // A reload keeps $.state: a pane that was the commander stays one.
    const previous = await read($, stGate)
    const role: Role = previous.inHerdr && previous.paneId === pane.paneId && previous.role === 'commander' ? 'commander' : pane.role
    const g: Gate = { ...pane, role }
    await update($, stGate, () => g)
    runtimeRoot = runtimeRootOf({
      runtime: await $.env.get('HERDR_BRIDGE_RUNTIME'),
      localAppData: await $.env.get('LOCALAPPDATA'),
      home: await $.env.get('USERPROFILE'),
    })

    await registerSpawnTool($, role)
    if (options.takeover && role !== 'worker') {
      for (const spec of AGENT_SPECS) {
        await $.agent.register({ name: spec.name, description: spec.description, prompt: spec.prompt }).catch(() => null)
      }
      await cachedLaunchers($)
      later($, () => loadLaunchers($))
    }
    if (role !== 'worker') {
      await $.command.register({ name: 'commander', description: "herdr: become this workspace's commander and open the Commander pane (/commander off to stop)" })
    }
    if (role === 'commander') {
      startPreview($)
      await ensurePolling($)
    } else if (role !== 'worker' && (await $.store.get('lastRole')) === 'commander') {
      $.ui.status('herdr: /commander to resume the commander role')
    }
    if (options.lifecycleReport) {
      const sessionId = await $.session.id()
      later($, () => bridge($, 'report-session', { agent: 'claude', session_id: sessionId }))
    }
    if (role === 'worker') {
      keepReportingSession($)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    let g = await read($, stGate)
    const pane = await envPane($)
    if (!g.inHerdr && pane !== null) {
      // A conversation switched to and left before any hook took it up: the
      // pane is still this one (the lease, if it held one, frees itself once
      // this agent is gone).
      g = pane
      await update($, stGate, () => pane)
    }
    if (g.inHerdr) {
      stopPolling()
      stopReportingSession()
      previewTimer?.cancel()
      if (e.reason === 'clear' || e.reason === 'resume') {
        // The process goes on in another conversation (gateOf takes it up
        // there): the pane keeps its herdr state and lease, and that
        // conversation's model is briefed and its notices seeded afresh.
        briefedRole = null
        seeded = false
        return next(e)
      }
      if (options.lifecycleReport) {
        await bridge($, 'release-agent', { agent: 'claude' }, false, 8000).catch(() => {})
      }
      if (g.role === 'commander') {
        await bridge($, 'release', {}, false, 8000).catch(() => {})
      }
    }
    return next(e)
  })

  // Turns: this pane's state for herdr, and "this pane stopped" for its jobs -------

  // The herdr text rides on the prompt as context (the model reads it, the
  // person does not see it): a policy plugin may bypass a user plugin's
  // prompt.compose, as measured on 2026-10-05, so the system prompt alone is
  // not enough. A worker gets it with every prompt, since its work arrives as
  // plain messages; the other roles once per role.
  on('prompt.submit', async ($, e, next) => {
    const g = await gateOf($)
    if (!g.inHerdr) {
      return next(e)
    }
    // A prompt delivered into a running turn does not start a turn, but that
    // turn has taken it (the bridge's check that a turn covered a job).
    lastPromptAt = await $.clock.now()
    turnRunning = true
    if (e.turnId === undefined) {
      turnStartedAt = lastPromptAt
    }
    if (options.lifecycleReport) {
      want($, 'working')
    }
    if (g.role === 'worker' && sessionReported === null) {
      // The reports since its start have not got through (or gave up): once more.
      later($, () => reportSession($))
    }
    const brief = g.role === 'worker' || briefedRole !== g.role
    if (!brief) {
      return next(e)
    }
    briefedRole = g.role
    const notes = [envText(g.paneId, g.role, options.takeover), ...(g.role === 'commander' ? [ROLE_TEXT] : [])]
    return next({ ...e, context: [...(e.context ?? []), ...notes] })
  })

  // (A prompt this plugin submits does not pass its own prompt.submit hook: the
  // turn it starts is seen here.)
  on('turn.start', async ($, e, next) => {
    if (!e.agentId && (await envPane($)) !== null) {
      turnRunning = true
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const g = await gateOf($)
    if (g.inHerdr && !e.agentId) {
      turnRunning = false
      if (heldNotices.length > 0) {
        // The turn ended with no tool result to carry them: a prompt, as when idle.
        void $.prompt.submit({ text: noticeText(heldNotices.splice(0)) })
      }
      if (options.lifecycleReport) {
        want($, 'idle')
      }
      if (options.takeover) {
        // The final answer is the result of this pane's open job (the bridge
        // decides). It goes on stdin: it can be longer than a command line.
        const args = {
          ...(turnStartedAt === null ? {} : { started_at: turnStartedAt }),
          ...(lastPromptAt === null ? {} : { prompt_at: lastPromptAt }),
          reason: e.reason,
          aborted: e.isAborted,
        }
        const answer = e.answer
        later($, async () => {
          const out = await bridge<{ notice?: RelayNotice }>($, 'turn-end', args, false, 30000, { answer })
          // A Claude sender gets the result (or "stopped") as a cross-session message.
          await relay($, out.notice)
        })
      }
    }
    return done
  })

  if (options.lifecycleReport) {
    // Blocked only while a permission dialog is really up. (A tool.check "ask"
    // is not that: auto mode's classifier or a rule may settle it unseen.)
    on('classic.PermissionRequest', async ($, e, next) => {
      if ((await gateOf($)).inHerdr) {
        awaitingPermission = true
        want($, 'blocked')
      }
      return next(e)
    })
  }

  // Every tool call: dialogs block, the commander's own edits are refused,
  // PushNotification gets its herdr side. Registered first: the outer hook.
  on('tool.call', async ($, e, next) => {
    const g = await gateOf($)
    if (!g.inHerdr) {
      return next(e)
    }
    const tool = String(e.tool)
    if (g.role === 'commander' && (WRITE_TOOLS as readonly string[]).includes(tool)) {
      return { deny: 'herdr-commander: the commander does not edit files; give the change to a worker (Agent with subagent_type herdr-commander:claude-worker, or SendMessage to an existing one) or run /commander off.' }
    }
    const isDialog = options.lifecycleReport && (DIALOG_TOOLS as readonly string[]).includes(tool)
    if (isDialog) {
      want($, 'blocked')
    }
    const ran = await next(e)
    if (options.lifecycleReport && (isDialog || awaitingPermission)) {
      awaitingPermission = false
      want($, 'working')
    }
    if (ran.deny !== undefined) {
      return ran
    }
    if (tool === 'PushNotification' && options.pushNotificationMirror) {
      const message = String((e as unknown as { message?: string }).message ?? '')
      later($, () => bridge($, 'notify', { title: 'Claude', body: message, sound: 'request' }))
    }
    if (!e.agentId && heldNotices.length > 0) {
      // News that came while this turn runs: the model reads it after this
      // result, without waiting for the turn to end.
      const told = heldNotices.splice(0)
      return { ...ran, context: [...(ran.context ?? []), noticeText(told)] }
    }
    return ran
  })

  // Takeover: Claude's own tools through herdr (the `takeover` switch) ---------------

  if (options.takeover) {
    // Agent with a herdr worker type: a worker pane under a herdr id. Those
    // types never run in-process: when herdr cannot take them, the call is refused.
    on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
      const launch = launchTypeOf.get(e.subagent_type ?? '')
      const kind = launch ? 'claude' : herdrKind(e.subagent_type)
      const g = await gateOf($)
      if (!kind || !g.inHerdr) {
        return next(e)
      }
      const why = mayCreate(g, e.agentId)
      if (why) {
        return { deny: `${e.subagent_type} runs only as a herdr worker, and ${why}.` }
      }
      try {
        const out = await bridge<NewWorker>($, 'worker-new', {
          kind,
          name: e.name,
          cwd: await $.session.cwd(),
          task: e.prompt,
          model: e.model,
          subagent_type: e.subagent_type,
          description: e.description,
          launcher: launch?.launcher,
          params: launch?.params,
          // This session is where a Claude worker's messages come back (and its
          // mode the one the worker starts in, so those are not held for approval).
          from_session: await $.session.id(),
          permission_mode: permissionMode ?? undefined,
        })
        startWorker($, out.worker.herdr_id)
        await ensurePolling($)
        return {
          result: { status: 'async_launched' as const, agentId: out.worker.herdr_id, description: e.description, prompt: e.prompt, outputFile: out.worker.output_file, canReadOutputFile: true },
          context: [launchedContext(out)],
        }
      } catch (error) {
        return { deny: `herdr: ${errorText(error)}` }
      }
    })

    // SendMessage: a worker's reply to whoever gave it the job, or a message to a
    // herdr worker / agent / pane (a tracked job). Anything else is Claude's own.
    on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
      const g = await gateOf($)
      const to = typeof e.to === 'string' ? e.to : null
      if (!g.inHerdr || e.agentId || to === null || typeof e.message !== 'string' || e.message.trim() === '') {
        return next(e)
      }
      let out: RouteReply
      try {
        out = await bridge<RouteReply>($, 'route', { to, text: e.message, from_session: await $.session.id() })
      } catch (error) {
        return { deny: `herdr: ${errorText(error)}` }
      }
      if (out.action === 'none') {
        return next(e)
      }
      // A worker's report goes to its Claude sender as a cross-session message.
      const relayed = out.action === 'reply' ? await relay($, out.notice) : null
      // A message for a Claude worker goes the same way, now (after a send to
      // it that is already out, when there is one: that send's turn may take it).
      let delivery: Delivery | null = null
      const status = out.job?.status ?? ''
      if (out.action === 'message' && (status === 'pending' || status === 'sending')) {
        const sent = (await sendPending($).catch(() => [] as Sent[])).find(one => one.jobId === out.job?.job_id)
        delivery = !sent ? { state: status === 'sending' ? 'behind' : 'waiting' } : sent.delivered ? { state: 'delivered' } : { state: 'failed', reason: sent.reason }
        if (sent?.event !== undefined) {
          // Told in this result: not again as a notice.
          const told = sent.event
          await update($, stAnnounced, list => [...list, told].slice(-400))
        }
      }
      await ensurePolling($)
      const shown = sentText(out, delivery, relayed)
      return { result: { success: shown.success, message: shown.message }, context: [shown.context] }
    })

    // TaskStop of a herdr id (or the name / pane of a worker this pane started):
    // Ctrl+C and close the pane, without asking, as native TaskStop does.
    on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
      const g = await gateOf($)
      const id = String(e.task_id ?? e.shell_id ?? '')
      const workers = await read($, stWorkers)
      const ours = id.startsWith('herdr-') || PANE_ID.test(id) || workers.some(one => one.name === id || one.agentName === id)
      if (!g.inHerdr || e.agentId || !ours) {
        return next(e)
      }
      try {
        const out = await bridge<{ matched?: false; herdr_id?: string | null; pane_id?: string | null }>($, 'stop', { target: id })
        if (out.matched === false) {
          return next(e)
        }
        later($, () => runTick($))
        return { result: { message: `Stopped herdr worker ${out.herdr_id ?? out.pane_id} (Ctrl+C) and closed its pane${out.pane_id ? ` ${out.pane_id}` : ''}.`, task_id: id, task_type: 'herdr_agent' } }
      } catch (error) {
        return { deny: `herdr: ${errorText(error)}` }
      }
    })

    // ListAgents: native peers, then this pane's herdr workers and the other herdr panes.
    on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
      const ran = await next(e)
      const g = await gateOf($)
      if (!g.inHerdr || ran.deny !== undefined) {
        return ran
      }
      let extra: string
      try {
        const { rows, workerRows } = await absorb($, await bridge<Snapshot>($, 'snapshot', {}, false, 25000))
        const panesDir = (await read($, stPanesDir)) ?? `${runtimeRoot}/${g.workspaceId}/panes`
        extra = herdrListing(workerRows, rows, panesDir)
      } catch (error) {
        extra = `herdr agents unavailable: ${errorText(error)}`
      }
      const listing = (ran.result as { listing?: unknown } | undefined)?.listing
      if (typeof listing === 'string') {
        return { result: { ...(ran.result as object), listing: `${listing}\n\n${extra}` } as typeof ran.result, context: ran.context }
      }
      return { ...ran, context: [...(ran.context ?? []), extra] }
    })

    // Read of a runtime file: the bridge refreshes it first (a worker's output
    // gets its latest screen; a pane screen file is written), and it is allowed.
    on('tool.call', { tool: 'Read' }, async ($, e, next) => {
      const g = await gateOf($)
      if (g.inHerdr && typeof e.file_path === 'string' && isRuntimePath(e.file_path, runtimeRoot)) {
        await bridge($, 'refresh', { path: e.file_path }, false, 20000).catch(() => null)
      }
      return next(e)
    })

    on('tool.check', { tool: 'Read' }, async ($, e, next) => {
      const g = await gateOf($)
      const path = (e.input as { file_path?: unknown } | null)?.file_path
      if (g.inHerdr && typeof path === 'string' && isRuntimePath(path, runtimeRoot)) {
        return { decision: 'allow' as const, reason: 'herdr-commander runtime file (worker output, pane screen)' }
      }
      return next(e)
    })

    // A worker's main loop: a message another session's model sent it by
    // Claude's own cross-session messages (an answer to a notice's from=
    // address) went past the bridge. The bridge records it on its sender's job
    // before it is queued, with the time it arrived (when this turn may take it).
    on('session.receive', async ($, e, next) => {
      const g = await gateOf($)
      const peer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
      const ours = 'plugin' in e.origin && e.origin.plugin === 'herdr-commander'
      if (g.inHerdr && g.role === 'worker' && !e.agentId && peer && !ours && e.text.trim() !== '') {
        const receivedAt = await $.clock.now()
        await bridge($, 'peer-message', { received_at: receivedAt }, false, 15000, { text: e.text }).catch(() => null)
      }
      return next(e)
    })

    // $.session.send from other plugins follows the same rules as SendMessage.
    // This plugin's own sends (to a worker's or a sender's session) pass on.
    on('session.send', async ($, e, next) => {
      if (e.origin.kind === 'plugin' && e.origin.name === 'herdr-commander') {
        return next(e)
      }
      const g = await gateOf($)
      if (!g.inHerdr || e.agentId) {
        return next(e)
      }
      try {
        const out = await bridge<RouteReply>($, 'route', { to: e.to, text: e.text, from_session: await $.session.id() })
        if (out.action === 'none') {
          return next(e)
        }
        if (out.action === 'reply') {
          later($, () => relay($, out.notice))
        } else if (out.job?.status === 'pending') {
          later($, () => sendPending($))
        }
        await ensurePolling($)
        return { isDelivered: true as const }
      } catch (error) {
        return { isDelivered: false as const, reason: `herdr: ${errorText(error)}` }
      }
    })
  }

  // Prompt sections ------------------------------------------------------------------

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const g = await gateOf($)
    if (!g.inHerdr) {
      return composed
    }
    const extra = [{ id: 'herdr-commander:env', text: envText(g.paneId, g.role, options.takeover), scope: 'session' as const }]
    if (g.role === 'commander') {
      extra.push({ id: 'herdr-commander:role', text: ROLE_TEXT, scope: 'session' as const })
    }
    return { sections: [...composed.sections, ...extra] }
  })

  if (options.deliverFlow) {
    on('skill.prompt', { skill: 'deliver' }, async ($, e, next) => {
      const expanded = await next(e)
      return (await gateOf($)).inHerdr ? { ...expanded, text: `${expanded.text}\n${DELIVER_ADDENDUM}` } : expanded
    })
  }

  // /commander ------------------------------------------------------------------------





  on('command.run', { command: 'commander' }, async ($, e) => {
    const text = e.args.trim() === 'off' ? await leaveCommander($) : await enterCommander($)
    return { text }
  })

  on('ui.close', { id: PANE_ID_UI }, async ($, e, next) => {
    const closed = await next(e)
    await update($, stPaneOpen, () => false)
    stopPolling()
    await ensurePolling($)
    return closed
  })




  on('ui.render', { component: 'Pane', requestId: PANE_ID_UI }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const g = await read($, stGate)
    const rows = sortAgents(await read($, stAgents))
    const chosen = await read($, stSelected)
    const shown = await read($, stPreview)
    const pending = await read($, stPendingInterrupt)
    const up = await read($, stHerdrUp)
    const failure = await read($, stLastError)
    const holder = await read($, stLease)
    const jobs = (await read($, stJobs)).filter(job => job.from === g.paneId).slice(0, 5)
    const message = await read($, stNotice)
    const width = Math.max(30, e.props.bodyColumns)
    const narrow = width < 60
    const now = await $.clock.now()
    const blocked = rows.filter(row => row.status === 'blocked').length
    const current = rows.find(row => row.paneId === chosen) ?? null
    const groups = new Map<string, AgentRow[]>()
    for (const row of rows) {
      groups.set(row.workspaceId, [...(groups.get(row.workspaceId) ?? []), row])
    }
    const previewLines = shown && current && shown.paneId === current.paneId ? shown.text.split('\n').slice(narrow ? -5 : -12) : []
    const SelectEl = 'Select' in table ? table.Select : undefined
    const InputEl = 'Input' in table ? table.Input : undefined

    return (
      <Box flexDirection="column">
        <Text bold>
          {up ? 'herdr ok' : 'herdr not responding'} · {rows.length} agents · {blocked} blocked · lease {holder ?? 'none'}
        </Text>
        {!up && failure ? <Text color="red">{failure.slice(0, width)}</Text> : null}
        {rows.length === 0 ? <Text dimColor>No other agents in this herdr session.</Text> : null}
        {[...groups.entries()].map(([ws, members]) => (
          <Box key={`ws-${ws}`} flexDirection="column">
            <Text dimColor>
              {ws} {members[0]?.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''}
            </Text>
            {members.map(row => (
              <Text key={`row-${row.paneId}`} color={COLOR[row.status]} inverse={row.paneId === chosen} dimColor={!up}>
                {agentLine(row, width, now)}
              </Text>
            ))}
          </Box>
        ))}
        {SelectEl && rows.length > 0 ? (
          <SelectEl
            key="pick"
            label="agent"
            value={chosen ?? undefined}
            options={rows.map(row => ({ value: row.paneId, label: `${MARK[row.status]} ${row.paneId} ${row.kind}` }))}
            onSelect={value => {
              void choose($, value)
            }}
          />
        ) : null}
        {current ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>▸ {current.paneId} recent output</Text>
            {previewLines.length === 0 ? <Text dimColor>(loading…)</Text> : previewLines.map((text, index) => (
              <Text key={`pv-${index}`} wrap="truncate-end">
                {text}
              </Text>
            ))}
          </Box>
        ) : null}
        {jobs.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>my jobs</Text>
            {jobs.map(job => (
              <Text key={`job-${job.jobId}`} dimColor={job.status === 'completed'}>
                {job.status.padEnd(16)} → {job.to} {(job.summary || job.body.split('\n')[0] || '').slice(0, Math.max(10, width - 40))}
              </Text>
            ))}
          </Box>
        ) : null}
        {current && pending === current.paneId ? (
          <Box marginTop={1} gap={1}>
            <Text color="yellow">Interrupt {current.paneId} ({current.kind})?</Text>
            <Button key="confirm-esc" label="y Esc" hotkey="y" variant="primary" onPress={() => { void interruptFromPanel($, current.paneId, false) }} />
            <Button key="confirm-ctrlc" label="c Ctrl+C" hotkey="c" onPress={() => { void interruptFromPanel($, current.paneId, true) }} />
            <Button key="confirm-no" label="n cancel" hotkey="n" onPress={() => { void update($, stPendingInterrupt, () => null) }} />
          </Box>
        ) : null}
        <Box marginTop={1} gap={1}>
          <Button key="focus" label="f focus" hotkey="f" onPress={() => { if (current) void panelCall($, 'focus', { target: current.paneId }, `focused ${current.paneId}`) }} />
          <Button key="interrupt" label="x interrupt" hotkey="x" onPress={() => { if (current) void update($, stPendingInterrupt, () => current.paneId) }} />
          <Button key="refresh" label="r refresh" hotkey="r" onPress={() => { void refreshPreview($) }} />
        </Box>
        {InputEl && current ? (
          <InputEl
            key="prompt"
            label={`→ ${current.paneId} ${current.kind}`}
            placeholder="type a prompt for this agent, Enter sends"
            onSubmit={value => {
              if (value.trim() !== '') {
                void panelCall($, 'prompt', { target: current.paneId, text: value }, `sent to ${current.paneId}`)
              }
            }}
          />
        ) : null}
        {message ? <Text dimColor>{message}</Text> : null}
      </Box>
    )
  })
}
