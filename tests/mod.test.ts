import { describe, expect, mock, test } from 'claude-code/testing'

import { base64, herdrListing, isRuntimePath, notices, readOptions, toRows, transitions } from '../hooks/pure'
import type { RawAgent } from '../hooks/pure'
import type { JobRow, WorkerRow } from '../types'
import { AGENTS, HERDR_ENV, PANE, SESSION, command, conversations, fromBase64, textOf, worldOf } from './world'

const COMPOSE_INPUT = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }
const COMPOSED = { sections: [{ id: 'intro', text: 'base prompt', scope: 'shared' as const }] }
const NATIVE = { result: 'native' }
const TAKEOVER_OFF = { takeover: false }

const WORKER = { herdr_id: 'herdr-agent-wA-abc123', worker_kind: 'claude', name: 'impl', agent_name: null, pane_id: null, status: 'starting', cwd: 'D:\\work', output_file: 'C:/rt/wA/out/herdr-agent-wA-abc123.md', job: null, queued: 0 }
const NEW_WORKER = { worker: WORKER, job: { job_id: 'job-1', status: 'queued' } }

/** The calls a model makes that the takeover may answer. */
const CALLS = {
  agent: { tool: 'Agent', description: 'build it', prompt: 'build the thing', subagent_type: 'herdr-commander:claude-worker', name: 'impl' },
  send: { tool: 'SendMessage', to: 'main', message: 'done: 3 files' },
  stop: { tool: 'TaskStop', task_id: 'herdr-agent-wA-abc123' },
  bash: { tool: 'Bash', command: 'npm test', description: 'tests', run_in_background: true },
}

describe('outside herdr nothing changes', () => {
  test('no command, tool, agent type, prompt section or bridge call; native tools answer themselves', async ($, on) => {
    const world = worldOf(on, {})
    mock.clock(on)
    on('prompt.compose', () => COMPOSED)
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)

    expect(world.commands).toEqual([])
    expect(world.tools).toEqual([])
    expect(world.agentTypes).toEqual([])
    const composed = await $.prompt.compose(COMPOSE_INPUT)
    expect(composed.sections.map(section => section.id)).toEqual(['intro'])
    for (const call of [...Object.values(CALLS), { tool: 'Write', file_path: 'D:\\work\\a.txt', content: 'x' }]) {
      const ran = await $.tool.call(call as never)
      expect(ran.result).toBe('native')
    }
    expect(world.bridge).toEqual([])
  })

  test('a herdr env without a pane id is still outside', async ($, on) => {
    const world = worldOf(on, { HERDR_ENV: '1' })
    mock.clock(on)
    await $.session.start(SESSION)
    expect(world.commands).toEqual([])
    expect(world.tools).toEqual([])
  })
})

describe('inside herdr with the takeover switch off', () => {
  test('no tool, no agent types, and Agent / SendMessage / TaskStop / background Bash are native', { options: TAKEOVER_OFF }, async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)

    expect(world.tools).toEqual([])
    expect(world.agentTypes).toEqual([])
    expect(world.commands).toEqual(['commander'])
    for (const call of Object.values(CALLS)) {
      expect((await $.tool.call(call as never)).result).toBe('native')
    }
    expect(world.bridge.filter(call => !['report-session', 'report'].includes(call.command))).toEqual([])
  })
})

