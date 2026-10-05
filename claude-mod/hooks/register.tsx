// herdr-commander. Inside herdr (HERDR_ENV=1) the herdr features switch on;
// outside herdr the gate stays closed and every hook passes through.
//
// Every $ call lives in this file (the engine follows $ only within one file);
// pure helpers are in ./pure, state atoms in ./state. herdr itself is only ever
// run by the bridge (../bridge/cli.mjs), which holds the safety rules.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, BgRow, Gate, JobRow, Preview, Role } from '../types'
import {
  ACTIVE_JOB,
  AGENT_HINT,
  BG_HINT,
  COLOR,
  DELIVER_ADDENDUM,
  DIALOG_TOOLS,
  MARK,
  ROLE_TEXT,
  TOOL_PREFIX,
  WRITE_TOOLS,
  agentLine,
  agentsText,
  bridgeArgv,
  envText,
  errorText,
  finished,
  parseReply,
  readOptions,
  sortAgents,
  specsFor,
  toBg,
  toJobs,
  toRows,
  transitions,
} from './pure'
import type { Options, RawAgent, Snapshot } from './pure'

// State ($.state). Atoms are declared here: the engine reads them per file.

const OFF_GATE: Gate = { inHerdr: false, paneId: '', workspaceId: '', role: 'plain' }

const stGate = atom({ plugin: 'herdr-commander', key: 'gate' } as const, OFF_GATE)
const stAgents = atom({ plugin: 'herdr-commander', key: 'agents' } as const, [] as AgentRow[])
const stJobs = atom({ plugin: 'herdr-commander', key: 'jobs' } as const, [] as JobRow[])
const stBg = atom({ plugin: 'herdr-commander', key: 'bg' } as const, [] as BgRow[])
const stLease = atom({ plugin: 'herdr-commander', key: 'lease' } as const, null as string | null)
const stSelected = atom({ plugin: 'herdr-commander', key: 'selected' } as const, null as string | null)
const stPreview = atom({ plugin: 'herdr-commander', key: 'preview' } as const, null as Preview | null)
const stHerdrUp = atom({ plugin: 'herdr-commander', key: 'herdrUp' } as const, true)
const stLastError = atom({ plugin: 'herdr-commander', key: 'lastError' } as const, null as string | null)
const stPendingInterrupt = atom({ plugin: 'herdr-commander', key: 'pendingInterrupt' } as const, null as string | null)
const stPaneOpen = atom({ plugin: 'herdr-commander', key: 'paneOpen' } as const, false)
const stNotice = atom({ plugin: 'herdr-commander', key: 'notice' } as const, null as string | null)
const stAnnounced = atom({ plugin: 'herdr-commander', key: 'announced' } as const, [] as string[])

const PANE_ID = 'commander'

const NOTIFY_GAP_MS = 30000

// Module state (a reload starts it over; $.state keeps the rest).
let pollTimer: Timer | null = null
let pollMs = 0
let previewTimer: Timer | null = null
let ticking = false
let failures = 0
let seeded = false
const lastNotified = new Map<string, number>()
const registered = new Set<string>()
let desired: 'working' | 'idle' | 'blocked' | null = null
let reported: 'working' | 'idle' | 'blocked' | null = null
let sending = false
/** A permission dialog was shown during the running tool call. */
let awaitingPermission = false
let options: Options = readOptions({})

async function bridge<T = unknown>($: EngineInterface, command: string, args: Record<string, unknown> = {}, byUser = false, timeoutMs = 30000): Promise<T> {
  const g = await read($, stGate)
  const ran = await $.process.run(bridgeArgv($.plugin.root, g, command, args, byUser), { timeoutMs })
  return parseReply<T>(ran.stdout, ran.stderr, ran.exitCode)
}

/** Runs `fn` after the current dispatch, so a slow herdr call never delays a turn. */
function later($: EngineInterface, fn: () => Promise<unknown>): void {
  $.clock.after(1, () => {
    void fn().catch(() => {})
  })
}

async function registerTools($: EngineInterface, role: Role): Promise<void> {
  for (const spec of specsFor(role, options)) {
    if (!registered.has(spec.name)) {
      await $.tool.register({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema })
      registered.add(spec.name)
    }
  }
}

async function agentsNow($: EngineInterface): Promise<AgentRow[]> {
  const rows = await read($, stAgents)
  if (rows.length > 0) {
    return rows
  }
  const g = await read($, stGate)
  return toRows(await bridge<RawAgent[]>($, 'agents'), [], g.paneId, await $.clock.now())
}

