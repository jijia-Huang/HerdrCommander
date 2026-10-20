// Every bridge operation. CLI and MCP both call these with a context:
//   { from: caller pane id, workspace: caller workspace id, role, byUser }
// `byUser` is set only by the Claude mod's panel buttons (a person pressed
// them); model-driven calls (MCP, the mod's tools) never set it.
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { runJson, runText } from './herdr.mjs'
import { BridgeError, CLI_PATH, CODEX_DIR, MCP_PATH, TOOL_ROOT, isInstalledCopy, runtimeRoot } from './paths.mjs'
import { Store, newId } from './store.mjs'

export const SOURCE = 'herdr-commander'
const PANE_ID = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/
const NAME = /^[a-z][a-z0-9_-]{0,31}$/
/**
 * queued: waiting for its worker; the others: the worker's one open job.
 * pending / sending / undeliverable are a Claude worker's job sent by Claude's
 * cross-session messages (queueSend): waiting for the sender's mod, being
 * sent, or not delivered (open until the sender resends or stops it).
 */
const ACTIVE_JOB = new Set(['queued', 'sent', 'delivery_unknown', 'pending', 'sending', 'undeliverable'])
const OPEN_JOB = new Set(['sent', 'delivery_unknown', 'pending', 'sending', 'undeliverable'])
/**
 * How long a running Claude worker may go without reporting its session before
 * its job is undeliverable. Counted from herdr seeing the process, well before
 * Claude has loaded its plugins: on a loaded machine (2026-10-20) that took
 * over 60 s, and the worker's mod keeps reporting for longer (register.tsx).
 */
const SESSION_WAIT_MS = 180000
/** How long a send the sender's mod took may go without its result before its job is undeliverable. */
const SEND_WAIT_MS = 60000
/** The permission modes Claude Code takes (`claude --permission-mode`). */
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
/** With a BOM: Windows PowerShell 5.1's Get-Content reads BOM-less files in the ANSI code page. */
const BOM = '﻿'

// Agents -------------------------------------------------------------------

export function normalizeAgent(raw) {
  return {
    pane_id: raw.pane_id,
    name: raw.name ?? raw.agent_name ?? null,
    kind: raw.agent ?? 'unknown',
    status: raw.agent_status ?? 'unknown',
    title: String(raw.terminal_title_stripped ?? raw.terminal_title ?? '').trim(),
    cwd: raw.cwd ?? '',
    workspace_id: raw.workspace_id ?? '',
    tab_id: raw.tab_id ?? '',
    focused: Boolean(raw.focused),
  }
}

async function rawAgents() {
  const result = await runJson(['agent', 'list'])
  return (result?.agents ?? []).map(normalizeAgent)
}

function storeFor(workspaceId) {
  return new Store(workspaceId)
}

/** Workspaces that have runtime data (job senders among them). */
function runtimeWorkspaces() {
  try {
    return readdirSync(runtimeRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name))
      .map(entry => entry.name)
  } catch {
    return []
  }
}

/**
 * The store that holds a job. A job lives in its sender's workspace, so a
 * worker in another workspace finds it by id; the assignee check still applies.
 */
function storeOfJob(preferred, jobId) {
  const own = storeFor(preferred)
  if (own.getJob(jobId)) {
    return own
  }
  for (const ws of runtimeWorkspaces()) {
    if (ws !== preferred && storeFor(ws).getJob(jobId)) {
      return storeFor(ws)
    }
  }
  return own
}

/** Agents plus what the bridge knows about each: role, current job, owned. */
export async function listAgents(ctx = {}) {
  const agents = await rawAgents()
  const workspaces = [...new Set(agents.map(one => one.workspace_id).filter(Boolean))]
  const info = new Map()
  for (const ws of workspaces) {
    const store = storeFor(ws)
    info.set(ws, { lease: store.getLease(), owned: store.getOwned() })
  }
  // A job sits in its sender's workspace, which may not be the worker's.
  const active = runtimeWorkspaces().flatMap(ws => storeFor(ws).listJobs()).filter(one => ACTIVE_JOB.has(one.status))
  return agents.map(agent => {
    const { lease, owned } = info.get(agent.workspace_id) ?? { lease: null, owned: [] }
    const job = active.find(one => one.to === agent.pane_id && OPEN_JOB.has(one.status)) ?? active.find(one => one.to === agent.pane_id) ?? null
    const own = owned.find(one => one.pane_id === agent.pane_id) ?? null
    return {
      ...agent,
      role: lease?.pane_id === agent.pane_id ? 'commander' : own ? 'worker' : 'plain',
      job_id: job?.job_id ?? null,
      owned_by: own?.owner ?? null,
      is_self: agent.pane_id === ctx.from,
    }
  })
}

async function resolveTarget(target) {
  if (typeof target !== 'string' || target === '') {
    throw new BridgeError('bad_target', 'target is required (pane id or agent name)')
  }
  const agents = await rawAgents()
  const agent = agents.find(one => one.pane_id === target || one.name === target) ?? null
  if (!agent && !PANE_ID.test(target)) {
    throw new BridgeError('no_target', `no agent or pane named ${target}`)
  }
  return { paneId: agent?.pane_id ?? target, agent }
}

function notSelf(ctx, paneId) {
  if (ctx.from && paneId === ctx.from) {
    throw new BridgeError('self_target', 'a caller cannot target its own pane')
  }
}

export async function read(ctx, { target, lines = 120 }) {
  const { paneId, agent } = await resolveTarget(target)
  const count = String(Math.max(1, Math.min(400, Number(lines) || 120)))
  const args = agent
    ? ['agent', 'read', paneId, '--source', 'recent-unwrapped', '--lines', count]
    : ['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', count]
  const text = await runText(args)
  return { pane_id: paneId, text: text.replace(/\s+$/, '') }
}

export async function explain(ctx, { target }) {
  const { paneId } = await resolveTarget(target)
  return { pane_id: paneId, text: (await runText(['agent', 'explain', paneId])).trim() }
}

export async function focus(ctx, { target }) {
  const { paneId } = await resolveTarget(target)
  await runJson(['agent', 'focus', paneId])
  return { pane_id: paneId, focused: true }
}

// Commander lease ------------------------------------------------------------

/**
 * A lease holder is alive while its pane still hosts an agent of the lease's
 * kind: a commander that exited leaves its shell pane behind, which must not
 * keep the lease.
 */
async function holderAlive(holder) {
  try {
    const pane = (await runJson(['pane', 'get', holder.pane_id]))?.pane
    if (!pane) {
      return false
    }
    return holder.kind && holder.kind !== 'unknown' ? pane.agent === holder.kind : true
  } catch {
    return false
  }
}

export function lease(ctx) {
  return { lease: storeFor(requireWorkspace(ctx)).getLease() }
}

export async function claim(ctx, { kind = ctx.kind ?? 'unknown' } = {}) {
  const ws = requireWorkspace(ctx)
  requireFrom(ctx)
  const store = storeFor(ws)
  const current = store.getLease()
  if (current && current.pane_id !== ctx.from && (await holderAlive(current))) {
    return { claimed: false, holder: current }
  }
  const next = { pane_id: ctx.from, kind, since: new Date().toISOString() }
  store.setLease(next)
  return { claimed: true, holder: next, replaced: current && current.pane_id !== ctx.from ? current : null }
}

export function release(ctx) {
  const store = storeFor(requireWorkspace(ctx))
  const current = store.getLease()
  if (current && current.pane_id === ctx.from) {
    store.clearLease()
    return { released: true }
  }
  return { released: false, holder: current }
}

function isCommander(ctx) {
  const current = storeFor(requireWorkspace(ctx)).getLease()
  return Boolean(current && current.pane_id === ctx.from)
}

function requireWorkspace(ctx) {
  if (!ctx.workspace) {
    throw new BridgeError('no_workspace', 'caller workspace is unknown (HERDR_WORKSPACE_ID)')
  }
  return ctx.workspace
}

function requireFrom(ctx) {
  if (!ctx.from) {
    throw new BridgeError('no_caller', 'caller pane is unknown (HERDR_PANE_ID)')
  }
  return ctx.from
}

// Jobs -------------------------------------------------------------------------
//
// A job is one piece of work between a sender (`from`) and a worker (`to`, a
// pane; while a herdr worker is still starting only its herdr id, `worker`).
// A worker has at most one open job (sent / delivery_unknown) at a time; the
// rest wait as `queued` and go out in order. Every decision here reads the
// bridge's records and herdr's pane state, never text a model wrote.
//
// Messages: `messages` holds what went either way after the task itself
// ({ seq, from: 'sender' | 'worker', text, at, delivered }); `events` is what
// the sender is told about ({ seq, type, at }): a worker message sent along
// the way, completed, stopped without an answer, stopped, cancelled, start
// failed or blocked. A Claude worker's final answer is a message too, but
// it arrives with `completed` (one notice), not as an event of its own.
//
// Between a Claude worker the bridge started and a Claude sender (its mod
// passes `from_session`, its own session id), nothing is typed: the bridge
// keeps what to send and to which session, and the mods send it with Claude
// Code's cross-session messages (a bridge process cannot) and report back.
// Sender → worker: queueSend, sendTake, sendDone. Worker → sender: turnEnd and
// reply mark their event `relay: 'sending'` and return it (notice), and
// relayDone records how it went; the sender's mod tells it itself only when
// that fails or takes too long.