describe('inside herdr', () => {
  test('a plain pane gets /commander, herdr_worker_spawn, the two herdr agent types and an env section', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    on('prompt.compose', () => COMPOSED)
    await $.session.start(SESSION)

    expect(world.commands).toEqual(['commander'])
    expect(world.tools).toEqual(['herdr_worker_spawn'])
    expect(world.agentTypes).toEqual(['claude-worker', 'codex-worker'])
    const sections = (await $.prompt.compose(COMPOSE_INPUT)).sections
    expect(sections.map(section => section.id)).toEqual(['intro', 'herdr-commander:env'])
    expect(sections[1]?.text).toContain('herdr-commander:claude-worker')
  })

  test('a worker pane gets no command, no tool, no agent types, and is told its final reply is the result', async ($, on) => {
    const world = worldOf(on, { ...HERDR_ENV, HERDR_COMMANDER_ROLE: 'worker' })
    mock.clock(on)
    on('prompt.compose', () => COMPOSED)
    await $.session.start(SESSION)

    expect(world.commands).toEqual([])
    expect(world.tools).toEqual([])
    expect(world.agentTypes).toEqual([])
    const env = (await $.prompt.compose(COMPOSE_INPUT)).sections.find(section => section.id === 'herdr-commander:env')
    expect(env?.text).toContain('WORKER')
    expect(env?.text).toContain('your final reply goes to whoever gave you the work')
    expect(env?.text).toContain('you may also SendMessage to "main" (optional)')
    expect(env?.text).not.toContain('a message sent and then stopping completes the job')
    expect(env?.text).toContain('given to you directly')
    expect(env?.text).not.toContain('herdr_job_complete')
  })

  for (const [role, expected] of [['worker', [1, 1]], ['plain', [1, 0]]] as const) {
    test(`the herdr text rides on prompts as context (${role}): every prompt of a worker, once for another role`, async ($, on) => {
      const seen: number[] = []
      worldOf(on, role === 'worker' ? { ...HERDR_ENV, HERDR_COMMANDER_ROLE: 'worker' } : HERDR_ENV)
      mock.clock(on)
      on('prompt.submit', ($, e) => {
        seen.push((e.context ?? []).filter(text => text.includes('herdr-commander:')).length)
        return { text: e.text } as never
      })
      await $.session.start(SESSION)
      await $.prompt.submit({ text: 'Fix the bug in a.lua.' } as never)
      await $.prompt.submit({ text: 'Also the README.' } as never)
      expect(seen).toEqual([...expected])
    })
  }

  test('/commander claims the lease, opens the pane, adds the role section and blocks edits; off undoes it', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    const clock = mock.clock(on)
    on('prompt.compose', () => COMPOSED)
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)

    const out = await $.command.run(command('commander'))
    expect(out.text).toContain('Commander on')
    expect(world.bridge.some(call => call.command === 'claim')).toBe(true)
    expect(world.opened).toEqual(['commander'])
    const sections = (await $.prompt.compose(COMPOSE_INPUT)).sections
    expect(sections.map(section => section.id)).toEqual(['intro', 'herdr-commander:env', 'herdr-commander:role'])
    expect(sections[2]?.text).not.toMatch(/herdr_message_send|herdr_job_get|herdr_agent_read|herdr_agents_list/)
    const denied = await $.tool.call({ tool: 'Edit', file_path: 'D:\\work\\a.txt', old_string: 'a', new_string: 'b' } as never)
    expect(denied.deny).toContain('commander does not edit files')

    await clock.advance(5000)
    const off = await $.command.run(command('commander', 'off'))
    expect(off.text).toContain('Commander off')
    expect(world.bridge.some(call => call.command === 'release')).toBe(true)
    expect(world.closed).toEqual(['commander'])
    const allowed = await $.tool.call({ tool: 'Edit', file_path: 'D:\\work\\a.txt', old_string: 'a', new_string: 'b' } as never)
    expect(allowed.deny).toBeUndefined()
  })

  test('a lease held by another live pane refuses /commander and opens nothing', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    world.replies.claim = { claimed: false, holder: { pane_id: 'wA:p7', kind: 'codex' } }
    await $.session.start(SESSION)

    const out = await $.command.run(command('commander'))
    expect(out.text).toContain('wA:p7')
    expect(world.opened).toEqual([])
  })

  test('the pane lists the other agents from the poll, blocked first, and never this pane', async ($, on) => {
    worldOf(on, HERDR_ENV)
    const clock = mock.clock(on, { now: 1_000_000 })
    await $.session.start(SESSION)
    await $.command.run(command('commander'))
    await clock.advance(4000)

    const text = textOf(await $.ui.render(PANE as never))
    expect(text).toContain('herdr ok')
    expect(text).toContain('wA:p2')
    expect(text).toContain('BLOCKED')
    expect(text).toContain('wD:p2')
    expect(text.indexOf('wA:p2')).toBeLessThan(text.indexOf('wD:p2'))
    expect(text).not.toContain('wA:p1 claude')
    expect(text).toContain('[x interrupt]')
  })
})

