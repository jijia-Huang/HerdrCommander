// node --test test/  (runs against test/fake-herdr.mjs, never the real herdr)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  process.env.HERDR_BRIDGE_START_MS = '200'
  delete process.env.HERDR_COMMANDER_ROLE
})

const ops = await import('../lib/ops.mjs')
const { isForbidden } = await import('../lib/herdr.mjs')
const { Store } = await import('../lib/store.mjs')
const { toolsFor } = await import('../lib/registry.mjs')
const { runtimeRoot } = await import('../lib/paths.mjs')

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

test('a codex or claude target that stays idle after the prompt gets one Enter; one that starts working does not', async () => {
  const { job } = await ops.send(me, { target: 'wA:p2', body: 'x' })
  assert.equal(job.nudged, true)
  assert.equal(calls().filter(args => args[0] === 'agent' && args[1] === 'send-keys' && args[3] === 'enter').length, 1)
  writeFileSync(logPath, '')
  arrange({ agents: AGENTS.map(one => (one.pane_id === 'wA:p3' ? { ...one, agent: 'claude' } : one)) })
  assert.equal((await ops.send(me, { target: 'wA:p3', body: 'x' })).job.nudged, true)
  writeFileSync(logPath, '')
  arrange({ agents: AGENTS.map(one => (one.pane_id === 'wA:p3' ? { ...one, agent: 'claude', agent_status: 'working' } : one)) })
  assert.equal((await ops.send(me, { target: 'wA:p3', body: 'y' })).job.nudged, false)
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

test('a worker in another workspace completes a job kept in the sender workspace', async () => {
  arrange({ agents: [...AGENTS,
    { pane_id: 'wB:p1', agent: 'codex', agent_status: 'idle', terminal_title_stripped: 'far', cwd: 'D:\\y', workspace_id: 'wB', tab_id: 'wB:t1' },
    { pane_id: 'wB:p2', agent: 'codex', agent_status: 'idle', terminal_title_stripped: 'near', cwd: 'D:\\y', workspace_id: 'wB', tab_id: 'wB:t1' },
  ] })
  const { job } = await ops.send(me, { target: 'wB:p1', body: 'tidy the docs' })
  assert.equal(job.workspace_id, 'wA')
  const row = (await ops.listAgents(me)).find(one => one.pane_id === 'wB:p1')
  assert.equal(row.job_id, job.job_id)
  const neighbour = { from: 'wB:p2', workspace: 'wB', role: 'plain', byUser: false }
  await assert.rejects(ops.jobComplete(neighbour, { job_id: job.job_id, summary: 's', result: 'x' }), /not wB:p2/)
  const worker = { from: 'wB:p1', workspace: 'wB', role: 'plain', byUser: false }
  const out = await ops.jobComplete(worker, { job_id: job.job_id, summary: 'done', result: 'docs tidied' })
  assert.equal(out.job.status, 'completed')
  assert.equal((await ops.jobGet(me, { job_id: job.job_id })).job.status, 'completed')
  assert.match(readFileSync(job.result_path, 'utf8'), /docs tidied/)
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
  assert.equal(run[3], ops.claudeLine())
  assert.equal(new Store('wA').isOwned('wA:p9'), true)
})

test('a working copy starts Claude workers by --plugin-dir; the installed copy by plain claude', () => {
  assert.equal(ops.claudeLine('D:\\Tool\\HerdrCommander'), "claude --plugin-dir 'D:\\Tool\\HerdrCommander'")
  assert.equal(ops.claudeLine('C:\\Users\\me\\.claude\\plugins\\cache\\herdr-commander\\herdr-commander\\0.1.0'), 'claude')
  assert.equal(ops.claudeLine('/home/me/.claude/plugins/cache/m/p/0.1.0'), 'claude')
})

test('runtime data lives outside the plugin, under LOCALAPPDATA, unless overridden', () => {
  const saved = { runtime: process.env.HERDR_BRIDGE_RUNTIME, local: process.env.LOCALAPPDATA }
  try {
    delete process.env.HERDR_BRIDGE_RUNTIME
    process.env.LOCALAPPDATA = 'C:\\Users\\me\\AppData\\Local'
    assert.equal(runtimeRoot(), join('C:\\Users\\me\\AppData\\Local', 'herdr-commander', 'runtime'))
    process.env.HERDR_BRIDGE_RUNTIME = 'D:\\elsewhere'
    assert.equal(runtimeRoot(), 'D:\\elsewhere')
  } finally {
    process.env.HERDR_BRIDGE_RUNTIME = saved.runtime
    process.env.LOCALAPPDATA = saved.local
  }
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

// Native-tool takeover: herdr ids, one open job per worker, replies, stop -----

const claudeWorker = () => arrange({ agents: AGENTS.map(one => (one.pane_id === 'wA:p2' ? { ...one, agent: 'claude' } : one)) })
const worker = { from: 'wA:p2', workspace: 'wA', role: 'worker', byUser: false }
const other = { from: 'wA:p3', workspace: 'wA', role: 'plain', byUser: false }
const prompts = to => calls().filter(args => args[0] === 'agent' && args[1] === 'prompt' && args[2] === to)

test('a claude pane that is not a worker gets the one-line note: the final reply is the answer; a codex worker keeps herdr_job_complete', async () => {
  claudeWorker()
  const { job } = await ops.message(me, { to: 'wA:p2', text: 'list the files' })
  assert.equal(job.delivered_as, 'file')
  assert.match(readFileSync(job.task_path, 'utf8'), /write it in your reply and end your turn: your final reply goes to wA:p1/)
  assert.match(prompts('wA:p2')[0][3], /^\[herdr-job .*your final reply goes back to wA:p1/)
  assert.doesNotMatch(prompts('wA:p2')[0][3], /herdr_job_complete|SendMessage/)
  arrange()
  const codex = await ops.message(me, { to: 'wA:p3', text: 'x' })
  assert.match(readFileSync(codex.job.task_path, 'utf8'), /herdr_job_complete/)
})

const answered = (answer, extra = {}) => ({ reason: 'answer', aborted: false, answer, ...extra })
const types = job => job.events.map(one => one.type)

test('a turn that ends with an answer completes the job: one completed event that carries the answer, and it is the result', async () => {
  claudeWorker()
  const { job } = await ops.message(me, { to: 'wA:p2', text: 'do it' })
  const done = await ops.turnEnd(worker, answered('Done: 3 files.\nfull detail'))
  assert.equal(done.completed, true)
  assert.equal(done.job.status, 'completed')
  assert.equal(done.job.completed_via, 'answer')
  assert.equal(done.job.summary, 'Done: 3 files.')
  assert.deepEqual(types(done.job), ['completed'], 'no separate message event')
  const event = done.job.events[0]
  assert.equal(event.via, 'answer')
  assert.equal(done.job.messages.find(one => one.seq === event.message_seq).text, 'Done: 3 files.\nfull detail')
  assert.match(readFileSync(job.result_path, 'utf8'), new RegExp(`^job_id: ${job.job_id}\\n\\nDone: 3 files.\\nfull detail\\n$`))
  assert.equal((readFileSync(new Store('wA').getJob(job.job_id).result_path, 'utf8').match(/full detail/g) ?? []).length, 1)
})

test('an aborted, refused, errored or empty turn does not complete; the sender is reminded once', async () => {
  claudeWorker()
  const { job } = await ops.message(me, { to: 'wA:p2', text: 'do it' })
  const aborted = await ops.turnEnd(worker, { reason: 'aborted', aborted: true, answer: 'half an answer' })
  assert.equal(aborted.reminded, true)
  assert.equal(aborted.job.status, 'sent')
  assert.deepEqual(types(aborted.job), ['stopped_without_answer'])
  assert.equal(aborted.job.events[0].reason, 'aborted')
  for (const end of [{ reason: 'refusal', aborted: false, answer: 'no' }, { reason: 'error', aborted: false, answer: '' }, answered('   '), {}]) {
    const out = await ops.turnEnd(worker, end)
    assert.equal(out.reminded, undefined, 'reminded once per delivery')
    assert.equal(out.completed, undefined)
  }
  const kept = new Store('wA').getJob(job.job_id)
  assert.equal(kept.status, 'sent')
  assert.deepEqual(types(kept), ['stopped_without_answer'])
  assert.equal(kept.messages.length, 0, 'nothing from a turn without an answer is recorded')
  // A later turn that does answer still completes it.
  assert.equal((await ops.turnEnd(worker, answered('ok now'))).job.status, 'completed')
})

test('a turn that began before the job arrived, and never took it, neither completes nor reminds', async () => {
  claudeWorker()
  await ops.message(me, { to: 'wA:p2', text: 'do it' })
  const early = Date.now() - 60000
  const out = await ops.turnEnd(worker, answered('about something else', { started_at: early, prompt_at: early }))
  assert.equal(out.reminded, undefined)
  assert.equal(out.completed, undefined)
  assert.equal(out.job.status, 'sent')
  assert.deepEqual(types(out.job), [])
})

test('a follow-up delivered into the running turn: that turn took it, so its answer completes the job', async () => {
  claudeWorker()
  const startedAt = Date.now() - 1000
  await ops.message(me, { to: 'wA:p2', text: 'step one' })
  const { job } = await ops.message(me, { to: 'wA:p2', text: 'also step two' })
  // Still waiting in the worker's input box: this turn has not taken it, so its end says nothing.
  const waiting = await ops.turnEnd(worker, answered('step one done', { started_at: startedAt, prompt_at: startedAt }))
  assert.deepEqual([waiting.job.status, waiting.completed, waiting.reminded], ['sent', undefined, undefined])
  // The follow-up arrived after the turn began; the worker's mod saw it as a prompt of that turn.
  const out = await ops.turnEnd(worker, answered('both steps done', { started_at: startedAt, prompt_at: Date.now() }))
  assert.equal(out.job.status, 'completed')
  assert.equal(out.job.job_id, job.job_id)
})

test('a turn with no open job (it completed, or the person typed in the worker pane) records nothing', async () => {
  claudeWorker()
  assert.deepEqual(await ops.turnEnd(worker, answered('the person asked me something')), { job: null })
  const { job } = await ops.message(me, { to: 'wA:p2', text: 'do it' })
  await ops.turnEnd(worker, answered('result'))
  const before = new Store('wA').getJob(job.job_id)
  assert.deepEqual(await ops.turnEnd(worker, answered('the person typed here after the job')), { job: null })
  assert.deepEqual(await ops.turnEnd(worker, { reason: 'aborted', aborted: true, answer: '' }), { job: null })
  const after = new Store('wA').getJob(job.job_id)
  assert.deepEqual(after.events, before.events)
  assert.deepEqual(after.messages, before.messages)
})

test('a SendMessage along the way reaches the sender at once; the end of the turn completes the job with the answer', async () => {
  claudeWorker()
  const { job } = await ops.message(me, { to: 'wA:p2', text: 'do it' })
  const routed = await ops.reply(worker, { to: 'main', text: 'Halfway: 2 of 3 done' })
  assert.deepEqual([routed.routed, routed.to, routed.job_id, routed.open], [true, 'wA:p1', job.job_id, true])
  const mid = new Store('wA').getJob(job.job_id)
  assert.equal(mid.status, 'sent', 'a message alone does not complete the job')
  assert.deepEqual(types(mid), ['message'])
  const done = await ops.turnEnd(worker, answered('All 3 done.'))
  assert.equal(done.job.status, 'completed')
  assert.deepEqual(types(done.job), ['message', 'completed'])
  assert.equal(done.job.summary, 'All 3 done.')
  assert.equal(done.job.messages.find(one => one.seq === done.job.events[1].message_seq).text, 'All 3 done.')
})

test('the sender writing again during the job joins that job and is delivered now', async () => {
  claudeWorker()
  const first = await ops.message(me, { to: 'wA:p2', text: 'step one' })
  const again = await ops.message(me, { to: 'wA:p2', text: 'also step two' })
  assert.equal(again.action, 'appended')
  assert.equal(again.job.job_id, first.job.job_id)
  assert.equal(prompts('wA:p2').length, 2)
  assert.match(prompts('wA:p2')[1][3], /more from wA:p1 on this same job/)
  assert.equal(new Store('wA').listJobs().length, 1)
})

test('replying to a worker whose job completed reopens the same job; the next answer completes it again with one notice', async () => {
  claudeWorker()
  const { job } = await ops.message(me, { to: 'wA:p2', text: 'first' })
  await ops.turnEnd(worker, answered('first answer'))
  assert.equal(existsSync(job.result_path), true)
  const reopened = await ops.message(me, { to: 'wA:p2', text: 'one more thing' })
  assert.equal(reopened.action, 'reopened')
  assert.equal(reopened.job.job_id, job.job_id)
  assert.equal(reopened.job.status, 'sent')
  assert.equal(existsSync(job.result_path), false, 'the old result file is cleared until it completes again')
  assert.equal(reopened.job.messages.filter(one => one.from === 'worker').length, 1, 'the first answer is not copied in again')
  const seen = reopened.job.events.length
  const again = await ops.turnEnd(worker, answered('second answer'))
  assert.equal(again.job.status, 'completed')
  assert.deepEqual(types(again.job).slice(seen), ['completed'], 'one new event for the second round')
  assert.equal(again.job.messages.find(one => one.seq === again.job.events.at(-1).message_seq).text, 'second answer')
  assert.match(readFileSync(join(new Store('wA').resultsDir, `${job.job_id}.round1.md`), 'utf8'), /first answer/)
  assert.equal(new Store('wA').listJobs().length, 1)
})

test('an answer longer than a command line reaches the bridge whole on stdin', async () => {
  claudeWorker()
  const { job } = await ops.message(me, { to: 'wA:p2', text: 'do it' })
  const answer = `Result:\n${'結果'.repeat(20000)}\nEND`
  assert.ok(answer.length > 32767)
  const env = { ...process.env }
  for (const key of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_COMMANDER_ROLE']) {
    delete env[key]
  }
  const args = `b64:${Buffer.from(JSON.stringify({ reason: 'answer', aborted: false })).toString('base64')}`
  const child = spawn(process.execPath, [join(here, '..', 'cli.mjs'), 'turn-end', args, '--pane', 'wA:p2', '--workspace', 'wA', '--role', 'worker', '--args-stdin'], { env })
  let stdout = ''
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stdin.end(JSON.stringify({ answer }))
  await new Promise(done => child.on('exit', done))
  const reply = JSON.parse(stdout.trim().split('\n').pop())
  assert.equal(reply.ok, true, stdout)
  assert.equal(reply.result.completed, true)
  const text = readFileSync(job.result_path, 'utf8')
  assert.equal(text, `job_id: ${job.job_id}\n\n${answer}\n`)
})

test('a worker busy with another sender\'s job queues the new job and gets it when the first completes', async () => {
  claudeWorker()
  const mine = await ops.message(me, { to: 'wA:p2', text: 'mine' })
  const theirs = await ops.message(other, { to: 'wA:p2', text: 'theirs' })
  assert.equal(theirs.job.status, 'queued')
  assert.equal(theirs.ahead, 1)
  assert.equal(prompts('wA:p2').length, 1)
  const listed = (await ops.listAgents(me)).find(one => one.pane_id === 'wA:p2')
  assert.equal(listed.job_id, mine.job.job_id, 'the open job, not the queued one')
  // "main" goes to the sender of the open job.
  assert.equal((await ops.reply(worker, { to: 'main', text: 'for p1' })).to, 'wA:p1')
  await ops.turnEnd(worker, answered('p1 done'))
  assert.equal(new Store('wA').getJob(mine.job.job_id).status, 'completed')
  assert.equal(new Store('wA').getJob(theirs.job.job_id).status, 'sent')
  assert.equal(prompts('wA:p2').length, 2)
  assert.equal((await ops.reply(worker, { to: 'main', text: 'for p3' })).to, 'wA:p3')
})

test('a pane with no job of that recipient is not a reply', async () => {
  claudeWorker()
  assert.equal((await ops.reply(worker, { to: 'main', text: 'x' })).routed, false)
  await ops.message(me, { to: 'wA:p2', text: 'x' })
  assert.equal((await ops.reply(worker, { to: 'wA:p3', text: 'x' })).routed, false)
  assert.equal((await ops.route(worker, { to: 'main', text: 'x' })).action, 'reply')
  assert.equal((await ops.route(me, { to: 'someone-native', text: 'x' })).action, 'none')
})

test('a herdr worker gets a herdr id and output file at once; its pane opens later and then gets the task', async () => {
  claudeWorker()
  new Store('wA').setLease({ pane_id: 'wA:p1', kind: 'claude' })
  const folder = join(dir, 'repo')
  mkdirSync(folder)
  const out = await ops.workerNew(me, { kind: 'claude', name: 'impl', cwd: folder, task: 'build it', subagent_type: 'herdr-commander:claude-worker', description: 'build' })
  assert.match(out.worker.herdr_id, /^herdr-agent-wA-[0-9a-f]{6}$/)
  assert.equal(out.worker.status, 'starting')
  assert.equal(out.job.status, 'queued')
  assert.equal(out.job.worker, out.worker.herdr_id)
  assert.match(readFileSync(out.worker.output_file, 'utf8'), /build it/)
  assert.equal(calls().some(args => args[1] === 'split'), false, 'no pane yet')
  // SendMessage finds it by the name it was started with even before the pane exists.
  assert.equal((await ops.message(me, { to: 'impl', text: 'and test it' })).action, 'appended')
  arrange({ agents: AGENTS, nextPane: 'wA:p9', spawnAgent: 'claude' })
  const started = await ops.workerStart(me, { herdr_id: out.worker.herdr_id })
  assert.equal(started.worker.status, 'running')
  assert.equal(started.worker.pane_id, 'wA:p9')
  const sent = new Store('wA').getJob(out.job.job_id)
  assert.equal(sent.status, 'sent')
  assert.equal(sent.to, 'wA:p9')
  assert.match(readFileSync(sent.task_path, 'utf8'), /build it[\s\S]*and test it/)
})

test('herdr_worker_spawn refuses this session\'s own folder (any case or slash) and a missing folder', async () => {
  const folder = join(dir, 'Repo')
  mkdirSync(folder)
  await assert.rejects(ops.workerNew(me, { kind: 'claude', cwd: folder, task: 'x', forbid_cwd: `${folder.toLowerCase().replace(/\\/g, '/')}/` }), /own folder/)
  await assert.rejects(ops.workerNew(me, { kind: 'claude', cwd: join(dir, 'nope'), task: 'x' }), /not an existing folder/)
  await assert.rejects(ops.workerNew({ ...me, role: 'worker' }, { kind: 'claude', cwd: folder, task: 'x' }), /workers do not spawn/)
})

test('a worker that does not come up fails its job and tells the sender', async () => {
  new Store('wA').setLease({ pane_id: 'wA:p1', kind: 'claude' })
  const out = await ops.workerNew(me, { kind: 'claude', cwd: dir, task: 'x' })
  arrange({ nextPane: 'wA:p9', spawnAgent: null })
  const started = await ops.workerStart(me, { herdr_id: out.worker.herdr_id })
  assert.equal(started.worker.status, 'failed')
  const job = new Store('wA').getJob(out.job.job_id)
  assert.equal(job.status, 'failed')
  assert.equal(job.events.at(-1).type, 'start_failed')
})

test('TaskStop ends a worker it started: Ctrl+C, pane closed, open job stopped, queued jobs cancelled', async () => {
  const store = new Store('wA')
  store.setLease({ pane_id: 'wA:p1', kind: 'claude' })
  const out = await ops.workerNew(me, { kind: 'claude', cwd: dir, task: 'x' })
  arrange({ agents: [...AGENTS, { pane_id: 'wA:p9', agent: 'claude', agent_status: 'idle', workspace_id: 'wA' }], nextPane: 'wA:p9', spawnAgent: 'claude' })
  await ops.workerStart(me, { herdr_id: out.worker.herdr_id })
  const queued = await ops.message(other, { to: 'wA:p9', text: 'later' })
  assert.equal(queued.job.status, 'queued')
  await assert.rejects(ops.stop(other, { target: out.worker.herdr_id }), /not started by this pane/)
  writeFileSync(logPath, '')
  const stopped = await ops.stop(me, { target: out.worker.herdr_id })
  assert.deepEqual([stopped.kind, stopped.closed, stopped.stopped_jobs, stopped.cancelled_jobs], ['agent', true, 1, 1])
  const keys = calls().filter(args => args[1] === 'send-keys' || (args[0] === 'pane' && args[1] === 'close'))
  assert.deepEqual(keys.map(args => args.slice(0, 4)), [['agent', 'send-keys', 'wA:p9', 'ctrl+c'], ['pane', 'close', 'wA:p9']])
  assert.equal(store.getWorker(out.worker.herdr_id).status, 'stopped')
  assert.equal(store.getJob(queued.job.job_id).events.at(-1).type, 'cancelled')
  assert.equal(store.isOwned('wA:p9'), false)
  await assert.rejects(ops.stop(me, { target: 'wA:p3' }), /not started by this pane/)
  assert.deepEqual(await ops.stop(me, { target: 'herdr-agent-wA-000000' }), { matched: false })
})

test('reading a runtime file refreshes it: a worker output gets its screen, a pane file is written', async () => {
  claudeWorker()
  const store = new Store('wA')
  store.setLease({ pane_id: 'wA:p1', kind: 'claude' })
  const out = await ops.workerNew(me, { kind: 'claude', cwd: dir, task: 'x' })
  store.putWorker({ ...store.getWorker(out.worker.herdr_id), pane_id: 'wA:p2', status: 'running' })
  arrange({ agents: AGENTS, readText: 'SCREEN LINE\n' })
  assert.equal((await ops.refresh(me, { path: out.worker.output_file })).refreshed, true)
  assert.match(readFileSync(out.worker.output_file, 'utf8'), /## Screen of wA:p2[\s\S]*SCREEN LINE/)
  const pane = store.panePath('wA:p3')
  assert.equal((await ops.refresh(me, { path: pane.toUpperCase() })).refreshed, true)
  assert.match(readFileSync(pane, 'utf8'), /herdr pane wA:p3[\s\S]*SCREEN LINE/)
  assert.equal((await ops.refresh(me, { path: join(dir, 'elsewhere.txt') })).refreshed, false)
})

test('claude workers can be started on another model', () => {
  assert.equal(ops.claudeLine('C:\\Users\\me\\.claude\\plugins\\cache\\h\\h\\0.2.0', { model: 'sonnet' }), 'claude --model sonnet')
  assert.equal(ops.claudeLine('D:\\x', { model: 'bad model;' }), "claude --plugin-dir 'D:\\x'")
})

test('reopening a job a codex worker completed keeps its result: renamed and in the messages', async () => {
  const codex = { from: 'wA:p3', workspace: 'wA', role: 'worker', byUser: false }
  const { job } = await ops.message(me, { to: 'wA:p3', text: 'review it' })
  await ops.jobComplete(codex, { job_id: job.job_id, summary: 'ok', result: 'FIRST RESULT: 2 findings' })
  const reopened = await ops.message(me, { to: 'wA:p3', text: 'fix finding 2' })
  assert.equal(reopened.action, 'reopened')
  assert.equal(reopened.job.status, 'sent')
  assert.match(readFileSync(join(new Store('wA').resultsDir, `${job.job_id}.round1.md`), 'utf8'), /FIRST RESULT/)
  assert.match(reopened.job.messages.find(one => one.from === 'worker').text, /FIRST RESULT: 2 findings/)
  assert.equal(existsSync(job.result_path), false)
  const again = await ops.jobComplete(codex, { job_id: job.job_id, summary: 'fixed', result: 'SECOND RESULT' })
  assert.equal(again.job.status, 'completed')
  assert.match(readFileSync(job.result_path, 'utf8'), /SECOND RESULT/)
})

test('a job is finished once even if two callers finish it', async () => {
  claudeWorker()
  const { job } = await ops.message(me, { to: 'wA:p2', text: 'x' })
  const stale = new Store('wA').getJob(job.job_id)
  await ops.turnEnd(worker, answered('answer'))
  writeFileSync(logPath, '')
  writeFileSync(stale.result_path, `job_id: ${job.job_id}\n\nanswer\n`)
  const out = await ops.jobGet(me, { job_id: job.job_id })
  assert.equal(out.job.events.filter(one => one.type === 'completed').length, 1)
})

test('a claude worker the bridge started gets the task and later messages as they are, multi-line included', async () => {
  claudeWorker()
  new Store('wA').addOwned({ pane_id: 'wA:p2', owner: 'wA:p1', kind: 'claude', name: 'w' })
  const task = 'Fix the bug in a.lua.\n\nThen run the tests.'
  const { job } = await ops.message(me, { to: 'wA:p2', text: task })
  assert.equal(job.delivered_as, 'text')
  assert.equal(prompts('wA:p2')[0][3], task)
  await ops.message(me, { to: 'wA:p2', text: 'Also update the README.' })
  assert.equal(prompts('wA:p2')[1][3], 'Also update the README.')
  // Completion still comes from the records: the turn's own end, with its answer.
  assert.equal((await ops.turnEnd(worker, answered('done'))).job.status, 'completed')
})

test('a message too long or unsafe to type goes by a file and a one-line note', async () => {
  claudeWorker()
  new Store('wA').addOwned({ pane_id: 'wA:p2', owner: 'wA:p1', kind: 'claude', name: 'w' })
  const long = 'x'.repeat(ops.DIRECT_LIMIT + 1)
  const { job } = await ops.message(me, { to: 'wA:p2', text: long })
  assert.equal(job.delivered_as, 'file')
  assert.match(prompts('wA:p2')[0][3], /^\[herdr-job .* -- Full task: .*\.md/)
  assert.match(readFileSync(job.task_path, 'utf8'), /x{100}/)
  await ops.message(me, { to: 'wA:p2', text: '/clear the cache first' })
  assert.match(prompts('wA:p2')[1][3], /^\[herdr-job .*more from wA:p1 on this same job/)
})

test('what can be typed straight into a pane', () => {
  assert.equal(ops.directText('line one\r\nline two'), 'line one\nline two')
  assert.equal(ops.directText('中文任務：修正\t錯誤'), '中文任務：修正\t錯誤')
  assert.equal(ops.directText('x'.repeat(ops.DIRECT_LIMIT)), 'x'.repeat(ops.DIRECT_LIMIT))
  assert.equal(ops.directText('x'.repeat(ops.DIRECT_LIMIT + 1)), null)
  assert.equal(ops.directText('a\u001b[2Jb'), null)
  assert.equal(ops.directText('  /compact'), null)
  assert.equal(ops.directText('!rm -rf x'), null)
  assert.equal(ops.directText('# note'), null)
  assert.equal(ops.directText('   '), null)
})

// Claude worker ↔ Claude sender by Claude's cross-session messages (0.3.0) -----

const nine = { from: 'wA:p9', workspace: 'wA', role: 'worker', byUser: false }
const NINE = { pane_id: 'wA:p9', agent: 'claude', agent_status: 'idle', workspace_id: 'wA' }

/** A Claude worker in wA:p9 started by me (a Claude sender, session-boss); `session`: what its mod reports. */
async function crossWorker({ task = 'build it', session = 'session-w', permission } = {}) {
  new Store('wA').setLease({ pane_id: 'wA:p1', kind: 'claude' })
  const out = await ops.workerNew(me, { kind: 'claude', cwd: dir, task, from_session: 'session-boss', permission_mode: permission })
  arrange({ agents: [...AGENTS, NINE], nextPane: 'wA:p9', spawnAgent: 'claude' })
  await ops.workerStart(me, { herdr_id: out.worker.herdr_id })
  if (session) {
    assert.equal(ops.workerSession(nine, { session_id: session }).recorded, true)
  }
  return { herdrId: out.worker.herdr_id, jobId: out.job.job_id }
}

test('a Claude sender\'s job for a Claude worker is not typed: it waits to be sent, the task itself with no header or length limit', async () => {
  const task = `/review this\n${'長'.repeat(ops.DIRECT_LIMIT)}`
  const { jobId } = await crossWorker({ task })
  const job = new Store('wA').getJob(jobId)
  assert.equal(job.status, 'pending')
  assert.equal(job.from_session, 'session-boss')
  assert.equal(job.outbox.text, task)
  assert.equal(prompts('wA:p9').length, 0)
  assert.equal(existsSync(job.task_path), false, 'no task file')
})

test('taking a send records the delivery before it is sent, so an answer that comes first still completes the job; it is taken once', async () => {
  const { jobId } = await crossWorker()
  const taken = ops.sendTake(me)
  assert.deepEqual(taken.items.map(one => [one.job_id, one.session_id, one.text]), [[jobId, 'session-w', 'build it']])
  assert.deepEqual(ops.sendTake(me).items, [], 'taken once')
  const sending = new Store('wA').getJob(jobId)
  assert.equal(sending.status, 'sending')
  assert.ok(sending.delivered_at)
  // The worker took it and answered before the sender's mod reported the send.
  const done = await ops.turnEnd(nine, answered('built', { prompt_at: Date.now() }))
  assert.equal(done.job.status, 'completed')
  assert.equal(ops.sendDone(me, { job_id: jobId, send_id: taken.items[0].send_id, delivered: true }).stale, true)
  assert.equal(new Store('wA').getJob(jobId).status, 'completed')
  assert.equal(calls().some(args => args[0] === 'agent' && args[1] === 'prompt'), false, 'nothing typed')
})

test('a send that fails is withdrawn: undeliverable with the reason, never typed; SendMessage again resends the same job', async () => {
  const { herdrId, jobId } = await crossWorker()
  const taken = ops.sendTake(me).items[0]
  const failed = ops.sendDone(me, { job_id: jobId, send_id: taken.send_id, delivered: false, reason: 'that session is not running' })
  assert.equal(failed.delivered, false)
  const job = new Store('wA').getJob(jobId)
  assert.equal(job.status, 'undeliverable')
  assert.equal(job.delivered_at, undefined, 'the delivery is withdrawn')
  assert.deepEqual([job.events.at(-1).type, job.events.at(-1).note], ['undeliverable', 'that session is not running'])
  assert.equal(failed.event, `${jobId}#${job.events.at(-1).seq}`)
  assert.equal(prompts('wA:p9').length, 0, 'never typed instead')
  // A turn of the worker says nothing about a job it never got.
  assert.equal((await ops.turnEnd(nine, answered('something else'))).job.status, 'undeliverable')
  const again = await ops.message(me, { to: herdrId, text: 'try again', from_session: 'session-boss-2' })
  assert.deepEqual([again.action, again.job.job_id, again.job.status], ['appended', jobId, 'pending'])
  assert.equal(again.job.outbox.text, 'build it\n\ntry again')
  assert.equal(again.job.from_session, 'session-boss-2', 'the sender\'s latest session')
  const resent = ops.sendTake(me).items[0]
  ops.sendDone(me, { job_id: jobId, send_id: resent.send_id, delivered: true })
  assert.equal(new Store('wA').getJob(jobId).status, 'sent')
})

test('a follow-up that fails goes back to the earlier delivery; one that joins while a send is out goes next', async () => {
  const { herdrId, jobId } = await crossWorker()
  const first = ops.sendTake(me).items[0]
  await ops.message(me, { to: herdrId, text: 'and test it', from_session: 'session-boss' })
  assert.equal(new Store('wA').getJob(jobId).status, 'sending', 'waits for the send that is out')
  const after = ops.sendDone(me, { job_id: jobId, send_id: first.send_id, delivered: true })
  assert.deepEqual([after.job.status, after.job.outbox.text], ['pending', 'and test it'])
  const deliveredAt = new Store('wA').getJob(jobId).delivered_at
  const second = ops.sendTake(me).items[0]
  ops.sendDone(me, { job_id: jobId, send_id: second.send_id, delivered: false, reason: 'held' })
  const job = new Store('wA').getJob(jobId)
  assert.equal(job.delivered_at, deliveredAt)
  assert.equal(job.messages.find(one => one.text === 'and test it').delivered, false)
  // The worker's turn on the task it did get still completes the job.
  assert.equal((await ops.turnEnd(nine, answered('built', { prompt_at: Date.now() }))).job.status, 'completed')
})

test('a queued job of another Claude sender waits to be sent when the worker\'s first job completes', async () => {
  const { herdrId, jobId } = await crossWorker()
  const theirs = await ops.message(other, { to: herdrId, text: 'theirs', from_session: 'session-other' })
  assert.equal(theirs.job.status, 'queued')
  const taken = ops.sendTake(me).items[0]
  ops.sendDone(me, { job_id: jobId, send_id: taken.send_id, delivered: true })
  await ops.turnEnd(nine, answered('built', { prompt_at: Date.now() }))
  const next = new Store('wA').getJob(theirs.job.job_id)
  assert.deepEqual([next.status, next.outbox.text], ['pending', 'theirs'])
  assert.deepEqual(ops.sendTake(me).items, [], 'only its own sender takes it')
  assert.deepEqual(ops.sendTake(other).items.map(one => one.session_id), ['session-w'])
  assert.equal(prompts('wA:p9').length, 0)
})

test('a Claude worker running 180 s without reporting its session: the job is undeliverable', async () => {
  const { herdrId, jobId } = await crossWorker({ session: null })
  assert.deepEqual(ops.sendTake(me), { items: [], failed: [] })
  assert.equal(new Store('wA').getJob(jobId).status, 'pending', 'still waiting')
  const store = new Store('wA')
  // A slow start (Claude loading its plugins on a busy machine) is still waited for.
  store.putWorker({ ...store.getWorker(herdrId), running_at: new Date(Date.now() - 61000).toISOString() })
  assert.deepEqual(ops.sendTake(me), { items: [], failed: [] })
  assert.equal(store.getJob(jobId).status, 'pending', 'still waiting after 61 s')
  store.putWorker({ ...store.getWorker(herdrId), running_at: new Date(Date.now() - 181000).toISOString() })
  const out = ops.sendTake(me)
  assert.equal(out.items.length, 0)
  assert.match(out.failed[0].reason, /over 180 s without reporting its Claude session/)
  const job = store.getJob(jobId)
  assert.deepEqual([job.status, job.events.at(-1).type], ['undeliverable', 'undeliverable'])
  assert.equal(prompts('wA:p9').length, 0)
})

test('Codex workers, Codex senders and Claude panes the bridge did not start keep the typed delivery', async () => {
  new Store('wA').setLease({ pane_id: 'wA:p1', kind: 'claude' })
  const codex = await ops.workerNew(me, { kind: 'codex', cwd: dir, task: 'review it', from_session: 'session-boss' })
  arrange({ agents: [...AGENTS, { ...NINE, agent: 'codex' }], nextPane: 'wA:p9', spawnAgent: 'codex' })
  await ops.workerStart(me, { herdr_id: codex.worker.herdr_id })
  assert.equal(new Store('wA').getJob(codex.job.job_id).status, 'sent')
  assert.match(prompts('wA:p9')[0][3], /^\[herdr-job /)
  // A Claude worker whose sender gave no session (a Codex commander's): typed as before.
  writeFileSync(logPath, '')
  const claude = await ops.workerNew(me, { kind: 'claude', cwd: dir, task: 'x' })
  arrange({ agents: [...AGENTS, NINE, { ...NINE, pane_id: 'wA:pB' }], nextPane: 'wA:pB', spawnAgent: 'claude' })
  await ops.workerStart(me, { herdr_id: claude.worker.herdr_id })
  assert.deepEqual([new Store('wA').getJob(claude.job.job_id).status, prompts('wA:pB')[0][3]], ['sent', 'x'])
  // A Claude pane the bridge did not start, from a Claude sender: typed as before.
  claudeWorker()
  const plain = await ops.message(me, { to: 'wA:p2', text: 'do it', from_session: 'session-boss' })
  assert.equal(plain.job.status, 'sent')
  assert.equal((await ops.turnEnd(worker, answered('done'))).notice, undefined, 'and its answer is not relayed')
})

test('the worker\'s result and its reports along the way come back as notices for its mod to send, marked so the sender does not repeat them', async () => {
  const { jobId } = await crossWorker()
  const taken = ops.sendTake(me).items[0]
  ops.sendDone(me, { job_id: jobId, send_id: taken.send_id, delivered: true })
  const routed = await ops.route(nine, { to: 'main', text: 'Halfway', from_session: 'session-w' })
  assert.equal(routed.action, 'reply')
  assert.equal(routed.notice.session_id, 'session-boss')
  const message = routed.notice.job.events.find(one => one.seq === routed.notice.event_seq)
  assert.deepEqual([message.type, message.relay], ['message', 'sending'])
  assert.equal(routed.notice.worker.herdr_id, routed.notice.job.worker)
  assert.deepEqual(ops.relayDone(nine, { job_id: jobId, event_seq: routed.notice.event_seq, delivered: false, reason: 'held for approval' }), { relayed: false })
  const marked = new Store('wA').getJob(jobId).events.find(one => one.seq === routed.notice.event_seq)
  assert.deepEqual([marked.relay, marked.relay_error], ['failed', 'held for approval'])
  const done = await ops.turnEnd(nine, answered('All built.', { prompt_at: Date.now() }))
  assert.equal(done.completed, true)
  const completed = done.notice.job.events.find(one => one.seq === done.notice.event_seq)
  assert.deepEqual([completed.type, completed.via, completed.relay], ['completed', 'answer', 'sending'])
  assert.equal(done.notice.job.messages.find(one => one.seq === completed.message_seq).text, 'All built.')
  ops.relayDone(nine, { job_id: jobId, event_seq: done.notice.event_seq, delivered: true })
  assert.equal(new Store('wA').getJob(jobId).events.find(one => one.seq === done.notice.event_seq).relay, 'sent')
  assert.throws(() => ops.relayDone(other, { job_id: jobId, event_seq: 1, delivered: true }), /no job/)
})

test('a worker\'s session is recorded on its live worker by pane, which the worker gets before its agent starts', async () => {
  new Store('wA').setLease({ pane_id: 'wA:p1', kind: 'claude' })
  const out = await ops.workerNew(me, { kind: 'claude', cwd: dir, task: 'x', from_session: 'session-boss' })
  assert.deepEqual(ops.workerSession(nine, { session_id: 's' }), { recorded: false }, 'no pane yet')
  // Starting the agent fails; the pane id was on the record before that.
  arrange({ agents: AGENTS, nextPane: 'wA:p9', spawnAgent: null, failOn: 'pane run' })
  await ops.workerStart(me, { herdr_id: out.worker.herdr_id })
  assert.equal(new Store('wA').getWorker(out.worker.herdr_id).pane_id, 'wA:p9')
  assert.throws(() => ops.workerSession(nine, {}), /session_id is required/)
})

test('a send taken 60 s ago whose result never came back: undeliverable, its delivery kept, the sender told to check the output first', async () => {
  const { jobId } = await crossWorker()
  const taken = ops.sendTake(me).items[0]
  const store = new Store('wA')
  assert.deepEqual(ops.sendTake(me), { items: [], failed: [] }, 'not yet')
  const stuck = store.getJob(jobId)
  store.putJob({ ...stuck, outbox: { ...stuck.outbox, taken_at: new Date(Date.now() - 61000).toISOString() } })
  const out = ops.sendTake(me)
  assert.equal(out.items.length, 0)
  assert.match(out.failed[0].reason, /never came back, so the message may or may not have arrived; Read the worker's output file \(.*\.md\) before sending it again/)
  const job = store.getJob(jobId)
  assert.deepEqual([job.status, job.events.at(-1).type, job.delivered_at], ['undeliverable', 'undeliverable', stuck.delivered_at])
  assert.equal(out.failed[0].event, `${jobId}#${job.seq}`)
  // The late result changes nothing; an answer to the message still completes the job.
  assert.equal(ops.sendDone(me, { job_id: jobId, send_id: taken.send_id, delivered: true }).stale, true)
  assert.equal((await ops.turnEnd(nine, answered('built', { prompt_at: Date.now() }))).job.status, 'completed')
})

test('a message the sender\'s model sent the worker past the bridge joins the open job, delivered when it arrived', async () => {
  const { jobId } = await crossWorker()
  const taken = ops.sendTake(me).items[0]
  ops.sendDone(me, { job_id: jobId, send_id: taken.send_id, delivered: true })
  const arrived = Date.now() + 5000
  const out = ops.peerMessage(nine, { text: 'also update the README', received_at: arrived })
  assert.deepEqual([out.recorded, out.job_id, out.how], [true, jobId, 'appended'])
  const job = new Store('wA').getJob(jobId)
  assert.equal(job.delivered_at, new Date(arrived).toISOString(), 'the arrival time, not the bridge\'s now')
  assert.deepEqual(job.messages.at(-1), { ...job.messages.at(-1), from: 'sender', text: 'also update the README', delivered: true })
  assert.equal(job.from_session, 'session-boss', 'kept')
  // A turn that took it (its prompt at the arrival) completes the job; one before it does not.
  assert.equal((await ops.turnEnd(nine, answered('early', { prompt_at: arrived - 1000 }))).completed, undefined)
  const done = await ops.turnEnd(nine, answered('README updated', { prompt_at: arrived }))
  assert.equal(done.job.status, 'completed')
  assert.equal(done.notice.session_id, 'session-boss')
  assert.equal(prompts('wA:p9').length, 0)
})

test('a message past the bridge after the job completed reopens it; with no job of the owner, nothing', async () => {
  new Store('wA').setLease({ pane_id: 'wA:p1', kind: 'claude' })
  const bare = await ops.workerNew(me, { kind: 'claude', cwd: dir, task: 'x', from_session: 'session-boss' })
  assert.deepEqual(ops.peerMessage(nine, { text: 'hi', received_at: Date.now() }), { recorded: false }, 'no pane yet')
  await ops.stop(me, { target: bare.worker.herdr_id })
  const { jobId } = await crossWorker()
  const taken = ops.sendTake(me).items[0]
  ops.sendDone(me, { job_id: jobId, send_id: taken.send_id, delivered: true })
  await ops.turnEnd(nine, answered('first answer', { prompt_at: Date.now() }))
  assert.equal(new Store('wA').getJob(jobId).status, 'completed')
  const arrived = Date.now()
  const out = ops.peerMessage(nine, { text: '收到回覆三', received_at: arrived, from_session: 'session-boss-2' })
  assert.deepEqual([out.recorded, out.job_id, out.how], [true, jobId, 'reopened'])
  const job = new Store('wA').getJob(jobId)
  assert.deepEqual([job.status, job.delivered_at, job.from_session], ['sent', new Date(arrived).toISOString(), 'session-boss-2'])
  assert.match(readFileSync(join(new Store('wA').resultsDir, `${jobId}.round1.md`), 'utf8'), /first answer/)
  const again = await ops.turnEnd(nine, answered('收到回覆三，已處理', { prompt_at: arrived }))
  assert.equal(again.job.status, 'completed')
  assert.equal(again.notice.session_id, 'session-boss-2')
  assert.equal(again.job.messages.some(one => one.text === '收到回覆三'), true)
  assert.equal(prompts('wA:p9').length, 0)
  assert.throws(() => ops.peerMessage(nine, { text: ' ' }), /text is required/)
  assert.deepEqual(ops.peerMessage(other, { text: 'not a worker', received_at: Date.now() }), { recorded: false })
})

test('a Claude worker starts in its sender\'s permission mode; an unknown mode is left out', async () => {
  await crossWorker({ permission: 'acceptEdits' })
  const run = calls().find(args => args[0] === 'pane' && args[1] === 'run')
  assert.match(run[3], / --permission-mode acceptEdits$/)
  assert.equal(ops.claudeLine('C:\\Users\\me\\.claude\\plugins\\cache\\h\\h\\0.3.0', { model: 'sonnet', permissionMode: 'plan' }), 'claude --model sonnet --permission-mode plan')
  assert.equal(ops.claudeLine('C:\\Users\\me\\.claude\\plugins\\cache\\h\\h\\0.3.0', { permissionMode: 'yolo; rm' }), 'claude')
})