function now() {
  return new Date().toISOString()
}

function nextSeq(job) {
  return (job.seq ?? 0) + 1
}

function withMessage(job, from, text) {
  const seq = nextSeq(job)
  return { ...job, seq, messages: [...(job.messages ?? []), { seq, from, text, at: now(), delivered: false }] }
}

function withEvent(job, type, extra = {}) {
  const seq = nextSeq(job)
  return { ...job, seq, events: [...(job.events ?? []), { seq, type, at: now(), ...extra }].slice(-60) }
}

/** Every job of every workspace with the store that holds it. */
function allJobs() {
  return runtimeWorkspaces().flatMap(ws => {
    const store = storeFor(ws)
    return store.listJobs().map(job => ({ store, job }))
  })
}

function isClaude(kind) {
  return kind === 'claude'
}

/** Claude worker jobs complete by the final answer of a turn; these carry the result in messages. */
function viaMessages(job) {
  return job.completed_via === 'message' || job.completed_via === 'answer'
}

/** The full task, with how to hand the result back, as the worker reads it from a file. */
export function jobTaskFile(job, followUps = []) {
  const extra = followUps.length === 0 ? [] : ['', '## More from the sender', '', ...followUps.map(one => one.text)]
  const finish = isClaude(job.to_kind)
    ? [
        `When you have the result, or need a decision, write it in your reply and end your turn: your final reply goes to ${job.from}, who gave you this job.`,
        'Put everything they need in it: what you changed, the commands you ran with their output, anything unresolved.',
        'A reply from them continues this same job. To report something along the way, you may also SendMessage to "main".',
      ]
    : [
        `Call the herdr_job_complete tool with job_id="${job.job_id}", a one-line \`summary\` and the full result as \`result\``,
        '(what you changed, the commands you ran with their output, anything unresolved); the bridge writes the result file.',
        '',
        `Only if you do not have that tool: write the result to \`${job.result_path}\`, first line exactly \`job_id: ${job.job_id}\`.`,
        '',
        'Do not answer only in the terminal; the commander reads the result file.',
      ]
  return [
    `# herdr job ${job.job_id}`,
    '',
    `From: ${job.from} (${job.kind})`,
    '',
    '## Task',
    '',
    job.body,
    ...extra,
    '',
    '## When you finish',
    '',
    ...finish,
  ].join('\n')
}

function preview(text, size = 160) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > size ? `${flat.slice(0, size)}…` : flat
}

/**
 * The single line typed into the worker's terminal. One line on purpose: a
 * multi-line paste loses its newlines (and sometimes its Enter) in some TUIs.
 */
export function jobPrompt(job) {
  const head = `[herdr-job ${job.job_id}] from ${job.from} (${job.kind}): ${preview(job.body)} -- Full task: ${job.task_path} .`
  if (isClaude(job.to_kind)) {
    return `${head} When done, write the result in your reply and end your turn: your final reply goes back to ${job.from}.`
  }
  return `${head} When done, call herdr_job_complete with job_id="${job.job_id}", a one-line summary and the full result text as "result". Without that tool, write the result to ${job.result_path} (first line "job_id: ${job.job_id}").`
}

function messageFile(job, pending) {
  return [`# herdr job ${job.job_id}: more from ${job.from}`, '', ...pending.map(one => one.text), ''].join('\n')
}

function messagePrompt(job, path, pending) {
  const head = `[herdr-job ${job.job_id}] more from ${job.from} on this same job: ${preview(pending.map(one => one.text).join(' '))} -- Full text: ${path} .`
  if (isClaude(job.to_kind)) {
    return `${head} Answer in your reply and end your turn: your final reply goes back to ${job.from}.`
  }
  return `${head} When done, call herdr_job_complete with job_id="${job.job_id}" again (a summary and the full result as "result").`
}

/**
 * Types the prompt and, for a Codex or Claude target, makes sure it was
 * submitted: a paste typed into a just-started agent sometimes keeps the text
 * and drops the Enter (seen with Codex, and on 2026-10-05 with a multi-line
 * task typed into a Claude worker that had just come up). When the pane does
 * not turn to working within ~4 s, one Enter follows; an Enter on an empty or
 * already-sent box does nothing.
 */
async function deliver(paneId, kind, text) {
  await runJson(['agent', 'prompt', paneId, text], { timeoutMs: 15000 })
  if (kind !== 'codex' && kind !== 'claude') {
    return { nudged: false }
  }
  for (let i = 0; i < 4; i += 1) {
    await new Promise(done => setTimeout(done, Number(process.env.HERDR_BRIDGE_NUDGE_MS ?? 1000)))
    const pane = await runJson(['pane', 'get', paneId]).catch(() => null)
    if (pane?.pane?.agent_status === 'working') {
      return { nudged: false }
    }
  }
  await runJson(['agent', 'send-keys', paneId, 'enter'])
  return { nudged: true }
}

/**
 * The most text typed straight into a pane. `herdr agent prompt` gets the text
 * as one command-line argument, and Windows caps a whole command line at
 * 32,767 UTF-16 code units: measured 2026-10-05, a 31,081-character prompt
 * reached a Claude worker whole, and 33,000 failed to start herdr with
 * ENAMETOOLONG. 30,000 (JavaScript string length, which counts UTF-16 code
 * units) leaves room for herdr's path and the other arguments.
 */
export const DIRECT_LIMIT = 30000

/**
 * The text as it is typed into a Claude worker, or null when it has to go
 * through a file instead: too long for one command line, a control character
 * the terminal would act on (newlines and tabs arrive intact, measured), or a
 * first character Claude Code reads as a command (`/`), shell (`!`) or
 * memory (`#`) line rather than as a message.
 */
export function directText(text) {
  const clean = String(text).replace(/\r\n?/g, '\n')
  if (clean.trim() === '' || clean.length > DIRECT_LIMIT) {
    return null
  }
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(clean) || /^\s*[/!#]/.test(clean)) {
    return null
  }
  return clean
}

/**
 * A job between a Claude worker the bridge started (a herdr worker record) and
 * a sender whose mod gave its Claude session: its messages go by Claude's
 * cross-session messages both ways. Codex workers, Codex senders and Claude
 * panes the bridge did not start keep the typed delivery.
 */
function crossSession(job, kind) {
  return Boolean(job.worker && job.from_session && isClaude(kind))
}

/** A Claude worker the bridge started: it gets its work as plain messages (its prompt says how to answer). */
function isClaudeWorker(job, paneId, kind) {
  if (!isClaude(kind)) {
    return false
  }
  return Boolean(job.worker) || runtimeWorkspaces().some(ws => storeFor(ws).getOwned().some(one => one.pane_id === paneId && one.kind === 'claude'))
}

/**
 * Hands a job's task (first time) or its undelivered sender messages to the
 * worker pane. A Claude worker gets the content itself, as a native message;
 * only text that cannot be typed safely (directText) goes by a file and a
 * one-line note. Others (Codex, or a Claude pane that is not a worker) get the
 * one-line `[herdr-job …]` note with the file, as before.
 */
async function deliverJob(store, job, paneId, kind) {
  // A first delivery goes out once, even when two bridge processes pump at once
  // (one waiting to be sent, or not delivered, is made again with what joined it).
  const fresh = store.getJob(job.job_id)
  if (!job.delivered_at && fresh && !['queued', 'pending', 'undeliverable'].includes(fresh.status)) {
    return fresh
  }
  if (crossSession(job, kind)) {
    return queueSend(store, { ...job, to: paneId, to_kind: kind })
  }
  const pending = (job.messages ?? []).filter(one => one.from === 'sender' && !one.delivered)
  const first = !job.delivered_at
  let text
  let next = { ...job, to: paneId, to_kind: kind }
  if (!first && pending.length === 0) {
    return job
  }
  const content = first ? [job.body, ...pending.map(one => one.text)].join('\n\n') : pending.map(one => one.text).join('\n\n')
  const direct = isClaudeWorker(job, paneId, kind) ? directText(content) : null
  if (first) {
    writeFileSync(next.task_path, `${BOM}${jobTaskFile(next, pending)}`, 'utf8')
    text = direct ?? jobPrompt(next)
  } else if (direct !== null) {
    text = direct
  } else {
    const path = join(store.tasksDir, `${job.job_id}-m${pending[pending.length - 1].seq}.md`)
    writeFileSync(path, `${BOM}${messageFile(next, pending)}`, 'utf8')
    text = messagePrompt(next, path, pending)
  }
  next = {
    ...next,
    delivered_as: direct !== null ? 'text' : 'file',
    delivered_at: now(),
    messages: (next.messages ?? []).map(one => (one.from === 'sender' ? { ...one, delivered: true } : one)),
  }
  try {
    const { nudged } = await deliver(paneId, kind, text)
    next.status = 'sent'
    next.nudged = nudged
    delete next.error
  } catch (error) {
    // The text may have reached the pane; never resend automatically.
    next.status = 'delivery_unknown'
    next.error = String(error.message ?? error)
  }
  store.putJob(next)
  writeWorkerOutput(next.worker)
  return next
}

function undelivered(job) {
  return (job.messages ?? []).filter(one => one.from === 'sender' && !one.delivered)
}

