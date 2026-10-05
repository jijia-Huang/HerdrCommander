// node --test test/  (runs against test/fake-herdr.mjs, never the real herdr)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
let dir
let statePath
let logPath

const AGENTS = [
  { pane_id: 'wA:p1', agent: 'claude', agent_status: 'working', terminal_title_stripped: 'me', cwd: 'D:\\x', workspace_id: 'wA', tab_id: 'wA:t1' },
  { pane_id: 'wA:p2', agent: 'codex', agent_status: 'idle', terminal_title_stripped: 'worker', cwd: 'D:\\x', workspace_id: 'wA', tab_id: 'wA:t1' },
  { pane_id: 'wA:p3', agent: 'codex', agent_status: 'idle', terminal_title_stripped: 'other', cwd: 'D:\\x', workspace_id: 'wA', tab_id: 'wA:t1' },
]

function arrange(state = {}) {
  writeFileSync(statePath, JSON.stringify({ agents: AGENTS, ...state }))
}

function calls() {
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-bridge-'))
  statePath = join(dir, 'state.json')
  logPath = join(dir, 'calls.log')
  writeFileSync(logPath, '')
  arrange()
  process.env.HERDR_BRIDGE_RUNTIME = join(dir, 'runtime')
  process.env.HERDR_BRIDGE_HERDR_JS = join(here, 'fake-herdr.mjs')
  process.env.FAKE_HERDR_STATE = statePath
  process.env.FAKE_HERDR_LOG = logPath
  process.env.HERDR_BRIDGE_NUDGE_MS = '1'
  process.env.HERDR_BRIDGE_SETTLE_MS = '1'
})

const ops = await import('../lib/ops.mjs')
const { isForbidden } = await import('../lib/herdr.mjs')
const { Store } = await import('../lib/store.mjs')
const { toolsFor } = await import('../lib/registry.mjs')

const me = { from: 'wA:p1', workspace: 'wA', role: 'plain', byUser: false }

test('forbidden herdr commands never run', () => {
  assert.equal(isForbidden(['server', 'stop']), true)
  assert.equal(isForbidden(['session', 'delete', 'x']), true)
  assert.equal(isForbidden(['tab', 'close', 'wA:t1']), true)
  assert.equal(isForbidden(['agent', 'list']), false)
})

test('agents carry roles from the lease and the owned list', async () => {
  const store = new Store('wA')
  store.setLease({ pane_id: 'wA:p1', kind: 'claude' })
  store.addOwned({ pane_id: 'wA:p2', owner: 'wA:p1', kind: 'codex' })
  const agents = await ops.listAgents(me)
  assert.deepEqual(agents.map(one => [one.pane_id, one.role, one.is_self]), [
    ['wA:p1', 'commander', true],
    ['wA:p2', 'worker', false],
    ['wA:p3', 'plain', false],
  ])
})

test('one commander per workspace; a dead holder is replaced', async () => {
  assert.equal((await ops.claim(me, { kind: 'claude' })).claimed, true)
  const other = { ...me, from: 'wA:p3' }
  const refused = await ops.claim(other, { kind: 'codex' })
  assert.equal(refused.claimed, false)
  assert.equal(refused.holder.pane_id, 'wA:p1')
  arrange({ agents: AGENTS.filter(one => one.pane_id !== 'wA:p1') })
  assert.equal((await ops.claim(other, { kind: 'codex' })).claimed, true)
  assert.equal(ops.release(me).released, false)
  assert.equal(ops.release(other).released, true)
})

test('send creates a job and prompts the target with its id and result path', async () => {
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'review the diff' })
  assert.equal(job.status, 'sent')
  assert.equal(job.to, 'wA:p2')
  const prompt = calls().find(args => args[0] === 'agent' && args[1] === 'prompt')
  assert.equal(prompt[2], 'wA:p2')
  assert.match(prompt[3], new RegExp(`\\[herdr-job ${job.job_id}\\]`))
  assert.ok(prompt[3].includes(job.result_path))
  assert.ok(prompt[3].includes(job.task_path))
  assert.equal(prompt[3].includes('\n'), false, 'the typed prompt is one line')
  assert.match(readFileSync(job.task_path, 'utf8'), /review the diff/)
})

