// Every bridge operation. CLI and MCP both call these with a context:
//   { from: caller pane id, workspace: caller workspace id, role, byUser }
// `byUser` is set only by the Claude mod's panel buttons (a person pressed
// them); model-driven calls (MCP, the mod's tools) never set it.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { runJson, runText } from './herdr.mjs'
import { BridgeError, CLI_PATH, CODEX_DIR, MCP_PATH, MOD_DIR, runtimeRoot } from './paths.mjs'
import { Store, newId } from './store.mjs'

export const SOURCE = 'herdr-commander'
const PANE_ID = /^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/
const NAME = /^[a-z][a-z0-9_-]{0,31}$/
const ACTIVE_JOB = new Set(['queued', 'sent', 'delivery_unknown'])

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
    const job = active.find(one => one.to === agent.pane_id) ?? null
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

/** The full task, with how to hand the result back, as the worker reads it from a file. */
export function jobTaskFile(job) {
  return [
    `# herdr job ${job.job_id}`,
    '',
    `From: ${job.from} (${job.kind})`,
    '',
    '## Task',
    '',
    job.body,
    '',
    '## When you finish',
    '',
    `Call the herdr_job_complete tool with job_id="${job.job_id}", a one-line \`summary\` and the full result as \`result\``,
    '(what you changed, the commands you ran with their output, anything unresolved); the bridge writes the result file.',
    '',
    `Only if you do not have that tool: write the result to \`${job.result_path}\`, first line exactly \`job_id: ${job.job_id}\`.`,
    '',
    'Do not answer only in the terminal; the commander reads the result file.',
  ].join('\n')
}

/**
 * The single line typed into the worker's terminal. One line on purpose: a
 * multi-line paste loses its newlines (and sometimes its Enter) in some TUIs.
 */
export function jobPrompt(job) {
  const preview = job.body.replace(/\s+/g, ' ').trim().slice(0, 160)
  return `[herdr-job ${job.job_id}] from ${job.from} (${job.kind}): ${preview}${job.body.length > 160 ? '…' : ''} -- Full task: ${job.task_path} . When done, call herdr_job_complete with job_id="${job.job_id}", a one-line summary and the full result text as "result". Without that tool, write the result to ${job.result_path} (first line "job_id: ${job.job_id}").`
}

/**
 * Types the prompt and, for a Codex target, makes sure it was submitted: a
 * paste typed into a just-started Codex sometimes keeps the text and drops
 * the Enter. An extra Enter on an empty or already-sent box does nothing.
 */