/**
 * A cross-session job's delivery: nothing is typed; the job waits as `pending`
 * with the text to send (`outbox`) until its sender's mod takes it (sendTake).
 * The text is the message itself, with no header: the task and any messages
 * that came with it the first time, the new messages after that. No length
 * limit and no task file: it never crosses a command line. While one send is
 * out (`sending`), what joins the job waits for it (sendDone queues it next).
 */
function queueSend(store, job) {
  if (job.status === 'sending') {
    return job
  }
  const pending = undelivered(job)
  const first = !job.delivered_at
  if (!first && pending.length === 0) {
    return job
  }
  const text = (first ? [job.body, ...pending.map(one => one.text)] : pending.map(one => one.text)).join('\n\n')
  const next = { ...job, status: 'pending', outbox: { id: newId('send'), text, seqs: pending.map(one => one.seq), at: now() } }
  delete next.error
  store.putJob(next)
  writeWorkerOutput(next.worker)
  return next
}

/** A cross-session job its worker did not get: open, with an event that says why (the sender decides what next). */
function markUndeliverable(store, job, reason) {
  const next = withEvent({ ...job, status: 'undeliverable', outbox: null, error: reason }, 'undeliverable', { note: reason })
  store.putJob(next)
  writeWorkerOutput(next.worker)
  return next
}

/**
 * The sender's mod takes what waits to be sent for its Claude workers: each of
 * its pending jobs whose worker has reported its Claude session. Taking
 * records the delivery (delivered_at now, the messages delivered, status
 * sending) before the send: the worker may take the message and end its turn
 * before the mod reports back, and turnEnd counts only a turn that took the
 * latest delivery. A worker running for SESSION_WAIT_MS without a session
 * makes its job undeliverable (`failed`), and so does a send taken
 * SEND_WAIT_MS ago whose result never came back (the mod that took it
 * stopped): it may or may not have arrived, so its delivery stays recorded
 * (an answer to it still completes the job) and the sender is told to check
 * the worker's output before sending again.
 */
export function sendTake(ctx) {
  requireFrom(ctx)
  const items = []
  const failed = []
  for (const { store, job } of allJobs().filter(({ job }) => job.from === ctx.from && (job.status === 'pending' || job.status === 'sending'))) {
    // Another process (a tick, the SendMessage hook) may have taken it a moment ago.
    const fresh = store.getJob(job.job_id)
    if (fresh?.status === 'sending' && fresh.outbox && Date.now() - Date.parse(fresh.outbox.taken_at ?? '') > SEND_WAIT_MS) {
      const output = fresh.worker ? findWorkerById(fresh.worker)?.worker.output_file : null
      const reason = `the result of sending it never came back, so the message may or may not have arrived; Read the worker's output file${output ? ` (${output})` : ''} before sending it again`
      const marked = markUndeliverable(store, fresh, reason)
      failed.push({ job_id: marked.job_id, reason, event: `${marked.job_id}#${marked.seq}` })
      continue
    }
    if (fresh?.status !== 'pending' || !fresh.outbox) {
      continue
    }
    const worker = fresh.worker ? findWorkerById(fresh.worker)?.worker ?? null : null
    const sessionId = worker?.session_id
    if (!sessionId) {
      const since = Date.parse(worker?.running_at ?? '')
      if (worker?.status === 'running' && Date.now() - since > SESSION_WAIT_MS) {
        const reason = `the Claude worker in pane ${worker.pane_id} has run for over ${SESSION_WAIT_MS / 1000} s without reporting its Claude session, so there is no session to send to (is herdr-commander loaded there, with takeover on?)`
        const marked = markUndeliverable(store, fresh, reason)
        failed.push({ job_id: marked.job_id, reason, event: `${marked.job_id}#${marked.seq}` })
      }
      continue
    }
    const seqs = fresh.outbox.seqs ?? []
    const taken = {
      ...fresh,
      status: 'sending',
      prior_delivered_at: fresh.delivered_at ?? null,
      delivered_at: now(),
      delivered_as: 'session',
      messages: (fresh.messages ?? []).map(one => (seqs.includes(one.seq) ? { ...one, delivered: true } : one)),
      outbox: { ...fresh.outbox, session_id: sessionId, taken_at: now() },
    }
    store.putJob(taken)
    writeWorkerOutput(taken.worker)
    items.push({ job_id: taken.job_id, send_id: taken.outbox.id, session_id: sessionId, text: taken.outbox.text, worker: taken.worker })
  }
  return { items, failed }
}

/**
 * The sender's mod reports a send it took. Delivered: the job is `sent` (and
 * what joined it meanwhile waits as the next send). Not delivered: the
 * delivery is withdrawn (delivered_at back, the messages undelivered) and the
 * job is `undeliverable` with an event naming the reason. Never typed into
 * the pane instead: the sender decides (send again, TaskStop, ask the person).
 */
export function sendDone(ctx, { job_id: jobId, send_id: sendId, delivered, reason } = {}) {
  requireFrom(ctx)
  const store = storeOfJob(requireWorkspace(ctx), String(jobId))
  const job = store.getJob(String(jobId))
  if (!job || job.from !== ctx.from) {
    throw new BridgeError('no_job', `no job ${jobId} of ${ctx.from}`)
  }
  if (job.status !== 'sending' || job.outbox?.id !== sendId) {
    // It moved on meanwhile (completed by the worker's answer, stopped).
    return { job, stale: true }
  }
  if (delivered === true) {
    let next = { ...job, status: 'sent', outbox: null }
    delete next.prior_delivered_at
    delete next.error
    store.putJob(next)
    next = queueSend(store, next)
    writeWorkerOutput(next.worker)
    return { job: next, delivered: true }
  }
  const seqs = job.outbox?.seqs ?? []
  const withdrawn = {
    ...job,
    messages: (job.messages ?? []).map(one => (seqs.includes(one.seq) ? { ...one, delivered: false } : one)),
  }
  if (job.prior_delivered_at) {
    withdrawn.delivered_at = job.prior_delivered_at
  } else {
    delete withdrawn.delivered_at
    delete withdrawn.delivered_as
  }
  delete withdrawn.prior_delivered_at
  const next = markUndeliverable(store, withdrawn, String(reason || 'not delivered'))
  return { job: next, delivered: false, event: `${next.job_id}#${next.seq}` }
}

/** The event mark of a worker → sender notice its own mod sends by Claude's cross-session messages. */
function relayMark(job) {
  return crossSession(job, job.to_kind) ? { relay: 'sending', relay_at: now() } : {}
}

/** What a worker's mod sends to the sender for an event marked relay: the data (the mod writes the text). */
function noticeOf(job, seq) {
  const event = (job.events ?? []).find(one => one.seq === seq)
  if (!event || event.relay !== 'sending') {
    return undefined
  }
  const worker = job.worker ? findWorkerById(job.worker)?.worker ?? null : null
  return { session_id: job.from_session, event_seq: seq, job, worker: worker ? { ...worker, job: OPEN_JOB.has(job.status) ? job.job_id : null, queued: 0 } : null }
}

/** The worker's mod reports a notice it sent (or could not): the sender's mod tells it itself when not. */
export function relayDone(ctx, { job_id: jobId, event_seq: eventSeq, delivered, reason } = {}) {
  requireFrom(ctx)
  const store = storeOfJob(requireWorkspace(ctx), String(jobId))
  const job = store.getJob(String(jobId))
  if (!job || job.to !== ctx.from) {
    throw new BridgeError('no_job', `no job ${jobId} sent to ${ctx.from}`)
  }
  const ok = delivered === true
  const events = (job.events ?? []).map(one => (one.seq === Number(eventSeq) && one.relay === 'sending'
    ? { ...one, relay: ok ? 'sent' : 'failed', relay_at: now(), ...(ok ? {} : { relay_error: String(reason || 'not delivered') }) }
    : one))
  store.putJob({ ...job, events })
  return { relayed: ok }
}

/**
 * A Claude worker tells the bridge its Claude session (at its start, and again
 * in a new conversation after /clear or /resume): the address its work is
 * sent to. Recorded on the live herdr worker of this pane.
 */
export function workerSession(ctx, { session_id: sessionId } = {}) {
  requireFrom(ctx)
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new BridgeError('bad_session', 'session_id is required')
  }
  const hit = findWorker(one => one.pane_id === ctx.from && liveWorker(one))
  if (!hit) {
    return { recorded: false }
  }
  hit.store.putWorker({ ...hit.store.getWorker(hit.worker.herdr_id), session_id: sessionId, session_at: now() })
  return { recorded: true, herdr_id: hit.worker.herdr_id }
}

/**
 * A message another session's model sent this Claude worker by Claude's own
 * cross-session messages, past the bridge (the sender answered a notice's
 * `from=` address itself). The worker's mod reports it as it arrives, with
 * the time it did (`received_at`, ms). It is taken as from the worker's
 * owner, already delivered: added to the owner's open job, else the owner's
 * latest completed job reopens with it (its result kept, keepResult), else
 * nothing. The delivery time is the arrival, not now: the turn that takes it
 * began then, and turnEnd counts a turn only from its delivery on.
 */