test('the task file starts with a UTF-8 BOM so PowerShell 5.1 reads non-ASCII text', async () => {
  const { job } = await ops.send(me, { target: 'wA:p2', body: '列出檔案行數' })
  const bytes = readFileSync(job.task_path)
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(bytes.subarray(3).toString('utf8'), /^# herdr job .*列出檔案行數/s)
})

test('a codex target that stays idle after the prompt gets one Enter; a claude target does not', async () => {
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
  assert.equal(job.nudged, true)
  assert.equal(calls().filter(args => args[0] === 'agent' && args[1] === 'send-keys' && args[3] === 'enter').length, 1)
  writeFileSync(logPath, '')
  arrange({ agents: AGENTS.map(one => (one.pane_id === 'wA:p3' ? { ...one, agent: 'claude' } : one)) })
  const second = await ops.send(me, { target: 'wA:p3', body: 'x' })
  assert.equal(second.job.nudged, false)
  assert.equal(calls().some(args => args[1] === 'send-keys'), false)
})

test('a failed delivery is delivery_unknown and is not resent', async () => {
  arrange({ failOn: 'agent prompt' })
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
  assert.equal(job.status, 'delivery_unknown')
  assert.equal(calls().filter(args => args[0] === 'agent' && args[1] === 'prompt').length, 1)
})

test('send refuses self and commanders', async () => {
  await assert.rejects(ops.send(me, { target: 'wA:p1', body: 'x' }), /own pane/)
  new Store('wA').setLease({ pane_id: 'wA:p3', kind: 'codex' })
  await assert.rejects(ops.send(me, { target: 'wA:p3', body: 'x' }), /commander/)
})

test('a result file with the right header completes the job; idle alone does not', async () => {
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
  assert.equal((await ops.jobGet(me, { job_id: job.job_id })).job.status, 'sent')
  writeFileSync(job.result_path, 'job_id: wrong\nnope\n')
  assert.equal((await ops.jobGet(me, { job_id: job.job_id })).job.status, 'sent')
  writeFileSync(job.result_path, `job_id: ${job.job_id}\n\nall good\n`)
  const done = (await ops.jobGet(me, { job_id: job.job_id })).job
  assert.equal(done.status, 'completed')
  assert.equal(done.summary, 'all good')
})

test('job-complete checks the assignee and the result file', async () => {
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
  const worker = { ...me, from: 'wA:p2' }
  await assert.rejects(ops.jobComplete({ ...me, from: 'wA:p3' }, { job_id: job.job_id, summary: 's' }), /not wA:p3/)
  await assert.rejects(ops.jobComplete(worker, { job_id: job.job_id, summary: 's' }), /pass the full result/)
  writeFileSync(job.result_path, `job_id: ${job.job_id}\nok\n`)
  const out = await ops.jobComplete(worker, { job_id: job.job_id, summary: 'done it' })
  assert.equal(out.job.status, 'completed')
  assert.equal(out.job.summary, 'done it')
})

test('an idle codex commander is woken on completion; a claude commander is not', async () => {
  for (const kind of ['codex', 'claude']) {
    writeFileSync(logPath, '')
    const store = new Store('wA')
    store.setLease({ pane_id: 'wA:p1', kind })
    arrange({ agents: AGENTS.map(one => (one.pane_id === 'wA:p1' ? { ...one, agent: kind, agent_status: 'idle' } : one)) })
    const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
    writeFileSync(job.result_path, `job_id: ${job.job_id}\nok\n`)
    await ops.jobComplete({ ...me, from: 'wA:p2' }, { job_id: job.job_id, summary: 'ok' })
    const wakes = calls().filter(args => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'wA:p1')
    assert.equal(wakes.length, kind === 'codex' ? 1 : 0, kind)
  }
})

test('result text handed to job-complete is written by the bridge with the header', async () => {
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
  const out = await ops.jobComplete({ ...me, from: 'wA:p2' }, { job_id: job.job_id, summary: 'ok', result: 'changed a.lua\nran tests: 3 passed' })
  assert.equal(out.job.status, 'completed')
  const text = readFileSync(job.result_path, 'utf8')
  assert.match(text, new RegExp(`^job_id: ${job.job_id}`))
  assert.match(text, /3 passed/)
})

test('a codex sender is woken once even when the result file is reconciled before job-complete', async () => {
  arrange({ agents: AGENTS.map(one => (one.pane_id === 'wA:p1' ? { ...one, agent: 'codex', agent_status: 'idle' } : one)) })
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
  writeFileSync(logPath, '')
  writeFileSync(job.result_path, `job_id: ${job.job_id}\nok\n`)
  const seen = (await ops.jobGet(me, { job_id: job.job_id })).job
  assert.equal(seen.status, 'completed')
  assert.equal(seen.woken, 'prompt')
  const again = await ops.jobComplete({ ...me, from: 'wA:p2' }, { job_id: job.job_id, summary: 'ok' })
  assert.equal(again.already, true)
  const wakes = calls().filter(args => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'wA:p1')
  assert.equal(wakes.length, 1)
})

test('a busy sender is not prompted; wakePending wakes it once it is idle', async () => {
  arrange({ agents: AGENTS.map(one => (one.pane_id === 'wA:p1' ? { ...one, agent: 'codex', agent_status: 'working' } : one)) })
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
  writeFileSync(logPath, '')
  const done = await ops.jobComplete({ ...me, from: 'wA:p2' }, { job_id: job.job_id, summary: 'ok', result: 'r' })
  assert.equal(done.job.woken, undefined)
  arrange({ agents: AGENTS.map(one => (one.pane_id === 'wA:p1' ? { ...one, agent: 'codex', agent_status: 'idle' } : one)) })
  assert.deepEqual(await ops.wakePending(me), { tried: 1, woken: 1 })
  assert.deepEqual(await ops.wakePending(me), { tried: 0, woken: 0 })
  assert.equal(calls().filter(args => args[0] === 'agent' && args[1] === 'prompt' && args[2] === 'wA:p1').length, 1)
})

test('a lease whose pane no longer hosts an agent of its kind is free', async () => {
  new Store('wA').setLease({ pane_id: 'wA:p3', kind: 'claude' })
  const out = await ops.claim(me, { kind: 'claude' })
  assert.equal(out.claimed, true, 'wA:p3 hosts codex, not the claude commander that took the lease')
  assert.equal(out.replaced.pane_id, 'wA:p3')
})

test('models interrupt only what they manage; the person may interrupt anything', async () => {
  await assert.rejects(ops.interrupt(me, { target: 'wA:p3' }), /not a pane or job you manage/)
  await ops.send(me, { target: 'wA:p2', body: 'x' })
  assert.equal((await ops.interrupt(me, { target: 'wA:p2' })).sent, 'esc')
  assert.equal((await ops.interrupt({ ...me, byUser: true }, { target: 'wA:p3', hard: true })).sent, 'ctrl+c')
})

test('only owned panes close; workers never spawn; another live commander blocks spawn', async () => {
  await assert.rejects(ops.closePane(me, { pane: 'wA:p3' }), /not created by the bridge/)
  await assert.rejects(ops.spawn({ ...me, role: 'worker' }, { kind: 'codex' }), /workers do not spawn/)
  new Store('wA').setLease({ pane_id: 'wA:p3', kind: 'codex' })
  await assert.rejects(ops.spawn(me, { kind: 'codex' }), /wA:p3 is this workspace's commander/)
})

test('snapshot returns agents, lease, my jobs and reconciles them', async () => {
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
  writeFileSync(job.result_path, `job_id: ${job.job_id}\nok\n`)
  const snap = await ops.snapshot(me)
  assert.equal(snap.agents.length, 3)
  assert.equal(snap.jobs[0].status, 'completed')
  assert.deepEqual(snap.bg, [])
})

test('spawn opens a worker pane with the worker role and starts the agent', async () => {
  new Store('wA').setLease({ pane_id: 'wA:p1', kind: 'claude' })
  arrange({ nextPane: 'wA:p9', spawnAgent: 'claude' })
  const out = await ops.spawn(me, { kind: 'claude', name: 'Impl One' })
  assert.equal(out.started, true)
  assert.match(out.name, /^impl-one-[a-z0-9]{4}$/)
  const split = calls().find(args => args[0] === 'pane' && args[1] === 'split')
  assert.ok(split.includes('HERDR_COMMANDER_ROLE=worker'))
  assert.ok(split.includes('--no-focus'))
  const run = calls().find(args => args[0] === 'pane' && args[1] === 'run')
  assert.match(run[3], /claude --plugin-dir '.*claude-mod'/)
  assert.equal(new Store('wA').isOwned('wA:p9'), true)
})

test('a worker that comes up blocked (trust or login prompt) is not sent its task', async () => {
  new Store('wA').setLease({ pane_id: 'wA:p1', kind: 'claude' })
  arrange({ nextPane: 'wA:pX', spawnAgent: 'claude', spawnStatus: 'blocked' })
  const out = await ops.spawn(me, { kind: 'claude', task: 'do it' })
  assert.equal(out.blocked, true)
  assert.equal(out.job, undefined)
  assert.equal(calls().some(args => args[0] === 'agent' && args[1] === 'prompt'), false)
})

test('codex args carry the role instructions and the bridge MCP server', () => {
  const args = ops.codexArgs({ role: 'commander', pane: 'wA:p1', workspace: 'wA' })
  const values = args.filter((_, index) => args[index - 1] === '-c')
  const instructions = values.find(one => one.startsWith('developer_instructions='))
  assert.match(JSON.parse(instructions.slice('developer_instructions='.length)), /COMMANDER/)
  const serverArgs = JSON.parse(values.find(one => one.startsWith('mcp_servers.herdr_bridge.args=')).split('=').slice(1).join('='))
  assert.deepEqual(serverArgs.slice(1), ['--role', 'commander', '--pane', 'wA:p1', '--workspace', 'wA'])
  assert.ok(values.includes('memories.use_memories=false'))
  assert.deepEqual(args.slice(-2), ['-s', 'read-only'])
  assert.equal(ops.codexArgs({ role: 'worker' }).includes('read-only'), false)
})

test('background exit marker is read from the pane, not from the echoed command', async () => {
  arrange({ nextPane: 'wA:p8' })
  const { bg } = await ops.bgRun(me, { command: 'npm test' })
  const echoed = ops.wrapCommand(bg.id, 'npm test')
  arrange({ readText: `PS> ${echoed}\nrunning...\n` })
  assert.equal((await ops.bgStatus(me, { id: bg.id })).bg.status, 'running')
  arrange({ readText: `PS> ${echoed}\nrunning...\n[herdr-bg-exit:${bg.id}:3:False]\n` })
  const status = (await ops.bgStatus(me, { id: bg.id })).bg
  assert.equal(status.status, 'exited')
  assert.equal(status.exit_code, 3)
})

test('lifecycle commands put the pane id right after the subcommand', async () => {
  await ops.report(me, { state: 'blocked' })
  await ops.releaseAgent(me, {})
  await ops.metadata(me, { display_agent: 'claude · commander' })
  const lifecycle = calls().filter(args => args[0] === 'pane')
  assert.deepEqual(lifecycle.map(args => [args[1], args[2]]), [['report-agent', 'wA:p1'], ['release-agent', 'wA:p1'], ['report-metadata', 'wA:p1']])
  await assert.rejects(ops.report(me, { state: 'done' }), /state must be one of/)
})

test('MCP tools depend on the role', () => {
  assert.deepEqual(toolsFor('worker').map(tool => tool.name).sort(), ['herdr_agents_list', 'herdr_job_complete', 'herdr_job_get'])
  assert.ok(toolsFor('commander').some(tool => tool.name === 'herdr_worker_spawn'))
  assert.equal(toolsFor('commander').some(tool => tool.name === 'herdr_job_complete'), false)
})

test('MCP server answers initialize, tools/list and tools/call over stdio', async () => {
  const child = spawn(process.execPath, [join(here, '..', 'mcp.mjs'), '--role', 'worker', '--pane', 'wA:p2', '--workspace', 'wA'], { env: process.env })
  const replies = []
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, index)))
      buffer = buffer.slice(index + 1)
    }
  })
  const write = message => child.stdin.write(`${JSON.stringify(message)}\n`)
  write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  write({ jsonrpc: '2.0', method: 'notifications/initialized' })
  write({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'herdr_agents_list', arguments: {} } })
  write({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'herdr_worker_spawn', arguments: { kind: 'codex' } } })
  const deadline = Date.now() + 10000
  while (replies.length < 4 && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 50))
  }
  child.kill()
  const byId = Object.fromEntries(replies.map(one => [one.id, one]))
  assert.equal(byId[1].result.serverInfo.name, 'herdr-bridge')
  assert.equal(byId[2].result.tools.length, 3)
  assert.match(byId[3].result.content[0].text, /wA:p2/)
  assert.equal(byId[4].result.isError, true)
})
