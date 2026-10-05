// Stand-in for herdr.exe in tests. State and a call log live in files named by
// FAKE_HERDR_STATE / FAKE_HERDR_LOG so the test can arrange and inspect them.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const statePath = process.env.FAKE_HERDR_STATE
const state = JSON.parse(readFileSync(statePath, 'utf8'))
appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify(args)}\n`)

function reply(result) {
  process.stdout.write(`${JSON.stringify({ id: 'fake', result })}\n`)
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: { message } })}\n`)
  process.exit(1)
}

const [group, verb] = args
if (state.failOn && args.join(' ').startsWith(state.failOn)) {
  fail(`forced failure: ${state.failOn}`)
}

if (group === 'agent' && verb === 'list') {
  reply({ agents: state.agents, type: 'agent_list' })
} else if (group === 'pane' && verb === 'get') {
  const pane = state.agents.find(one => one.pane_id === args[2]) ?? (state.panes ?? []).find(one => one.pane_id === args[2])
  if (!pane) fail(`pane ${args[2]} not found`)
  reply({ pane, type: 'pane_info' })
} else if (group === 'pane' && verb === 'split') {
  const id = state.nextPane ?? 'wA:p9'
  state.panes = [...(state.panes ?? []), { pane_id: id, agent: state.spawnAgent ?? null, agent_status: state.spawnStatus ?? 'idle', workspace_id: 'wA' }]
  writeFileSync(statePath, JSON.stringify(state))
  reply({ pane: { pane_id: id }, type: 'pane_split' })
} else if ((group === 'agent' || group === 'pane') && verb === 'read') {
  process.stdout.write(state.readText ?? 'hello from pane\n')
} else if (group === 'agent' && verb === 'explain') {
  process.stdout.write('agent: codex\nstate: idle\n')
} else {
  reply({ ok: true, type: `${group}_${verb}` })
}