export function peerMessage(ctx, { text, received_at: receivedAt, from_session: fromSession } = {}) {
  requireFrom(ctx)
  if (typeof text !== 'string' || text.trim() === '') {
    throw new BridgeError('bad_body', 'text is required')
  }
  const hit = findWorker(one => one.pane_id === ctx.from && liveWorker(one))
  if (!hit) {
    return { recorded: false }
  }
  const { worker } = hit
  const mine = jobsFor({ worker, paneId: ctx.from }).filter(({ job }) => job.from === worker.owner)
  const open = mine.filter(({ job }) => OPEN_JOB.has(job.status)).sort((a, b) => String(b.job.delivered_at ?? '').localeCompare(String(a.job.delivered_at ?? '')))[0]
  const last = mine.filter(({ job }) => job.status === 'completed').sort((a, b) => String(b.job.completed_at).localeCompare(String(a.job.completed_at)))[0]
  // A job of the owner still queued behind another sender's: not this worker's to take yet.
  if (!open && (!last || mine.some(({ job }) => job.status === 'queued'))) {
    return { recorded: false }
  }
  const held = open ?? { store: last.store, job: { ...keepResult(last.store, last.job), status: 'sent', outbox: null } }
  const at = Number.isFinite(Number(receivedAt)) ? new Date(Number(receivedAt)).toISOString() : now()
  let job = withMessage(held.job, 'sender', text)
  job = {
    ...job,
    to: ctx.from,
    messages: job.messages.map(one => (one.seq === job.seq ? { ...one, at, delivered: true } : one)),
    delivered_at: at,
    delivered_as: 'peer',
    ...(typeof fromSession === 'string' && fromSession !== '' ? { from_session: fromSession } : {}),
  }
  held.store.putJob(job)
  writeWorkerOutput(job.worker)
  return { recorded: true, job_id: job.job_id, how: open ? 'appended' : 'reopened' }
}

// Recipients ------------------------------------------------------------------

function liveWorker(worker) {
  return !['stopped', 'failed'].includes(worker.status)
}

/** A herdr worker record anywhere, newest first. */
function findWorker(predicate) {
  for (const ws of runtimeWorkspaces()) {
    const store = storeFor(ws)
    const worker = store.listWorkers().find(predicate)
    if (worker) {
      return { store, worker }
    }
  }
  return null
}

function findWorkerById(id) {
  return findWorker(one => one.herdr_id === id)
}

/** Who a job goes to: its herdr worker (when it has one) and its pane. */
function targetOfJob(job) {
  const hit = job.worker ? findWorkerById(job.worker) : findWorker(one => one.pane_id === job.to && liveWorker(one))
  return { worker: hit?.worker ?? null, paneId: hit?.worker.pane_id || job.to || '', kind: hit?.worker.worker_kind ?? job.to_kind ?? 'unknown' }
}

/**
 * Resolves a SendMessage / TaskStop recipient: a herdr id, the name it was
 * started with, its herdr agent name or pane id; then any herdr agent by pane
 * id or name. Null when nothing matches (the caller hands it to Claude).
 */
async function resolveRecipient(ctx, to) {
  const name = String(to ?? '')
  if (name === '') {
    return null
  }
  let hit = name.startsWith('herdr-') ? findWorkerById(name) : null
  if (!hit && ctx.workspace) {
    const store = storeFor(ctx.workspace)
    const worker = store.listWorkers().find(one => one.owner === ctx.from && liveWorker(one) && (one.name === name || one.agent_name === name || one.pane_id === name))
    hit = worker ? { store, worker } : null
  }
  if (hit) {
    return { worker: hit.worker, store: hit.store, paneId: hit.worker.pane_id ?? '', kind: hit.worker.worker_kind, agent: null }
  }
  if (name.startsWith('herdr-')) {
    return null
  }
  const agents = await rawAgents()
  const agent = agents.find(one => one.pane_id === name || one.name === name) ?? null
  if (!agent && !PANE_ID.test(name)) {
    return null
  }
  const paneId = agent?.pane_id ?? name
  const rec = findWorker(one => one.pane_id === paneId && liveWorker(one))
  return { worker: rec?.worker ?? null, store: rec?.store ?? null, paneId, kind: agent?.kind ?? rec?.worker.worker_kind ?? 'unknown', agent }
}

function jobsFor(target) {
  return allJobs().filter(({ job }) => (target.worker && job.worker === target.worker.herdr_id) || (target.paneId !== '' && job.to === target.paneId))
}

function queuedAt(job) {
  return String(job.queued_at ?? job.created_at)
}

/** Delivers the oldest queued job of a worker that has no open job and is up. */
async function pump(target) {
  if (!target.paneId || (target.worker && target.worker.status !== 'running')) {
    return null
  }
  const list = jobsFor(target)
  if (list.some(({ job }) => OPEN_JOB.has(job.status))) {
    return null
  }
  const next = list.filter(({ job }) => job.status === 'queued').sort((a, b) => queuedAt(a.job).localeCompare(queuedAt(b.job)))[0]
  if (!next) {
    return null
  }
  return deliverJob(next.store, next.job, target.paneId, target.kind)
}

// Sending: sender → worker ------------------------------------------------------

/**
 * A completed job made ready to reopen. Its result file goes out of the way
 * (the result header would complete it again at once), but nothing is lost:
 * the file is renamed to `<job>.round<n>.md`, and a result handed in by tool
 * or file (not already one of the worker's messages) joins the messages.
 */
function keepResult(store, job) {
  const round = (job.reopened ?? 0) + 1
  const own = store.resultPath(job.job_id)
  let next = { ...job, status: 'queued', queued_at: now(), result_path: own, reminded_at: null, woken: null, reopened: round }
  if (!viaMessages(job) && job.result_path && existsSync(job.result_path)) {
    const text = readFileSync(job.result_path, 'utf8').replace(/^\uFEFF?job_id:[^\n]*\n+/, '').trim()
    if (text !== '') {
      next = withMessage(next, 'worker', `(result of round ${round}, ${job.result_path})\n\n${text}`)
      next = { ...next, messages: next.messages.map(one => (one.seq === next.seq ? { ...one, delivered: true } : one)) }
    }
  }
  if (existsSync(own)) {
    renameSync(own, join(store.resultsDir, `${job.job_id}.round${round}.md`))
  }
  return next
}

/**
 * A message from a sender to a worker. A job this sender has open (or queued)
 * with the worker takes it in and gets it now; else the sender's latest
 * completed job with the worker reopens; else a new job. A worker busy with
 * another sender's job gets it after that job (queued).
 */
export async function message(ctx, { to, text, kind = 'task', from_session: fromSession }) {
  requireFrom(ctx)
  const ws = requireWorkspace(ctx)
  if (typeof text !== 'string' || text.trim() === '') {
    throw new BridgeError('bad_body', 'body is required')
  }
  if (!['task', 'question'].includes(kind)) {
    throw new BridgeError('bad_kind', 'kind must be task or question')
  }
  const target = await resolveRecipient(ctx, to)
  if (!target) {
    throw new BridgeError('no_target', `no herdr worker, agent or pane named ${to}`)
  }
  if (target.paneId) {
    notSelf(ctx, target.paneId)
  }
  if (!target.worker && target.agent) {
    const targetLease = storeFor(target.agent.workspace_id).getLease()
    if (targetLease && targetLease.pane_id === target.paneId) {
      throw new BridgeError('target_is_commander', `${target.paneId} is a commander; commanders do not take jobs`)
    }
  }
  if (target.worker && !liveWorker(target.worker)) {
    throw new BridgeError('worker_gone', `${target.worker.herdr_id} is ${target.worker.status}`)
  }
  // The sender's latest Claude session (it may have switched conversations since).
  const sender = job => (typeof fromSession === 'string' && fromSession !== '' ? { ...job, from_session: fromSession } : job)
  const list = jobsFor(target)
  const mine = list.filter(({ job }) => job.from === ctx.from)
  const active = mine.find(({ job }) => ACTIVE_JOB.has(job.status))
  if (active) {
    let job = sender(withMessage(active.job, 'sender', text))
    active.store.putJob(job)
    if (OPEN_JOB.has(job.status)) {
      job = await deliverJob(active.store, job, target.paneId, target.kind)
    }
    writeWorkerOutput(job.worker)
    return { job, action: 'appended', ahead: 0 }
  }
  const last = mine.filter(({ job }) => job.status === 'completed').sort((a, b) => String(b.job.completed_at).localeCompare(String(a.job.completed_at)))[0]
  let held
  let action
  if (last) {
    held = { store: last.store, job: sender(withMessage(keepResult(last.store, last.job), 'sender', text)) }
    action = 'reopened'
  } else {
    const store = storeFor(ws)
    const jobId = newId('job')
    held = {
      store,
      job: sender({
        job_id: jobId,
        workspace_id: ws,
        from: ctx.from,
        to: target.paneId,
        worker: target.worker?.herdr_id ?? null,
        to_kind: target.kind,
        kind,
        body: text,
        result_path: store.resultPath(jobId),
        task_path: store.taskPath(jobId),
        status: 'queued',
        review: 'pending',
        messages: [],
        events: [],
        seq: 0,
        created_at: now(),
        queued_at: now(),
      }),
    }
    action = 'new'
  }
  held.store.putJob(held.job)
  const ahead = list.filter(({ job }) => job.job_id !== held.job.job_id && ACTIVE_JOB.has(job.status)).length
  const delivered = await pump(target)
  const job = delivered?.job_id === held.job.job_id ? delivered : held.store.getJob(held.job.job_id)
  writeWorkerOutput(job.worker)
  return { job, action, ahead: job.status === 'queued' ? ahead : 0 }
}