async function serveTool($: EngineInterface, name: string, args: Record<string, unknown>): Promise<string> {
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  switch (name) {
    case 'herdr_agents_list': {
      const wanted = Array.isArray(args.status) ? (args.status as string[]) : null
      return agentsText(await agentsNow($), await $.clock.now(), wanted)
    }
    case 'herdr_agent_read':
      return json(await bridge($, 'read', { target: args.target, lines: args.lines }))
    case 'herdr_job_get':
      return json(await bridge($, 'job-get', args.job_id ? { job_id: args.job_id } : {}))
    case 'herdr_message_send': {
      const out = await bridge($, 'send', { target: args.target, kind: args.kind ?? 'task', body: args.body })
      await ensurePolling($)
      return json(out)
    }
    case 'herdr_worker_spawn':
    case 'herdr_agent_spawn': {
      const cwd = typeof args.cwd === 'string' ? args.cwd : await $.session.cwd()
      const out = await bridge($, 'spawn', {
        kind: args.kind ?? 'claude',
        name: args.name ?? (name === 'herdr_agent_spawn' ? 'bg-agent' : undefined),
        cwd,
        task: args.task,
        direction: args.direction ?? 'right',
      }, false, 150000)
      await ensurePolling($)
      return json(out)
    }
    case 'herdr_job_interrupt':
      return json(await bridge($, 'interrupt', { target: args.target, hard: args.hard === true }))
    case 'herdr_job_complete':
      return json(await bridge($, 'job-complete', { job_id: args.job_id, summary: args.summary, result: args.result, result_path: args.result_path }))
    case 'herdr_bg_run': {
      const cwd = typeof args.cwd === 'string' ? args.cwd : await $.session.cwd()
      const out = await bridge($, 'bg-run', { command: args.command, cwd, name: args.name })
      await ensurePolling($)
      return json(out)
    }
    case 'herdr_bg_read':
      return json(await bridge($, 'bg-status', { id: args.id, lines: args.lines ?? 200 }))
    case 'herdr_bg_stop':
      return json(await bridge($, 'bg-stop', { id: args.id, close: args.close === true }))
    default:
      throw new Error(`unknown tool ${name}`)
  }
}

/** Polls while there is something to watch: the commander role, or work this pane sent out. */
async function ensurePolling($: EngineInterface): Promise<void> {
  const g = await read($, stGate)
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
  const g = await read($, stGate)
  if (g.role === 'commander') {
    return
  }
  const pending = (await read($, stJobs)).some(job => job.from === g.paneId && ACTIVE_JOB.includes(job.status))
    || (await read($, stBg)).some(one => one.status === 'running')
  if (!pending) {
    stopPolling()
  }
}