const ENDED = (reason: string) => ({ reason, sessionId: 'session-1', resume: { id: 'session-1' } }) as never

describe('a conversation switch in the same process', () => {
  test('/resume keeps the takeover, the herdr state and the lease, and briefs the new conversation', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    const conversation = conversations(on)
    mock.clock(on)
    world.replies['worker-new'] = NEW_WORKER
    world.replies.lease = { lease: null }
    const seen: number[] = []
    on('prompt.submit', ($, e) => {
      seen.push((e.context ?? []).filter(text => text.includes('herdr-commander:')).length)
      return { text: e.text } as never
    })
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)
    await $.prompt.submit({ text: 'first' } as never)
    await $.prompt.submit({ text: 'second' } as never)

    await $.session.end(ENDED('resume'))
    conversation.next()
    expect(world.bridge.some(call => ['release', 'release-agent'].includes(call.command))).toBe(false)
    const switched = world.bridge.length
    await $.prompt.submit({ text: 'after the resume' } as never)
    expect(seen).toEqual([1, 0, 1])
    // The poll starts again: work sent out before the switch may still be running.
    expect(world.bridge.slice(switched).map(call => call.command)).toContain('snapshot')
    const ran = await $.tool.call(CALLS.agent as never)
    expect((ran.result as { agentId?: string }).agentId).toBe('herdr-agent-wA-abc123')
    expect(world.bridge.find(call => call.command === 'worker-new')?.flags).toEqual(['--pane', 'wA:p1', '--workspace', 'wA', '--role', 'plain'])
  })

  test('leaving a conversation switched to before any hook ran still releases this pane', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    const conversation = conversations(on)
    mock.clock(on)
    await $.session.start(SESSION)
    await $.session.end(ENDED('resume'))
    conversation.next()
    await $.session.end(ENDED('prompt_input_exit'))
    expect(world.bridge.find(call => call.command === 'release-agent')?.flags).toEqual(['--pane', 'wA:p1', '--workspace', 'wA', '--role', 'plain'])
  })

  test('the commander stays the commander after /clear: the bridge still has its lease', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    const conversation = conversations(on)
    mock.clock(on)
    on('prompt.compose', () => COMPOSED)
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)
    await $.command.run(command('commander'))

    await $.session.end(ENDED('clear'))
    conversation.next()
    expect(world.bridge.some(call => call.command === 'release')).toBe(false)
    world.replies.lease = { lease: { pane_id: 'wA:p1', kind: 'claude' } }
    const denied = await $.tool.call({ tool: 'Edit', file_path: 'D:\\work\\a.txt', old_string: 'a', new_string: 'b' } as never)
    expect(denied.deny).toContain('commander does not edit files')
    const sections = (await $.prompt.compose(COMPOSE_INPUT)).sections
    expect(sections.map(section => section.id)).toEqual(['intro', 'herdr-commander:env', 'herdr-commander:role'])
  })

  test('leaving the session still releases the pane and the lease', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    await $.session.start(SESSION)
    await $.command.run(command('commander'))
    await $.session.end(ENDED('prompt_input_exit'))
    expect(world.bridge.some(call => call.command === 'release-agent')).toBe(true)
    expect(world.bridge.some(call => call.command === 'release')).toBe(true)
  })
})