async function deliver(paneId, kind, text) {
  await runJson(['agent', 'prompt', paneId, text], { timeoutMs: 15000 })
  if (kind !== 'codex') {
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

export async function send(ctx, { target, kind = 'task', body }) {
  requireFrom(ctx)
  const ws = requireWorkspace(ctx)
  if (typeof body !== 'string' || body.trim() === '') {
    throw new BridgeError('bad_body', 'body is required')
  }
  if (!['task', 'question'].includes(kind)) {
    throw new BridgeError('bad_kind', 'kind must be task or question')
  }
  const { paneId, agent } = await resolveTarget(target)
  notSelf(ctx, paneId)
  const targetLease = agent ? storeFor(agent.workspace_id).getLease() : null
  if (targetLease && targetLease.pane_id === paneId) {
    throw new BridgeError('target_is_commander', `${paneId} is a commander; commanders do not take jobs`)
  }
  const store = storeFor(ws)
  const jobId = newId('job')
  const job = {
    job_id: jobId,
    workspace_id: ws,
    from: ctx.from,
    to: paneId,
    to_kind: agent?.kind ?? 'unknown',
    kind,
    body,
    result_path: store.resultPath(jobId),
    task_path: store.taskPath(jobId),
    status: 'queued',
    review: 'pending',
    created_at: new Date().toISOString(),
  }
  // With a BOM: Windows PowerShell 5.1's Get-Content reads BOM-less files in
  // the ANSI code page, which garbles a non-ASCII task for a Codex worker.
  writeFileSync(job.task_path, `﻿${jobTaskFile(job)}`, 'utf8')
  store.putJob(job)
  try {
    const { nudged } = await deliver(paneId, job.to_kind, jobPrompt(job))
    job.status = 'sent'
    job.nudged = nudged
  } catch (error) {
    // The text may have reached the pane; never resend automatically.
    job.status = 'delivery_unknown'
    job.error = String(error.message ?? error)
  }
  store.putJob(job)
  return { job }
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
  if (!ACTIVE_JOB.has(job.status)) {
    return job
  }
  const header = readResultHeader(job.result_path)
  if (header && header.jobId === job.job_id) {
    const done = { ...job, status: 'completed', summary: job.summary ?? header.summary, completed_at: new Date().toISOString(), completed_via: 'result_file' }
    store.putJob(done)
    return onCompleted(store, done)
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
  const done = {
    ...job,
    status: 'completed',
    summary: String(summary).slice(0, 500),
    result_path: path,
    completed_at: new Date().toISOString(),
    completed_via: 'tool',
  }
  store.putJob(done)
  return { job: await onCompleted(store, done), accepted: true }
}

/** Runs once, at the moment a job becomes completed (by tool or by result file). */
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
    const next = { ...job, woken }
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

export async function spawn(ctx, { kind = 'claude', name, cwd, task, direction = 'right' }) {
  requireFrom(ctx)
  const ws = requireWorkspace(ctx)
  // Workers never spawn (no recursive panes). Otherwise the commander may, and
  // a plain session may while no other live pane holds the commander lease.
  if (ctx.role === 'worker' || process.env.HERDR_COMMANDER_ROLE === 'worker') {
    throw new BridgeError('worker_cannot_spawn', 'workers do not spawn further workers')
  }
  if (!ctx.byUser && !isCommander(ctx)) {
    const holder = storeFor(ws).getLease()
    if (holder && holder.pane_id !== ctx.from && (await holderAlive(holder))) {
      throw new BridgeError('not_commander', `${holder.pane_id} is this workspace's commander; ask it to spawn workers`)
    }
  }
  if (!['claude', 'codex'].includes(kind)) {
    throw new BridgeError('bad_kind', 'kind must be claude or codex')
  }
  const dir = cwd || process.cwd()
  const split = await runJson([
    'pane', 'split', '--pane', ctx.from,
    '--direction', direction === 'down' ? 'down' : 'right',
    '--cwd', dir,
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
  store.addOwned({ pane_id: paneId, owner: ctx.from, kind, name: agentName, created_at: new Date().toISOString() })
  // The pane shell is PowerShell 5.1, which mangles embedded quotes in native
  // arguments; so the command line typed there carries no quoted payload.
  const line = kind === 'claude'
    ? `claude --plugin-dir '${MOD_DIR}'`
    : `& '${process.execPath}' '${CLI_PATH}' codex-launch b64:${Buffer.from(JSON.stringify({ role: 'worker', pane: paneId, workspace: ws })).toString('base64')}`
  await runJson(['pane', 'run', paneId, line])
  const detected = await waitForAgent(paneId, kind, 90000)
  if (!detected) {
    return { pane_id: paneId, name: agentName, started: false, error: `no ${kind} agent detected in ${paneId} within 90s (check the pane for a trust or login prompt)` }
  }
  await runJson(['agent', 'rename', paneId, agentName]).catch(() => {})
  const out = { pane_id: paneId, name: agentName, started: true }
  if (detected.agent_status === 'blocked') {
    // A worker that comes up blocked waits on the person (a folder trust or
    // login prompt): typing the task there would answer that prompt.
    out.blocked = true
    out.note = `${paneId} is waiting on a prompt (folder trust, login, ...); the person must answer it in that pane. The task was not sent: send it with herdr_message_send once the worker is idle.`
    return out
  }
  if (task) {
    out.job = (await send(ctx, { target: paneId, kind: 'task', body: task })).job
  }
  return out
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

// Background commands (B path: separate tools, native Bash untouched) ----------

/**
 * The line typed into the pane's PowerShell. The command runs in a child
 * powershell.exe given as -EncodedCommand (UTF-16LE base64): no quoting
 * survives PowerShell 5.1 intact, and an `exit` in the command would close
 * the pane's own shell. -NoProfile: the child inherits the pane shell's
 * environment (an activated conda env included) without the slow profile. The marker prints the child's exit code afterwards;
 * ${LASTEXITCODE} is braced since "$LASTEXITCODE:" parses as a drive variable.
 */
export function wrapCommand(id, command) {
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  return `powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded}; Write-Host "[herdr-bg-exit:${id}:` + '${LASTEXITCODE}:$?]"'
}

export async function bgRun(ctx, { command, cwd, name }) {
  requireFrom(ctx)
  const ws = requireWorkspace(ctx)
  if (typeof command !== 'string' || command.trim() === '') {
    throw new BridgeError('bad_command', 'command is required')
  }
  const split = await runJson([
    'pane', 'split', '--pane', ctx.from, '--direction', 'down',
    '--cwd', cwd || process.cwd(),
    '--env', 'HERDR_COMMANDER_ROLE=worker',
    '--no-focus',
  ])
  const paneId = split?.pane?.pane_id
  if (!paneId) {
    throw new BridgeError('split_failed', 'herdr did not return the new pane id')
  }
  const store = storeFor(ws)
  const id = newId('bg')
  store.addOwned({ pane_id: paneId, owner: ctx.from, kind: 'shell', name: name || id, created_at: new Date().toISOString() })
  const bg = { id, pane_id: paneId, owner: ctx.from, command, name: name || null, status: 'running', started_at: new Date().toISOString() }
  store.putBg(bg)
  await runJson(['pane', 'rename', paneId, `bg:${(name || command).slice(0, 30)}`]).catch(() => {})
  await runJson(['pane', 'run', paneId, wrapCommand(id, command)])
  return { bg }
}

const EXIT_MARK = /\[herdr-bg-exit:([A-Za-z0-9_-]+):(-?\d*):(True|False)\]/

export async function bgStatus(ctx, { id, lines = 60 }) {
  const store = storeFor(requireWorkspace(ctx))
  const bg = store.getBg(String(id))
  if (!bg) {
    throw new BridgeError('no_bg', `no background command ${id}`)
  }
  if (bg.status !== 'running') {
    return { bg }
  }
  let text = ''
  try {
    text = await runText(['pane', 'read', bg.pane_id, '--source', 'recent-unwrapped', '--lines', String(Math.max(20, Math.min(400, Number(lines) || 60)))])
  } catch (error) {
    const gone = { ...bg, status: 'lost', error: String(error.message ?? error) }
    store.putBg(gone)
    return { bg: gone }
  }
  // The echoed command line holds the template ("$LASTEXITCODE:$?"), which the
  // pattern cannot match; only the expanded marker printed at exit does.
  const real = [...text.matchAll(new RegExp(EXIT_MARK.source, 'g'))].find(match => match[1] === bg.id)
  if (real) {
    const done = { ...bg, status: 'exited', exit_code: real[2] === '' ? (real[3] === 'True' ? 0 : 1) : Number(real[2]), ended_at: new Date().toISOString() }
    store.putBg(done)
    return { bg: done, tail: text.slice(-4000) }
  }
  return { bg, tail: text.slice(-4000) }
}

export async function bgRead(ctx, { id, lines = 200 }) {
  const store = storeFor(requireWorkspace(ctx))
  const bg = store.getBg(String(id))
  if (!bg) {
    throw new BridgeError('no_bg', `no background command ${id}`)
  }
  const text = await runText(['pane', 'read', bg.pane_id, '--source', 'recent-unwrapped', '--lines', String(Math.max(1, Math.min(400, Number(lines) || 200)))])
  return { bg, text: text.replace(/\s+$/, '') }
}

export async function bgStop(ctx, { id, close = false }) {
  const store = storeFor(requireWorkspace(ctx))
  const bg = store.getBg(String(id))
  if (!bg) {
    throw new BridgeError('no_bg', `no background command ${id}`)
  }
  if (ctx.from && bg.owner !== ctx.from && !ctx.byUser) {
    throw new BridgeError('not_owner', `${id} belongs to ${bg.owner}`)
  }
  let stopped = bg
  if (bg.status === 'running') {
    await runJson(['pane', 'send-keys', bg.pane_id, 'ctrl+c']).catch(() => {})
    stopped = { ...bg, status: 'stopped', ended_at: new Date().toISOString() }
    store.putBg(stopped)
  }
  if (close) {
    await closePane(ctx, { pane: bg.pane_id }).catch(() => {})
  }
  return { bg: stopped }
}

export function bgList(ctx) {
  const store = storeFor(requireWorkspace(ctx))
  return { bg: store.listBg().filter(one => !ctx.from || one.owner === ctx.from) }
}

// One-call view for the Claude mod's poll ----------------------------------------

/**
 * Agents, this workspace's lease, the caller's recent jobs (reconciled) and
 * the status of the caller's running background commands, in one process.
 */
export async function snapshot(ctx, { bg = true } = {}) {
  const agents = await listAgents(ctx)
  const store = storeFor(requireWorkspace(ctx))
  const jobs = store.listJobs()
    .filter(job => !ctx.from || job.from === ctx.from || job.to === ctx.from)
    .slice(0, 20)
  const reconciled = await Promise.all(jobs.map(job => reconcile(store, job)))
  const running = bg ? store.listBg().filter(one => one.owner === ctx.from && one.status === 'running') : []
  const bgs = []
  for (const one of running) {
    bgs.push((await bgStatus(ctx, { id: one.id, lines: 40 })).bg)
  }
  return { agents, lease: store.getLease(), jobs: reconciled, bg: bgs }
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