async function tick($: EngineInterface): Promise<void> {
  const g = await read($, stGate)
  if (!g.inHerdr || ticking) {
    return
  }
  ticking = true
  try {
    const snap = await bridge<Snapshot>($, 'snapshot', { bg: options.backgroundTools }, false, 25000)
    const now = await $.clock.now()
    const before = await read($, stAgents)
    const rows = toRows(snap.agents, before, g.paneId, now)
    if (JSON.stringify(rows) !== JSON.stringify(before)) {
      await update($, stAgents, () => rows)
    }
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
    const jobRows = toJobs(snap.jobs)
    if (JSON.stringify(jobRows) !== JSON.stringify(await read($, stJobs))) {
      await update($, stJobs, () => jobRows)
    }
    const bgRows = toBg(snap.bg)
    const knownBg = await read($, stBg)
    const mergedBg = [...knownBg.filter(one => !bgRows.some(row => row.id === one.id)), ...bgRows]
    if (JSON.stringify(mergedBg) !== JSON.stringify(knownBg)) {
      await update($, stBg, () => mergedBg)
    }
    const holder = snap.lease?.pane_id ?? null
    if (holder !== (await read($, stLease))) {
      await update($, stLease, () => holder)
    }

    // Wake once per finished job / exited background command; old ones on (re)load stay quiet.
    const done = finished(g.paneId, jobRows, mergedBg, await read($, stAnnounced))
    if (done.ids.length > 0) {
      await update($, stAnnounced, list => [...list, ...done.ids].slice(-200))
      if (seeded) {
        $.ui.toast(done.lines[0] ?? 'herdr work finished')
        void $.prompt.submit({ text: `[herdr-commander] ${done.lines.join('\n')}\nRead the result before treating the work as done.` })
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
  const g = await read($, stGate)
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

async function enterCommander($: EngineInterface): Promise<string> {
  const g = await read($, stGate)
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
    await registerTools($, 'commander')
    $.ui.invalidate('tool.describe')
    await bridge($, 'metadata', { display_agent: 'claude · commander' }).catch(() => {})
    await $.store.set('lastRole', 'commander')
  }
  await update($, stPaneOpen, () => true)
  await $.ui.open({ id: PANE_ID, title: 'Commander' })
  startPreview($)
  await ensurePolling($)
  return 'Commander on: the Commander pane lists the herdr agents. Write/Edit/NotebookEdit are blocked in this role; /commander off ends it.'
}

async function leaveCommander($: EngineInterface): Promise<string> {
  const g = await read($, stGate)
  if (g.role !== 'commander') {
    return 'This pane is not the commander.'
  }
  await bridge($, 'release', {}).catch(() => {})
  await bridge($, 'metadata', { display_agent: null }).catch(() => {})
  await update($, stGate, () => ({ ...g, role: 'plain' as const }))
  await update($, stPaneOpen, () => false)
  previewTimer?.cancel()
  previewTimer = null
  await $.ui.close({ id: PANE_ID })
  $.ui.status(undefined)
  $.ui.invalidate('tool.describe')
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
  registered.clear()

  // Bridge ---------------------------------------------------------------------



  // Tools ------------------------------------------------------------------------




  // Every herdr_* tool this mod registers, in one hook (name → serveTool).
  on('tool.call', { tool: /^mcp__herdr-commander__herdr_/ }, async ($, e) => {
    const name = String(e.tool).slice(TOOL_PREFIX.length)
    const g = await read($, stGate)
    if (!g.inHerdr) {
      return { deny: 'herdr-commander tools work only inside a herdr pane' }
    }
    if (!specsFor(g.role, options).some(one => one.name === name)) {
      return { deny: `${name} is not available to a ${g.role} pane` }
    }
    try {
      return { result: await serveTool($, name, e as unknown as Record<string, unknown>) }
    } catch (error) {
      return { deny: errorText(error) }
    }
  })

  // D1: interrupting another agent always goes to the person.
  on('tool.check', { tool: /^mcp__herdr-commander__herdr_job_interrupt$/ }, async () => ({
    decision: 'ask' as const,
    reason: 'herdr-commander asks before interrupting another agent',
  }))

  // Poll ---------------------------------------------------------------------------





  // Lifecycle: this pane's state for herdr ----------------------------------------


  // Session start: the gate ------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    const isHerdr = (await $.env.get('HERDR_ENV')) === '1'
    const paneId = (await $.env.get('HERDR_PANE_ID')) ?? ''
    const workspaceId = (await $.env.get('HERDR_WORKSPACE_ID')) ?? paneId.split(':')[0] ?? ''
    if (!isHerdr || paneId === '' || workspaceId === '') {
      await update($, stGate, () => OFF_GATE)
      return next(e)
    }
    // A reload keeps $.state: a pane that was the commander stays one.
    const previous = await read($, stGate)
    const envRole = (await $.env.get('HERDR_COMMANDER_ROLE')) === 'worker' ? 'worker' : 'plain'
    const role: Role = previous.inHerdr && previous.paneId === paneId && previous.role === 'commander' ? 'commander' : envRole
    const g: Gate = { inHerdr: true, paneId, workspaceId, role }
    await update($, stGate, () => g)

    await registerTools($, role)
    if (role !== 'worker') {
      await $.command.register({ name: 'commander', description: "herdr: become this workspace's commander and open the Commander pane (/commander off to stop)" })
    }
    if (role === 'commander') {
      startPreview($)
      await ensurePolling($)
    } else if ((await $.store.get('lastRole')) === 'commander') {
      $.ui.status('herdr: /commander to resume the commander role')
    }
    if (options.lifecycleReport) {
      const sessionId = await $.session.id()
      later($, () => bridge($, 'report-session', { agent: 'claude', session_id: sessionId }))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const g = await read($, stGate)
    if (g.inHerdr) {
      stopPolling()
      previewTimer?.cancel()
      if (options.lifecycleReport) {
        await bridge($, 'release-agent', { agent: 'claude' }, false, 8000).catch(() => {})
      }
      if (g.role === 'commander') {
        await bridge($, 'release', {}, false, 8000).catch(() => {})
      }
    }
    return next(e)
  })

  if (options.lifecycleReport) {
    on('prompt.submit', async ($, e, next) => {
      if ((await read($, stGate)).inHerdr) {
        want($, 'working')
      }
      return next(e)
    })

    on('turn.complete', async ($, e, next) => {
      const done = await next(e)
      if ((await read($, stGate)).inHerdr) {
        want($, 'idle')
      }
      return done
    })

    // Blocked only while a permission dialog is really up. (A tool.check "ask"
    // is not that: auto mode's classifier or a rule may settle it unseen.)
    on('classic.PermissionRequest', async ($, e, next) => {
      if ((await read($, stGate)).inHerdr) {
        awaitingPermission = true
        want($, 'blocked')
      }
      return next(e)
    })
  }

  // Every tool call: dialogs block, the commander's own edits are refused (D2),
  // ListAgents and PushNotification get their herdr side.
  on('tool.call', async ($, e, next) => {
    const g = await read($, stGate)
    if (!g.inHerdr) {
      return next(e)
    }
    const tool = String(e.tool)
    if (g.role === 'commander' && (WRITE_TOOLS as readonly string[]).includes(tool)) {
      return { deny: 'herdr-commander: the commander does not edit files; send the change to a worker (herdr_message_send / herdr_worker_spawn) or run /commander off.' }
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
    if (tool === 'ListAgents' && options.listAgentsAugment) {
      try {
        const lines = (await agentsNow($)).filter(row => !row.isSelf).map(row => `${row.paneId} ${row.kind} ${row.status} "${row.title}" ${row.cwd}`)
        const note = lines.length === 0
          ? 'herdr: no other agents in this herdr session.'
          : `herdr agents (other panes in this herdr session; SendMessage to a pane id sends it a tracked herdr job):\n${lines.join('\n')}`
        return { ...ran, context: [...(ran.context ?? []), note] }
      } catch (error) {
        return { ...ran, context: [...(ran.context ?? []), `herdr agents unavailable: ${errorText(error)}`] }
      }
    }
    return ran
  })

  // SendMessage to a herdr pane id or agent name becomes a tracked herdr job.
  if (options.sendMessageRoute) {
    on('session.send', async ($, e, next) => {
      const g = await read($, stGate)
      if (!g.inHerdr || e.agentId) {
        return next(e)
      }
      const rows = await agentsNow($).catch(() => [] as AgentRow[])
      const hit = rows.find(row => !row.isSelf && (row.paneId === e.to || (row.name !== null && row.name === e.to)))
      if (!hit) {
        return next(e)
      }
      try {
        await bridge($, 'send', { target: hit.paneId, kind: 'question', body: e.text })
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
    const g = await read($, stGate)
    if (!g.inHerdr) {
      return composed
    }
    const extra = [{ id: 'herdr-commander:env', text: envText(g.paneId, g.role), scope: 'session' as const }]
    if (g.role === 'commander') {
      extra.push({ id: 'herdr-commander:role', text: ROLE_TEXT, scope: 'session' as const })
    }
    return { sections: [...composed.sections, ...extra] }
  })

  // Off by default (D3): steering hints and the herdr flavour of /deliver.
  if (options.backgroundTools) {
    on('tool.describe', { tool: 'Bash' }, async ($, e, next) => {
      const described = await next(e)
      return (await read($, stGate)).inHerdr ? { ...described, description: `${described.description}${BG_HINT}` } : described
    })
    on('tool.describe', { tool: 'PowerShell' }, async ($, e, next) => {
      const described = await next(e)
      return (await read($, stGate)).inHerdr ? { ...described, description: `${described.description}${BG_HINT}` } : described
    })
  }
  if (options.agentPanes) {
    on('tool.describe', { tool: 'Agent' }, async ($, e, next) => {
      const described = await next(e)
      const g = await read($, stGate)
      return g.inHerdr && g.role === 'plain' ? { ...described, description: `${described.description}${AGENT_HINT}` } : described
    })
  }
  if (options.deliverFlow) {
    on('skill.prompt', { skill: 'deliver' }, async ($, e, next) => {
      const expanded = await next(e)
      return (await read($, stGate)).inHerdr ? { ...expanded, text: `${expanded.text}\n${DELIVER_ADDENDUM}` } : expanded
    })
  }

  // /commander ------------------------------------------------------------------------





  on('command.run', { command: 'commander' }, async ($, e) => {
    const text = e.args.trim() === 'off' ? await leaveCommander($) : await enterCommander($)
    return { text }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const closed = await next(e)
    await update($, stPaneOpen, () => false)
    stopPolling()
    await ensurePolling($)
    return closed
  })




  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
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