describe('Agent, SendMessage, TaskStop through herdr', () => {
  test('Agent with a herdr worker type answers at once with a herdr id and output file, then opens the pane in the background', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    const clock = mock.clock(on)
    world.replies['worker-new'] = NEW_WORKER
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)

    const ran = await $.tool.call(CALLS.agent as never)
    expect(ran.result).toEqual({ status: 'async_launched', agentId: 'herdr-agent-wA-abc123', description: 'build it', prompt: 'build the thing', outputFile: WORKER.output_file, canReadOutputFile: true })
    expect((ran.context ?? []).join('\n')).toContain('Read it whenever you like')
    const made = world.bridge.find(call => call.command === 'worker-new')
    expect(made?.args).toEqual({ kind: 'claude', name: 'impl', cwd: 'D:\\work', task: 'build the thing', subagent_type: 'herdr-commander:claude-worker', description: 'build it' })
    expect(world.bridge.some(call => call.command === 'worker-start')).toBe(false)
    await clock.advance(10)
    expect(world.bridge.find(call => call.command === 'worker-start')?.args).toEqual({ herdr_id: 'herdr-agent-wA-abc123' })
  })

  test('Agent with any other type, a fork, or from a subagent stays native', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)
    for (const type of ['general-purpose', 'Explore', 'fork', undefined]) {
      expect((await $.tool.call({ ...CALLS.agent, subagent_type: type } as never)).result).toBe('native')
    }
    expect(world.bridge.some(call => call.command === 'worker-new')).toBe(false)
  })

  test('a herdr worker type that herdr cannot take is refused, never run in-process', async ($, on) => {
    const world = worldOf(on, { ...HERDR_ENV, HERDR_COMMANDER_ROLE: 'worker' })
    mock.clock(on)
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)
    expect((await $.tool.call(CALLS.agent as never)).deny).toContain('runs only as a herdr worker')
    const subagent = await $.tool.call({ ...CALLS.agent, agentId: 'sub-1' } as never)
    expect(subagent.deny).toContain('runs only as a herdr worker')
    expect(world.bridge.some(call => call.command === 'worker-new')).toBe(false)
  })

  test('a bridge refusal of the start (another commander) reaches the model', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    world.failures['worker-new'] = { code: 'not_commander', message: 'wA:p7 is this workspace\'s commander; ask it to spawn workers' }
    await $.session.start(SESSION)
    expect((await $.tool.call(CALLS.agent as never)).deny).toBe("herdr: not_commander: wA:p7 is this workspace's commander; ask it to spawn workers")
  })

  test('herdr_worker_spawn sends this session\'s folder as the one to refuse', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    world.replies['worker-new'] = { ...NEW_WORKER, worker: { ...WORKER, cwd: 'D:\\other' } }
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'mcp__herdr-commander__herdr_worker_spawn', cwd: 'D:\\other', kind: 'codex', task: 'review' } as never)
    expect(String(ran.result)).toContain('herdr-agent-wA-abc123')
    expect(world.bridge.find(call => call.command === 'worker-new')?.args).toMatchObject({ cwd: 'D:\\other', kind: 'codex', task: 'review', forbid_cwd: 'D:\\work' })
    world.failures['worker-new'] = { code: 'same_folder', message: "that is this session's own folder: use the Agent tool" }
    const refused = await $.tool.call({ tool: 'mcp__herdr-commander__herdr_worker_spawn', cwd: 'd:/work/', kind: 'codex', task: 'x' } as never)
    expect(refused.deny).toContain('same_folder')
  })

  test('a worker\'s SendMessage to main is handed to the bridge whole and answered in the native shape', async ($, on) => {
    const world = worldOf(on, { ...HERDR_ENV, HERDR_COMMANDER_ROLE: 'worker' })
    mock.clock(on)
    world.replies.route = { action: 'reply', routed: true, to: 'wA:p9', job_id: 'job-1', open: true }
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)
    const ran = await $.tool.call(CALLS.send as never)
    expect(ran.result).toEqual({ success: true, message: 'Message sent to wA:p9.' })
    expect((ran.context ?? []).join('\n')).toContain('a report along the way')
    expect((ran.context ?? []).join('\n')).toContain('your final reply when this turn ends')
    expect(world.bridge.find(call => call.command === 'route')?.args).toEqual({ to: 'main', text: 'done: 3 files' })
  })

  test('SendMessage to someone herdr does not know is native', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    world.replies.route = { action: 'none' }
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)
    expect((await $.tool.call({ tool: 'SendMessage', to: 'some-peer', message: 'hi' } as never)).result).toBe('native')
    expect(world.bridge.some(call => call.command === 'route')).toBe(true)
  })

  test('TaskStop of a herdr id stops it without any permission check; other ids are native', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    const checks: string[] = []
    on('tool.check', ($, e) => {
      checks.push(String(e.tool))
      return { decision: 'ask' as const }
    })
    on('tool.call', () => NATIVE as never)
    world.replies.stop = { kind: 'agent', herdr_id: 'herdr-agent-wA-abc123', pane_id: 'wA:p9', closed: true }
    await $.session.start(SESSION)
    const ran = await $.tool.call(CALLS.stop as never)
    expect(ran.result).toEqual({ message: 'Stopped herdr worker herdr-agent-wA-abc123 (Ctrl+C) and closed its pane wA:p9.', task_id: 'herdr-agent-wA-abc123', task_type: 'herdr_agent' })
    expect(checks).toEqual([])
    expect((await $.tool.call({ tool: 'TaskStop', task_id: 'b7x2k1' } as never)).result).toBe('native')
    expect(world.bridge.filter(call => call.command === 'stop').length).toBe(1)
    world.failures.stop = { code: 'not_owned', message: 'wA:p2 was not started by this pane' }
    expect((await $.tool.call({ tool: 'TaskStop', task_id: 'wA:p2' } as never)).deny).toContain('not_owned')
  })

  test('ListAgents keeps the native listing and adds the herdr workers and other panes with their files', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    world.replies.snapshot = { agents: AGENTS, lease: null, jobs: [], workers: [{ ...WORKER, pane_id: 'wA:p2', status: 'running', job: 'job-1', queued: 1 }], panes_dir: 'C:/rt/wA/panes' }
    on('tool.call', () => ({ result: { listing: 'Peer sessions (0)' } }) as never)
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'ListAgents' } as never)
    const listing = (ran.result as { listing: string }).listing
    expect(listing.startsWith('Peer sessions (0)')).toBe(true)
    expect(listing).toContain('herdr-agent-wA-abc123 "impl" · claude · running · pane wA:p2 · job job-1 · 1 queued')
    expect(listing).toContain('wD:p2 · claude · idle')
    expect(listing).toContain('screen C:/rt/wA/panes/wD-p2.txt')
    expect(listing).not.toContain('wA:p2 · codex')
  })
})