/** The Codex MCP tool and older callers: a task or question as a tracked job. */
export async function send(ctx, { target, kind = 'task', body }) {
  if (typeof target !== 'string' || target === '') {
    throw new BridgeError('bad_target', 'target is required (pane id or agent name)')
  }
  return message(ctx, { to: target, text: body, kind })
}

// Replying: worker → sender ------------------------------------------------------

/**
 * A SendMessage from a pane that has jobs: to "main" goes to the sender of its
 * open job (else of its latest job); to a sender's pane id or name goes to
 * that sender. Passed on whole, whatever it says, as a report along the way:
 * it does not complete the job (the final answer of the turn does).
 * `routed: false` when this pane has no such job. On a cross-session job the
 * `notice` is for the worker's mod to send (relayDone).
 */
export async function reply(ctx, { to, text }) {
  requireFrom(ctx)
  if (typeof text !== 'string' || text.trim() === '') {
    throw new BridgeError('bad_body', 'message is required')
  }
  const mine = allJobs().filter(({ job }) => job.to === ctx.from && job.status !== 'queued')
  if (mine.length === 0) {
    return { routed: false }
  }
  let candidates = mine
  if (to !== 'main') {
    let senderPane = String(to)
    if (!PANE_ID.test(senderPane)) {
      const agents = await rawAgents().catch(() => [])
      senderPane = agents.find(one => one.name === senderPane)?.pane_id ?? senderPane
    }
    candidates = mine.filter(({ job }) => job.from === senderPane)
  }
  if (candidates.length === 0) {
    return { routed: false }
  }
  const latest = (list, key) => list.slice().sort((a, b) => String(b.job[key] ?? '').localeCompare(String(a.job[key] ?? '')))[0]
  const open = candidates.filter(({ job }) => OPEN_JOB.has(job.status))
  const hit = open.length > 0 ? latest(open, 'delivered_at') : latest(candidates, 'updated_at')
  const isOpen = OPEN_JOB.has(hit.job.status)
  let job = withWorkerText(hit.job, text)
  job = withEvent(job, 'message', { message_seq: job.seq, ...relayMark(job) })
  hit.store.putJob(job)
  writeWorkerOutput(job.worker)
  return { routed: true, job_id: job.job_id, to: job.from, open: isOpen, notice: noticeOf(job, job.seq) }
}

/** A worker's text, already passed on to the sender, as one of the job's messages. */
function withWorkerText(job, text) {
  const next = withMessage(job, 'worker', text)
  return { ...next, messages: next.messages.map(one => (one.seq === next.seq ? { ...one, delivered: true } : one)) }
}

/**
 * The worker pane's main-loop turn ended (its own mod says so, with what the
 * engine reports: `reason`, `aborted`, and the turn's final `answer`, which
 * comes on stdin since it can be longer than a command line). For this pane's
 * open job, when the turn covered it:
 * - ended with an answer (reason "answer", not aborted, not empty): the answer
 *   is the worker's message and the job completes; the sender gets one notice;
 * - aborted, refused, errored or empty: the sender is told once that it
 *   stopped without an answer; the job stays open.
 * No open job (it completed, or the person typed in the worker's pane): nothing.
 *
 * A turn covers the job when the job's latest delivery came in as a prompt of
 * that turn: `prompt_at` (the last prompt the turn took, a message delivered
 * into the running turn included) or else `started_at` is not before it. A
 * turn that began earlier and never took it says nothing about the job, nor
 * does one while a newer delivery still waits to be sent (pending) or none
 * reached the worker at all.
 *
 * On a cross-session job the event is marked relay and returned as `notice`:
 * the worker's mod sends it to the sender and reports (relayDone).
 */
export async function turnEnd(ctx, { started_at: startedAt, prompt_at: promptAt, reason, aborted, answer } = {}) {
  requireFrom(ctx)
  const open = allJobs()
    .filter(({ job }) => job.to === ctx.from && OPEN_JOB.has(job.status))
    .sort((a, b) => String(b.job.delivered_at ?? '').localeCompare(String(a.job.delivered_at ?? '')))[0]
  if (!open) {
    return { job: null }
  }
  const { store } = open
  let job = open.job
  if (job.status === 'pending' || !job.delivered_at) {
    return { job }
  }
  const at = typeof promptAt === 'number' ? promptAt : typeof startedAt === 'number' ? startedAt : null
  const coversJob = at === null || new Date(at).toISOString() >= job.delivered_at
  if (!coversJob) {
    return { job }
  }
  const text = typeof answer === 'string' ? answer : ''
  if (reason === 'answer' && aborted !== true && text.trim() !== '') {
    job = withWorkerText(job, text)
    job = await finishJob(store, { ...job, completed_via: 'answer', answer_seq: job.seq }, relayMark(job))
    const event = job.events.findLast(one => one.type === 'completed')
    return { job, completed: true, notice: event ? noticeOf(job, event.seq) : undefined }
  }
  if (!(job.reminded_at && job.reminded_at >= job.delivered_at)) {
    job = withEvent({ ...job, reminded_at: now() }, 'stopped_without_answer', { reason: typeof reason === 'string' ? reason : 'unknown', ...relayMark(job) })
    store.putJob(job)
    return { job, reminded: true, notice: noticeOf(job, job.seq) }
  }
  return { job }
}

/** Marks a job completed (any route) and runs what follows once; `mark` joins its completed event. */
async function finishJob(store, job, mark = {}) {
  // Another bridge process may have finished it a moment ago: finish once.
  const fresh = store.getJob(job.job_id)
  if (fresh && !OPEN_JOB.has(fresh.status)) {
    return fresh
  }
  const done = { ...job, status: 'completed', completed_at: now() }
  if (viaMessages(job)) {
    const sent = (job.messages ?? []).filter(one => one.from === 'worker')
    const last = sent[sent.length - 1]
    done.summary = String(last?.text ?? '').split(/\r?\n/).find(line => line.trim() !== '')?.trim().slice(0, 200) ?? ''
    writeFileSync(job.result_path, `job_id: ${job.job_id}\n\n${sent.map(one => one.text).join('\n\n---\n\n')}\n`, 'utf8')
  }
  const marked = withEvent(done, 'completed', { via: job.completed_via, ...(job.answer_seq ? { message_seq: job.answer_seq } : {}), ...mark })
  delete marked.answer_seq
  store.putJob(marked)
  const out = await onCompleted(store, marked)
  writeWorkerOutput(out.worker)
  await pump(targetOfJob(out)).catch(() => null)
  return out
}

/** A plain prompt typed by the person from the Commander panel (no job). */
export async function promptRaw(ctx, { target, text }) {
  if (!ctx.byUser) {
    throw new BridgeError('not_user', 'raw prompts are for the panel; models use send (jobs)')
  }
  const { paneId, agent } = await resolveTarget(target)
  notSelf(ctx, paneId)
  const { nudged } = await deliver(paneId, agent?.kind ?? 'unknown', String(text))
  return { pane_id: paneId, sent: true, nudged }
}

function readResultHeader(path) {
  if (!path || !existsSync(path)) {
    return null
  }
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/)
  const match = /^job_id:\s*(\S+)/.exec(lines[0] ?? '')
  const summary = lines.slice(1).map(line => line.trim()).find(line => line !== '') ?? ''
  return { jobId: match?.[1] ?? null, summary }
}

/** Marks a job whose result file has appeared (with the right header) completed. */
async function reconcile(store, job) {
  if (!OPEN_JOB.has(job.status)) {
    return job
  }
  const header = readResultHeader(job.result_path)
  if (header && header.jobId === job.job_id) {
    return finishJob(store, { ...job, summary: job.summary ?? header.summary, completed_via: 'result_file' })
  }
  return job
}

export async function jobGet(ctx, { job_id: jobId, limit = 20 } = {}) {
  const store = storeFor(requireWorkspace(ctx))
  if (jobId) {
    const job = store.getJob(jobId)
    if (!job) {
      throw new BridgeError('no_job', `no job ${jobId}`)
    }
    return { job: await reconcile(store, job) }
  }
  const recent = store.listJobs().slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
  return { jobs: await Promise.all(recent.map(job => reconcile(store, job))) }
}

export async function jobComplete(ctx, { job_id: jobId, summary = '', result, result_path: resultPath }) {
  const store = storeOfJob(requireWorkspace(ctx), String(jobId))
  const job = store.getJob(String(jobId))
  if (!job) {
    throw new BridgeError('no_job', `no job ${jobId}`)
  }
  if (ctx.from && job.to !== ctx.from) {
    throw new BridgeError('not_assignee', `job ${jobId} was sent to ${job.to}, not ${ctx.from}`)
  }
  if (job.status === 'completed') {
    return { job: await tryWake(store, job), accepted: true, already: true }
  }
  // A worker in another repository may not be allowed to write under the
  // bridge's runtime folder: it hands the text over and the bridge writes it.
  const hasText = typeof result === 'string' && result.trim() !== ''
  if (hasText) {
    writeFileSync(job.result_path, `job_id: ${job.job_id}\n\n${result}\n`, 'utf8')
  }
  const path = resultPath && !hasText ? (isAbsolute(resultPath) ? resultPath : resolve(resultPath)) : job.result_path
  if (!existsSync(path)) {
    throw new BridgeError('no_result', `pass the full result as "result", or write it to ${job.result_path} first`)
  }
  const done = await finishJob(store, { ...job, summary: String(summary).slice(0, 500), result_path: path, completed_via: 'tool' })
  return { job: done, accepted: true }
}

