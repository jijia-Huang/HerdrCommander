import { describe, expect, mock, test } from 'claude-code/testing'

import { base64, finished, specsFor, toRows, transitions, readOptions } from '../hooks/pure'
import type { RawAgent } from '../hooks/pure'
import { AGENTS, HERDR_ENV, PANE, SESSION, command, fromBase64, textOf, worldOf } from './world'

const COMPOSE_INPUT = { model: 'claude-test', promptModel: 'claude-test', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }
const COMPOSED = { sections: [{ id: 'intro', text: 'base prompt', scope: 'shared' as const }] }

describe('outside herdr nothing changes', () => {
  test('no command, no tool, no prompt section, no bridge call; edits pass', async ($, on) => {
    const world = worldOf(on, {})
    mock.clock(on)
    on('prompt.compose', () => COMPOSED)
    on('tool.call', () => ({ result: 'native' }) as never)
    await $.session.start(SESSION)

    expect(world.commands).toEqual([])
    expect(world.tools).toEqual([])
    const composed = await $.prompt.compose(COMPOSE_INPUT)
    expect(composed.sections.map(section => section.id)).toEqual(['intro'])
    const ran = await $.tool.call({ tool: 'Write', file_path: 'D:\\work\\a.txt', content: 'x' } as never)
    expect(ran.deny).toBeUndefined()
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

describe('inside herdr', () => {
  test('a plain pane gets /commander and the plain tools, and an env section in its prompt', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    on('prompt.compose', () => COMPOSED)
    await $.session.start(SESSION)

    expect(world.commands).toEqual(['commander'])
    expect(world.tools.sort()).toEqual(['herdr_agent_read', 'herdr_agents_list', 'herdr_job_complete', 'herdr_job_get'])
    const ids = (await $.prompt.compose(COMPOSE_INPUT)).sections.map(section => section.id)
    expect(ids).toEqual(['intro', 'herdr-commander:env'])
  })

  test('a worker pane gets no /commander and only the worker tools', async ($, on) => {
    const world = worldOf(on, { ...HERDR_ENV, HERDR_COMMANDER_ROLE: 'worker' })
    mock.clock(on)
    on('prompt.compose', () => COMPOSED)
    await $.session.start(SESSION)

    expect(world.commands).toEqual([])
    expect(world.tools.sort()).toEqual(['herdr_agents_list', 'herdr_job_complete', 'herdr_job_get'])
    const env = (await $.prompt.compose(COMPOSE_INPUT)).sections.find(section => section.id === 'herdr-commander:env')
    expect(env?.text).toContain('WORKER')
  })

  test('/commander claims the lease, opens the pane, adds the role section and blocks edits; off undoes it', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    const clock = mock.clock(on)
    on('prompt.compose', () => COMPOSED)
    on('tool.call', () => ({ result: 'native' }) as never)
    await $.session.start(SESSION)

    const out = await $.command.run(command('commander'))
    expect(out.text).toContain('Commander on')
    expect(world.bridge.some(call => call.command === 'claim')).toBe(true)
    expect(world.opened).toEqual(['commander'])
    expect(world.tools).toContain('herdr_worker_spawn')
    expect((await $.prompt.compose(COMPOSE_INPUT)).sections.map(section => section.id)).toEqual(['intro', 'herdr-commander:env', 'herdr-commander:role'])
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

  test('interrupting through a tool always asks the person', async ($, on) => {
    worldOf(on, HERDR_ENV)
    mock.clock(on)
    await $.session.start(SESSION)
    const verdict = await $.tool.check({ tool: 'mcp__herdr-commander__herdr_job_interrupt', input: { target: 'wA:p2' } })
    expect(verdict.decision).toBe('ask')
  })

  test('a herdr tool call goes to the bridge with this pane as the caller', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'mcp__herdr-commander__herdr_agent_read', target: 'wA:p2', lines: 10 } as never)
    expect(String(ran.result)).toContain('Allow git apply?')
    const call = world.bridge.find(one => one.command === 'read')
    expect(call?.args).toEqual({ target: 'wA:p2', lines: 10 })
    expect(call?.flags).toEqual(['--pane', 'wA:p1', '--workspace', 'wA', '--role', 'plain'])
  })

  test('a plain pane cannot call commander tools', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'mcp__herdr-commander__herdr_message_send', target: 'wA:p2', body: 'x' } as never)
    expect(ran.deny).toContain('not available to a plain pane')
    expect(world.bridge.some(call => call.command === 'send')).toBe(false)
  })

  test('a bridge failure reaches the model as a refusal with its code', async ($, on) => {
    const world = worldOf(on, HERDR_ENV)
    mock.clock(on)
    world.failures.read = { code: 'no_target', message: 'no agent or pane named zz' }
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'mcp__herdr-commander__herdr_agent_read', target: 'zz' } as never)
    expect(ran.deny).toBe('no_target: no agent or pane named zz')
  })

  test('ListAgents keeps its own result and adds the herdr agents as context', async ($, on) => {
    worldOf(on, HERDR_ENV)
    mock.clock(on)
    on('tool.call', () => ({ result: 'native list' }) as never)
    await $.session.start(SESSION)
    const ran = await $.tool.call({ tool: 'ListAgents' } as never)
    expect(ran.result).toBe('native list')
    expect((ran.context ?? []).join('\n')).toContain('wD:p2 claude idle')
  })
})

describe('pure helpers', () => {
  test('base64 round-trips UTF-8 payloads', () => {
    const text = JSON.stringify({ body: '請 review 這個 diff "quoted" \\ back' })
    expect(fromBase64(base64(text))).toBe(text)
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

  test('finished work wakes once: completed jobs this pane sent and exited background commands', () => {
    const jobs = [
      { jobId: 'job-1', from: 'wA:p1', to: 'wA:p2', kind: 'task', status: 'completed', summary: 'done', body: 'x', resultPath: 'r.md' },
      { jobId: 'job-2', from: 'wA:p1', to: 'wA:p2', kind: 'task', status: 'sent', summary: '', body: 'x', resultPath: 'r2.md' },
      { jobId: 'job-3', from: 'wA:p9', to: 'wA:p1', kind: 'task', status: 'completed', summary: '', body: 'x', resultPath: 'r3.md' },
    ]
    const bg = [{ id: 'bg-1', paneId: 'wA:p5', command: 'npm test', status: 'exited', exitCode: 1 }]
    expect(finished('wA:p1', jobs, bg, []).ids).toEqual(['job-1', 'bg-1'])
    expect(finished('wA:p1', jobs, bg, ['job-1', 'bg-1']).ids).toEqual([])
  })

  test('P2+ tools stay off by default and appear with their option', () => {
    const defaults = readOptions({})
    expect(specsFor('plain', defaults).some(spec => spec.name === 'herdr_bg_run')).toBe(false)
    expect(specsFor('plain', { ...defaults, backgroundTools: true }).some(spec => spec.name === 'herdr_bg_run')).toBe(true)
    expect(specsFor('worker', { ...defaults, agentPanes: true }).some(spec => spec.name === 'herdr_agent_spawn')).toBe(false)
  })
})