describe('Read, background commands and turns', () => {
  test('a Read of a runtime file is refreshed by the bridge and allowed; any other Read is untouched', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    on('tool.check', () => ({ decision: 'ask' as const }))
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)
    expect((await $.tool.call({ tool: 'Read', file_path: 'C:\\rt\\wA\\panes\\wA-p2.txt' } as never)).result).toBe('native')
    expect(world.bridge.find(call => call.command === 'refresh')?.args).toEqual({ path: 'C:\\rt\\wA\\panes\\wA-p2.txt' })
    expect((await $.tool.check({ tool: 'Read', input: { file_path: 'C:/RT/wA/out/x.md' } })).decision).toBe('allow')
    expect((await $.tool.check({ tool: 'Read', input: { file_path: 'C:/rt/../secret.txt' } })).decision).toBe('ask')
    expect((await $.tool.check({ tool: 'Read', input: { file_path: 'D:/work/a.txt' } })).decision).toBe('ask')
    await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\a.txt' } as never)
    expect(world.bridge.filter(call => call.command === 'refresh').length).toBe(1)
  })

  test('background Bash and PowerShell, and Monitor, are always Claude\'s own, even with herdr allowed', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    on('tool.check', () => ({ decision: 'allow' as const }))
    on('tool.call', () => NATIVE as never)
    await $.session.start(SESSION)
    expect((await $.tool.call(CALLS.bash as never)).result).toBe('native')
    expect((await $.tool.call({ tool: 'PowerShell', command: 'npm test', run_in_background: true } as never)).result).toBe('native')
    expect((await $.tool.call({ tool: 'Monitor', description: 'watch log', timeout_ms: 60000, command: 'tail -f a.log' } as never)).result).toBe('native')
    expect(world.bridge.some(call => !['report-session', 'report'].includes(call.command))).toBe(false)
  })

  test('the end of a main-loop turn goes to the bridge with its reason and answer, the answer on stdin (it decides about jobs)', async ($, on) => {
    const world = worldOf(on, { ...HERDR_ENV, HERDR_COMMANDER_ROLE: 'worker' })
    const clock = mock.clock(on)
    on('turn.complete', () => ({ text: '' }))
    await $.session.start(SESSION)
    const long = `Result:\n${'長'.repeat(40000)}`
    await $.turn.complete({ answer: long, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    await clock.advance(10)
    const ended = world.bridge.find(call => call.command === 'turn-end')
    expect(ended?.args).toMatchObject({ reason: 'answer', aborted: false, answer: long })
    expect(ended?.stdin).toEqual(['answer'])
    expect(ended?.argv.join(' ').length).toBeLessThan(2000)
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1b', reason: 'aborted' } as never)
    await clock.advance(10)
    expect(world.bridge.filter(call => call.command === 'turn-end').at(-1)?.args).toMatchObject({ reason: 'aborted', aborted: true, answer: '' })
    const before = world.bridge.filter(call => call.command === 'turn-end').length
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'sub', reason: 'answer' } as never)
    await clock.advance(10)
    expect(world.bridge.filter(call => call.command === 'turn-end').length).toBe(before)
  })
})