/** Runs once, at the moment a job becomes completed (by tool, result file or message). */
async function onCompleted(store, job) {
  await notify({}, { title: `job done: ${job.to}`, body: job.summary || job.job_id, sound: 'done' }).catch(() => {})
  return tryWake(store, job)
}

/**
 * Tells the job's sender it finished, once (`woken`). A Claude sender's mod
 * polls jobs and wakes itself, so only other senders get a terminal prompt,
 * and only while idle; a busy one is retried later by wakePending (the Codex
 * commander's MCP server and its dashboard call it).
 */
export async function tryWake(store, job) {
  if (job.status !== 'completed' || job.woken) {
    return job
  }
  const settle = woken => {
    const next = { ...store.getJob(job.job_id), woken }
    store.putJob(next)
    return next
  }
  const agents = await rawAgents().catch(() => null)
  if (!agents) {
    return job
  }
  const sender = agents.find(one => one.pane_id === job.from) ?? null
  if (!sender) {
    return settle('sender_gone')
  }
  if (sender.kind === 'claude') {
    return settle('mod')
  }
  if (sender.status !== 'idle' && sender.status !== 'done') {
    return job
  }
  try {
    await deliver(job.from, sender.kind, `[herdr-bridge] job ${job.job_id} completed by ${job.to}: ${(job.summary || '(no summary)').replace(/\s+/g, ' ')} -- read it with herdr_job_get.`)
    return settle('prompt')
  } catch {
    return job
  }
}

/** Retries the wake of every completed job this pane sent that has not woken it yet. */
export async function wakePending(ctx) {
  const store = storeFor(requireWorkspace(ctx))
  for (const job of store.listJobs().filter(one => one.from === ctx.from && OPEN_JOB.has(one.status))) {
    await reconcile(store, job).catch(() => null)
  }
  const pending = store.listJobs().filter(job => job.from === ctx.from && job.status === 'completed' && !job.woken)
  let woken = 0
  for (const job of pending) {
    if ((await tryWake(store, job)).woken) {
      woken += 1
    }
  }
  return { tried: pending.length, woken }
}

export async function interrupt(ctx, { target, hard = false }) {
  const { paneId } = await resolveTarget(target)
  notSelf(ctx, paneId)
  if (!ctx.byUser) {
    const store = storeFor(requireWorkspace(ctx))
    const managed = store.isOwned(paneId) || store.listJobs().some(job => job.from === ctx.from && job.to === paneId && ACTIVE_JOB.has(job.status))
    if (!managed) {
      throw new BridgeError('not_managed', `${paneId} is not a pane or job you manage; ask the person to interrupt it`)
    }
  }
  await runJson(['agent', 'send-keys', paneId, hard ? 'ctrl+c' : 'esc'])
  return { pane_id: paneId, sent: hard ? 'ctrl+c' : 'esc' }
}

// Workers ------------------------------------------------------------------------

function workerName(name, kind) {
  const base = String(name || `${kind}-worker`).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z]+/, '')
  const clipped = (base || 'worker').slice(0, 24)
  const candidate = `${clipped}-${Math.random().toString(36).slice(2, 6)}`
  return NAME.test(candidate) ? candidate : `worker-${Math.random().toString(36).slice(2, 6)}`
}

/** A herdr id: `herdr-<kind>-<workspace>-<6 hex>`; no pane, which is known only after the split. */
export function newHerdrId(kind, workspace) {
  return `herdr-${kind}-${workspace}-${randomBytes(3).toString('hex')}`
}

/**
 * The command that starts a Claude worker with this same plugin: the installed
 * copy loads by itself; a working copy goes by --plugin-dir, which also takes
 * precedence over an installed copy of the same name. `permissionMode`: the
 * sender's mode, so the two sessions' cross-session messages are not held for
 * the person's approval (they are when the modes differ).
 */
export function claudeLine(root = TOOL_ROOT, { model, permissionMode } = {}) {
  const parts = [isInstalledCopy(root) ? 'claude' : `claude --plugin-dir '${root}'`]
  if (model && /^[A-Za-z0-9._-]+$/.test(model)) {
    parts.push(`--model ${model}`)
  }
  if (PERMISSION_MODES.has(permissionMode)) {
    parts.push(`--permission-mode ${permissionMode}`)
  }
  return parts.join(' ')
}

/** Workers never start panes; a plain pane may while no other live pane holds the commander lease. */
async function requireMayStart(ctx) {
  const ws = requireWorkspace(ctx)
  requireFrom(ctx)
  if (ctx.role === 'worker' || process.env.HERDR_COMMANDER_ROLE === 'worker') {
    throw new BridgeError('worker_cannot_spawn', 'workers do not spawn further workers')
  }
  if (!ctx.byUser && !isCommander(ctx)) {
    const holder = storeFor(ws).getLease()
    if (holder && holder.pane_id !== ctx.from && (await holderAlive(holder))) {
      throw new BridgeError('not_commander', `${holder.pane_id} is this workspace's commander; ask it to spawn workers`)
    }
  }
  return ws
}

/** Splits a pane beside the caller and starts the agent there; waits until herdr sees it settle. */
async function openWorkerPane(ctx, ws, { kind, cwd, direction = 'right', name, model, permissionMode, herdrId }) {
  const split = await runJson([
    'pane', 'split', '--pane', ctx.from,
    '--direction', direction === 'down' ? 'down' : 'right',
    '--cwd', cwd,
    '--env', 'HERDR_COMMANDER_ROLE=worker',
    '--env', `HERDR_COMMANDER_PARENT=${ctx.from}`,
    '--no-focus',
  ])
  const paneId = split?.pane?.pane_id
  if (!paneId) {
    throw new BridgeError('split_failed', 'herdr did not return the new pane id')
  }
  const store = storeFor(ws)
  const agentName = workerName(name, kind)
  store.addOwned({ pane_id: paneId, owner: ctx.from, kind, name: agentName, created_at: now() })
  if (herdrId) {
    // Before the agent starts: a Claude worker reports its session by its pane
    // as soon as it is up, while this call still waits for it to settle.
    store.putWorker({ ...store.getWorker(herdrId), pane_id: paneId, agent_name: agentName })
  }
  // The pane shell is PowerShell 5.1, which mangles embedded quotes in native
  // arguments; so the command line typed there carries no quoted payload.
  const line = kind === 'claude'
    ? claudeLine(TOOL_ROOT, { model, permissionMode })
    : `& '${process.execPath}' '${CLI_PATH}' codex-launch b64:${Buffer.from(JSON.stringify({ role: 'worker', pane: paneId, workspace: ws })).toString('base64')}`
  await runJson(['pane', 'run', paneId, line])
  const detected = await waitForAgent(paneId, kind, Number(process.env.HERDR_BRIDGE_START_MS ?? 90000))
  if (detected) {
    await runJson(['agent', 'rename', paneId, agentName]).catch(() => {})
  }
  return { paneId, agentName, detected }
}

/** The Codex MCP tool: opens a worker pane now and sends it the first task (if any). */
export async function spawn(ctx, { kind = 'claude', name, cwd, task, direction = 'right' }) {
  const ws = await requireMayStart(ctx)
  if (!['claude', 'codex'].includes(kind)) {
    throw new BridgeError('bad_kind', 'kind must be claude or codex')
  }
  const { paneId, agentName, detected } = await openWorkerPane(ctx, ws, { kind, cwd: cwd || process.cwd(), direction, name })
  if (!detected) {
    return { pane_id: paneId, name: agentName, started: false, error: `no ${kind} agent detected in ${paneId} within 90s (check the pane for a trust or login prompt)` }
  }
  const out = { pane_id: paneId, name: agentName, started: true }
  if (detected.agent_status === 'blocked') {
    // A worker that comes up blocked waits on the person (a folder trust or
    // login prompt): typing the task there would answer that prompt.
    out.blocked = true
    out.note = `${paneId} is waiting on a prompt (folder trust, login, ...); the person must answer it in that pane. The task was not sent: send it with SendMessage (or herdr_message_send) once the worker is idle.`
    return out
  }
  if (task) {
    out.job = (await send(ctx, { target: paneId, kind: 'task', body: task })).job
  }
  return out
}

function samePath(a, b) {
  const canon = path => {
    let full = resolve(path)
    try {
      full = realpathSync.native(full)
    } catch {}
    return full.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  }
  return canon(a) === canon(b)
}

/**
 * Records a herdr worker and its first job, and returns at once: the herdr id,
 * the output file. The pane is opened by worker-start, which the caller runs
 * in the background (it can take up to ~90 s while the agent starts).
 * `forbid_cwd`: refuse that folder (herdr_worker_spawn is for other folders).
 * `from_session`: the caller's Claude session (its mod's), so a Claude worker's
 * messages go by Claude's cross-session messages; `permission_mode`: the
 * caller's mode, which a Claude worker starts in.
 */