describe('pure helpers', () => {
  test('base64 round-trips UTF-8 payloads', () => {
    const text = JSON.stringify({ body: '請 review 這個 diff "quoted" \\ back' })
    expect(fromBase64(base64(text))).toBe(text)
  })

  test('the takeover switch is on by default; the old per-feature switches are gone', () => {
    const defaults = readOptions({})
    expect(defaults.takeover).toBe(true)
    expect(Object.keys(defaults).sort()).toEqual(['deliverFlow', 'lifecycleReport', 'notifications', 'pollSeconds', 'pushNotificationMirror', 'takeover'])
    expect(readOptions({ takeover: false }).takeover).toBe(false)
  })

  test('runtime paths: inside the runtime folder only, any case or slash, no escape', () => {
    expect(isRuntimePath('C:\\Users\\me\\AppData\\Local\\herdr-commander\\runtime\\wA\\out\\x.md', 'C:/Users/me/AppData/Local/herdr-commander/runtime')).toBe(true)
    expect(isRuntimePath('c:/users/me/appdata/local/herdr-commander/runtime/wA/x', 'C:\\Users\\me\\AppData\\Local\\herdr-commander\\runtime\\')).toBe(true)
    expect(isRuntimePath('C:/Users/me/AppData/Local/herdr-commander/runtime-other/x', 'C:/Users/me/AppData/Local/herdr-commander/runtime')).toBe(false)
    expect(isRuntimePath('C:/Users/me/AppData/Local/herdr-commander/runtime/../../x', 'C:/Users/me/AppData/Local/herdr-commander/runtime')).toBe(false)
  })

  test('status time resets only when the status changes', () => {
    const first = toRows(AGENTS as RawAgent[], [], 'wA:p1', 100)
    const second = toRows(AGENTS.map(one => (one.pane_id === 'wD:p2' ? { ...one, status: 'working' } : one)) as RawAgent[], first, 'wA:p1', 900)
    expect(second.find(row => row.paneId === 'wA:p2')?.since).toBe(100)
    expect(second.find(row => row.paneId === 'wD:p2')?.since).toBe(900)
    expect(first.find(row => row.paneId === 'wA:p2')?.isMine).toBe(true)
  })

  test('only blocked and working→done are notified, never for this pane', () => {
    const before = toRows(AGENTS.map(one => ({ ...one, status: 'working' })) as RawAgent[], [], 'wA:p1', 0)
    const after = toRows(AGENTS.map(one => ({ ...one, status: one.pane_id === 'wD:p2' ? 'done' : 'blocked' })) as RawAgent[], before, 'wA:p1', 1)
    expect(transitions(before, after, 'wA:p1').map(one => [one.row.paneId, one.isBlocked])).toEqual([['wA:p2', true], ['wD:p2', false]])
  })

  test('job events wake once each: stopped without a result, a message along the way, then completed with the final reply in the same notice', () => {
    const worker: WorkerRow = { herdrId: 'herdr-agent-wA-abc123', kind: 'claude', name: 'impl', agentName: null, paneId: 'wA:p9', status: 'running', cwd: 'D:\\w', outputFile: 'C:/rt/out.md', note: '', jobId: 'job-1', queued: 0 }
    const job: JobRow = {
      jobId: 'job-1', from: 'wA:p1', to: 'wA:p9', worker: worker.herdrId, kind: 'task', status: 'completed', summary: 'done', body: 'x', resultPath: 'r.md',
      messages: [{ seq: 2, from: 'worker', text: 'Halfway: 2 of 3 done' }, { seq: 4, from: 'worker', text: 'Result: all 3 tests pass' }],
      events: [{ seq: 1, type: 'stopped_without_answer', at: 't' }, { seq: 3, type: 'message', at: 't', message_seq: 2 }, { seq: 5, type: 'completed', at: 't', via: 'answer', message_seq: 4 }],
    }
    const theirs: JobRow = { ...job, jobId: 'job-2', from: 'wA:p5' }
    const first = notices('wA:p1', [job, theirs], [worker], [])
    expect(first.keys).toEqual(['job-1#1', 'job-1#3', 'job-1#5'])
    expect(first.lines[0]).toContain('stopped without handing you a result')
    expect(first.lines[1]).toContain('Halfway: 2 of 3 done')
    expect(first.lines[2]).toContain('finished job job-1. Its final reply:\nResult: all 3 tests pass')
    expect(first.lines[2]).not.toContain('Halfway')
    expect(first.lines[2]).toContain('SendMessage to herdr-agent-wA-abc123 continues the same job; TaskStop herdr-agent-wA-abc123 closes its pane.')
    expect(notices('wA:p1', [job], [worker], first.keys)).toEqual({ keys: [], lines: [] })
  })

  test('a final reply too long for a notice is cut and points to the worker\'s output file', () => {
    const worker: WorkerRow = { herdrId: 'herdr-agent-wA-abc123', kind: 'claude', name: null, agentName: null, paneId: 'wA:p9', status: 'running', cwd: 'D:\\w', outputFile: 'C:/rt/out.md', note: '', jobId: null, queued: 0 }
    const job: JobRow = {
      jobId: 'job-1', from: 'wA:p1', to: 'wA:p9', worker: worker.herdrId, kind: 'task', status: 'completed', summary: '', body: 'x', resultPath: 'r.md',
      messages: [{ seq: 1, from: 'worker', text: 'x'.repeat(9000) }],
      events: [{ seq: 2, type: 'completed', at: 't', via: 'answer', message_seq: 1 }],
    }
    const { lines } = notices('wA:p1', [job], [worker], [])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[… cut; the whole text is in C:/rt/out.md]')
    expect((lines[0] ?? '').length).toBeLessThan(6500)
  })

  test('the herdr listing says when there is nothing', () => {
    expect(herdrListing([], [], 'C:/rt/wA/panes')).toBe('herdr: no other agents in this herdr session.')
  })
})