export async function workerNew(ctx, { kind = 'claude', name, cwd, task, model, subagent_type: subagentType, description, forbid_cwd: forbidCwd, from_session: fromSession, permission_mode: permissionMode }) {
  const ws = await requireMayStart(ctx)
  if (!['claude', 'codex'].includes(kind)) {
    throw new BridgeError('bad_kind', 'kind must be claude or codex')
  }
  if (typeof task !== 'string' || task.trim() === '') {
    throw new BridgeError('bad_body', 'the first task is required')
  }
  const dir = cwd || process.cwd()
  let isDir = false
  try {
    isDir = statSync(dir).isDirectory()
  } catch {}
  if (!isDir) {
    throw new BridgeError('no_folder', `${dir} is not an existing folder`)
  }
  if (forbidCwd && samePath(dir, forbidCwd)) {
    throw new BridgeError('same_folder', 'that is this session\'s own folder: use the Agent tool with subagent_type herdr-commander:claude-worker or herdr-commander:codex-worker instead')
  }
  const store = storeFor(ws)
  const herdrId = newHerdrId('agent', ws)
  const worker = {
    herdr_id: herdrId,
    worker_kind: kind,
    pane_id: null,
    owner: ctx.from,
    workspace_id: ws,
    name: typeof name === 'string' && name !== '' ? name : null,
    agent_name: null,
    subagent_type: subagentType ?? null,
    description: description ?? null,
    model: model ?? null,
    permission_mode: PERMISSION_MODES.has(permissionMode) ? permissionMode : null,
    cwd: dir,
    output_file: store.outputPath(herdrId),
    status: 'starting',
    created_at: now(),
  }
  store.putWorker(worker)
  const { job } = await message(ctx, { to: herdrId, text: task, kind: 'task', from_session: fromSession })
  writeWorkerOutput(herdrId)
  return { worker: store.getWorker(herdrId), job }
}

/** Opens the pane of a recorded herdr worker and delivers its queued job. */
export async function workerStart(ctx, { herdr_id: herdrId }) {
  const ws = requireWorkspace(ctx)
  const store = storeFor(ws)
  const worker = store.getWorker(String(herdrId))
  if (!worker || worker.owner !== ctx.from) {
    throw new BridgeError('no_worker', `no herdr worker ${herdrId} of ${ctx.from}`)
  }
  if (worker.status !== 'starting') {
    return { worker }
  }
  const failWith = (status, type, note) => {
    const next = { ...store.getWorker(worker.herdr_id), status, note }
    store.putWorker(next)
    for (const { store: jobStore, job } of jobsFor({ worker: next, paneId: '' })) {
      if (ACTIVE_JOB.has(job.status)) {
        const marked = withEvent(status === 'failed' ? { ...job, status: 'failed', error: note } : job, type, { note })
        jobStore.putJob(marked)
      }
    }
    writeWorkerOutput(next.herdr_id)
    return { worker: next }
  }
  let opened
  try {
    opened = await openWorkerPane(ctx, ws, { kind: worker.worker_kind, cwd: worker.cwd, name: worker.name ?? worker.description ?? undefined, model: worker.model ?? undefined, permissionMode: worker.permission_mode ?? undefined, herdrId: worker.herdr_id })
  } catch (error) {
    return failWith('failed', 'start_failed', `${error.code ?? 'error'}: ${error.message ?? error}`)
  }
  const { paneId, agentName, detected } = opened
  store.putWorker({ ...store.getWorker(worker.herdr_id), pane_id: paneId, agent_name: agentName })
  if (!detected) {
    return failWith('failed', 'start_failed', `no ${worker.worker_kind} agent detected in ${paneId} within 90s (check the pane for a trust or login prompt)`)
  }
  if (detected.agent_status === 'blocked') {
    return failWith('blocked', 'start_blocked', `${paneId} is waiting on a prompt (folder trust, login, ...); the person must answer it in that pane. The task goes out once the worker is idle.`)
  }
  const running = { ...store.getWorker(worker.herdr_id), status: 'running', running_at: now() }
  store.putWorker(running)
  await pump({ worker: running, paneId, kind: running.worker_kind })
  writeWorkerOutput(running.herdr_id)
  return { worker: store.getWorker(worker.herdr_id) }
}

/**
 * TaskStop: ends a herdr worker (Ctrl+C, then its pane closes), without asking
 * (as native TaskStop). Only workers this caller started; `matched: false`
 * when the id is not herdr's at all.
 */
export async function stop(ctx, { target }) {
  requireFrom(ctx)
  const ws = requireWorkspace(ctx)
  const name = String(target ?? '')
  const store = storeFor(ws)
  const hit = await resolveRecipient(ctx, name)
  if (!hit) {
    return { matched: false }
  }
  const owned = hit.paneId ? store.getOwned().find(one => one.pane_id === hit.paneId) : null
  const mine = hit.worker ? hit.worker.owner === ctx.from : owned?.owner === ctx.from
  if (!mine) {
    throw new BridgeError('not_owned', `${hit.worker?.herdr_id ?? hit.paneId} was not started by this pane; TaskStop ends only herdr workers this pane started`)
  }
  if (hit.paneId) {
    await runJson(['agent', 'send-keys', hit.paneId, 'ctrl+c']).catch(() => {})
    if (store.isOwned(hit.paneId)) {
      await runJson(['pane', 'close', hit.paneId]).catch(() => {})
      store.removeOwned(hit.paneId)
    }
  }
  if (hit.worker) {
    hit.store.putWorker({ ...hit.worker, status: 'stopped', stopped_at: now() })
  }
  let stopped = 0
  let cancelled = 0
  for (const { store: jobStore, job } of jobsFor(hit)) {
    if (OPEN_JOB.has(job.status)) {
      jobStore.putJob(withEvent({ ...job, status: 'stopped', ended_at: now() }, 'stopped', { by: ctx.from }))
      stopped += 1
    } else if (job.status === 'queued') {
      jobStore.putJob(withEvent({ ...job, status: 'cancelled', ended_at: now() }, 'cancelled', { by: ctx.from }))
      cancelled += 1
    }
  }
  if (hit.worker) {
    writeWorkerOutput(hit.worker.herdr_id)
  }
  return { kind: 'agent', herdr_id: hit.worker?.herdr_id ?? null, pane_id: hit.paneId || null, closed: Boolean(hit.paneId), stopped_jobs: stopped, cancelled_jobs: cancelled }
}

/**
 * Any SendMessage from a Claude pane in herdr: a reply when this pane works on
 * a job of that recipient, else a message to a herdr worker, agent or pane,
 * else `none` (the mod hands it to Claude's own SendMessage).
 */
export async function route(ctx, { to, text, from_session: fromSession }) {
  const replied = await reply(ctx, { to, text })
  if (replied.routed) {
    return { action: 'reply', ...replied }
  }
  if (to === 'main' || !(await resolveRecipient(ctx, to).catch(() => null))) {
    return { action: 'none' }
  }
  const sent = await message(ctx, { to, text, kind: 'task', from_session: fromSession })
  return { ...sent, action: 'message', how: sent.action }
}

/** Polls herdr until it recognizes an agent of `kind` in the pane and it settles. */
async function waitForAgent(paneId, kind, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pane = await runJson(['pane', 'get', paneId]).catch(() => null)
    const info = pane?.pane
    if (info?.agent === kind && ['idle', 'done', 'blocked'].includes(info.agent_status)) {
      // A TUI can flash a settled state while it is still drawing: take the
      // state only when it holds across two reads.
      await new Promise(done => setTimeout(done, Number(process.env.HERDR_BRIDGE_SETTLE_MS ?? 2000)))
      const again = (await runJson(['pane', 'get', paneId]).catch(() => null))?.pane
      if (again?.agent === kind && again.agent_status === info.agent_status) {
        return again
      }
      continue
    }
    await new Promise(done => setTimeout(done, 1500))
  }
  return null
}

export async function closePane(ctx, { pane }) {
  const store = storeFor(requireWorkspace(ctx))
  if (!store.isOwned(pane)) {
    throw new BridgeError('not_owned', `${pane} was not created by the bridge; it will not close it`)
  }
  await runJson(['pane', 'close', pane])
  store.removeOwned(pane)
  return { closed: pane }
}

// Output files: what the model Reads ---------------------------------------------

function stamp(iso) {
  return String(iso ?? '').replace('T', ' ').slice(0, 19)
}

/** Rewrites a herdr worker's output file from the records (and a screen, when given). */
function writeWorkerOutput(herdrId, screen = null) {
  if (!herdrId) {
    return
  }
  const hit = findWorkerById(herdrId)
  if (!hit) {
    return
  }
  const { worker } = hit
  const jobs = jobsFor({ worker, paneId: worker.pane_id ?? '' }).map(({ job }) => job).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  const lines = [
    `# herdr worker ${worker.herdr_id}`,
    '',
    `${worker.worker_kind} worker${worker.name ? ` "${worker.name}"` : ''} · status ${worker.status} · pane ${worker.pane_id ?? '(starting)'} · folder ${worker.cwd} · started by ${worker.owner}`,
    worker.note ? `Note: ${worker.note}` : '',
    'Read this file again for the latest; it is rewritten on every message and on every Read.',
  ]
  for (const job of jobs) {
    lines.push('', `## Job ${job.job_id} (${job.status}) from ${job.from}`, '', '### Task', '', job.body)
    for (const one of job.messages ?? []) {
      lines.push('', `### ${stamp(one.at)} ${one.from === 'worker' ? 'worker → sender' : 'sender → worker'}`, '', one.text)
    }
    if (job.status === 'completed' && !viaMessages(job) && existsSync(job.result_path)) {
      lines.push('', `### Result (${job.result_path})`, '', readFileSync(job.result_path, 'utf8').slice(0, 20000))
    }
  }
  if (screen !== null) {
    lines.push('', `## Screen of ${worker.pane_id} (${stamp(now())})`, '', '```', screen, '```')
  }
  writeFileSync(worker.output_file, `${lines.filter(line => line !== null).join('\n')}\n`, 'utf8')
}

function under(path, dir) {
  const norm = value => resolve(value).replace(/[\\/]+/g, '/').toLowerCase()
  const full = norm(path)
  const base = `${norm(dir)}/`
  return full.startsWith(base) ? full.slice(base.length) : null
}

/**
 * Called by the mod before a Read of a runtime file: a herdr worker's output
 * file gets its pane's current screen; a pane screen file (panes/<pane>.txt)
 * is (re)written from herdr. Anything else is left alone.
 */
export async function refresh(ctx, { path }) {
  const rest = under(String(path ?? ''), runtimeRoot())
  if (rest === null) {
    return { refreshed: false }
  }
  const [ws, folder, file] = rest.split('/')
  if (!ws || !/^[a-z0-9_-]+$/.test(ws) || !file) {
    return { refreshed: false }
  }
  const known = runtimeWorkspaces().find(one => one.toLowerCase() === ws)
  if (!known) {
    return { refreshed: false }
  }
  const store = storeFor(known)
  if (folder === 'out' && file.endsWith('.md')) {
    const worker = store.listWorkers().find(one => `${one.herdr_id.toLowerCase()}.md` === file)
    if (!worker) {
      return { refreshed: false }
    }
    let screen = null
    if (worker.pane_id && worker.status !== 'stopped') {
      screen = await runText(['pane', 'read', worker.pane_id, '--source', 'recent-unwrapped', '--lines', '120']).then(text => text.replace(/\s+$/, '')).catch(error => `(cannot read the pane: ${error.message ?? error})`)
    }
    writeWorkerOutput(worker.herdr_id, screen)
    return { refreshed: true, path: worker.output_file }
  }
  if (folder === 'panes' && file.endsWith('.txt')) {
    const paneId = file.slice(0, -4).replace(/^(w[a-z0-9]+)-(p[a-z0-9]+)$/i, '$1:$2')
    const agents = await rawAgents().catch(() => [])
    const real = agents.find(one => one.pane_id.toLowerCase() === paneId.toLowerCase())?.pane_id ?? paneId
    let text
    try {
      text = (await read(ctx, { target: real, lines: 200 })).text
    } catch (error) {
      text = `(cannot read ${real}: ${error.message ?? error})`
    }
    const target = store.panePath(real)
    writeFileSync(target, `# Screen of herdr pane ${real} (${stamp(now())}); Read this file again for the latest\n\n${text}\n`, 'utf8')
    return { refreshed: true, path: target }
  }
  return { refreshed: false }
}

// Lifecycle, metadata, notifications ---------------------------------------------

const STATES = new Set(['idle', 'working', 'blocked', 'unknown'])

export async function report(ctx, { state, agent = 'claude', message }) {
  requireFrom(ctx)
  if (!STATES.has(state)) {
    throw new BridgeError('bad_state', `state must be one of ${[...STATES].join(', ')}`)
  }
  // herdr's parser takes the pane id right after the subcommand, before options.
  const args = ['pane', 'report-agent', ctx.from, '--source', SOURCE, '--agent', agent, '--state', state]
  if (message) {
    args.push('--message', String(message).slice(0, 200))
  }
  await runJson(args)
  return { reported: state }
}

export async function releaseAgent(ctx, { agent = 'claude' } = {}) {
  requireFrom(ctx)
  await runJson(['pane', 'release-agent', ctx.from, '--source', SOURCE, '--agent', agent])
  return { released: true }
}

export async function reportSession(ctx, { agent = 'claude', session_id: sessionId }) {
  requireFrom(ctx)
  await runJson(['pane', 'report-agent-session', ctx.from, '--source', SOURCE, '--agent', agent, '--agent-session-id', String(sessionId)])
  return { reported: true }
}

export async function metadata(ctx, { title, display_agent: displayAgent, agent = 'claude' }) {
  requireFrom(ctx)
  const args = ['pane', 'report-metadata', ctx.from, '--source', SOURCE, '--agent', agent]
  if (title === null) {
    args.push('--clear-title')
  } else if (title !== undefined) {
    args.push('--title', String(title).slice(0, 120))
  }
  if (displayAgent === null) {
    args.push('--clear-display-agent')
  } else if (displayAgent !== undefined) {
    args.push('--display-agent', String(displayAgent).slice(0, 40))
  }
  await runJson(args)
  return { reported: true }
}

export async function notify(ctx, { title, body, sound = 'none' }) {
  const args = ['notification', 'show', String(title).slice(0, 80)]
  if (body) {
    args.push('--body', String(body).slice(0, 300))
  }
  if (['none', 'done', 'request'].includes(sound)) {
    args.push('--sound', sound)
  }
  await runJson(args)
  return { shown: true }
}

// One-call view for the Claude mod's poll ----------------------------------------

/**
 * Agents, this workspace's lease, the caller's jobs (reconciled, with their
 * messages and events) and its herdr workers, in one process. It also moves
 * things on: a worker that was blocked at start and is now idle gets its
 * queued job.
 */
export async function snapshot(ctx) {
  const agents = await listAgents(ctx)
  const store = storeFor(requireWorkspace(ctx))
  const workers = store.listWorkers().filter(one => one.owner === ctx.from)
  for (const worker of workers.filter(one => one.status === 'blocked' && one.pane_id)) {
    const pane = agents.find(one => one.pane_id === worker.pane_id)
    if (pane && (pane.status === 'idle' || pane.status === 'done')) {
      const running = { ...worker, status: 'running', running_at: now(), note: undefined }
      store.putWorker(running)
      await pump({ worker: running, paneId: running.pane_id, kind: running.worker_kind }).catch(() => null)
    }
  }
  const list = store.listJobs().filter(job => !ctx.from || job.from === ctx.from || job.to === ctx.from)
  const shown = [...list.filter(job => ACTIVE_JOB.has(job.status)), ...list.filter(job => !ACTIVE_JOB.has(job.status)).slice(0, 20)]
  const reconciled = await Promise.all(shown.map(job => reconcile(store, job)))
  const jobsByWorker = new Map()
  for (const job of reconciled) {
    if (job.worker) {
      jobsByWorker.set(job.worker, [...(jobsByWorker.get(job.worker) ?? []), job])
    }
  }
  const view = store.listWorkers().filter(one => one.owner === ctx.from).slice(0, 30).map(worker => {
    const own = jobsByWorker.get(worker.herdr_id) ?? []
    return { ...worker, job: own.find(job => OPEN_JOB.has(job.status))?.job_id ?? null, queued: jobsFor({ worker, paneId: worker.pane_id ?? '' }).filter(({ job }) => job.status === 'queued').length }
  })
  return { agents, lease: store.getLease(), jobs: reconciled, workers: view, runtime: runtimeRoot(), panes_dir: store.panesDir }
}

// Codex launch arguments (one source for herdr-codex.ps1 and spawn) ---------------

const INSTRUCTIONS = {
  commander: join(CODEX_DIR, 'instructions', 'commander.md'),
  worker: join(CODEX_DIR, 'instructions', 'worker.md'),
}

/** TOML basic string: JSON string syntax is a subset TOML accepts. */
function toml(value) {
  return JSON.stringify(value)
}

export function codexArgs({ role = 'worker', pane = '', workspace = '' } = {}) {
  if (!INSTRUCTIONS[role]) {
    throw new BridgeError('bad_role', 'role must be commander or worker')
  }
  const instructions = readFileSync(INSTRUCTIONS[role], 'utf8')
  const serverArgs = [MCP_PATH, '--role', role]
  if (pane) {
    serverArgs.push('--pane', pane)
  }
  if (workspace) {
    serverArgs.push('--workspace', workspace)
  }
  const args = [
    '-c', `developer_instructions=${toml(instructions)}`,
    '-c', `mcp_servers.herdr_bridge.command=${toml(process.execPath)}`,
    '-c', `mcp_servers.herdr_bridge.args=${JSON.stringify(serverArgs)}`,
    '-c', 'memories.generate_memories=false',
    '-c', 'memories.use_memories=false',
  ]
  if (role === 'commander') {
    args.push('-s', 'read-only')
  }
  return args
}

/** The Codex CLI entry script (npm's bin/codex.js), run with this node. */
export function codexEntry() {
  const candidates = [
    process.env.HERDR_CODEX_JS,
    join(dirname(process.execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
  ].filter(Boolean)
  const found = candidates.find(path => existsSync(path))
  if (!found) {
    throw new BridgeError('codex_missing', `codex.js not found (looked in ${candidates.join(', ')}); set HERDR_CODEX_JS`)
  }
  return found
}
