#!/usr/bin/env node
// Commander dashboard for a Codex commander: a plain TUI in its own herdr pane.
// node dashboard.mjs --pane <commander pane> --workspace <ws>
// Keys: up/down select · f focus · x interrupt (asks y/n) · r refresh · q quit
import { emitKeypressEvents } from 'node:readline'

import * as ops from './lib/ops.mjs'

const argv = process.argv.slice(2)
const ctx = { from: '', workspace: process.env.HERDR_WORKSPACE_ID || '', role: 'commander', byUser: true }
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--pane') ctx.from = argv[++i] ?? ''
  else if (argv[i] === '--workspace') ctx.workspace = argv[++i] ?? ''
}

const ORDER = { blocked: 0, working: 1, done: 2, unknown: 3, idle: 4 }
const MARK = { blocked: '\x1b[31m▲', working: '\x1b[33m●', done: '\x1b[32m◆', unknown: '\x1b[90m?', idle: '\x1b[2m○' }
const RESET = '\x1b[0m'

let agents = []
let jobs = []
let holder = null
let selected = 0
let message = ''
let pendingInterrupt = null
let error = ''
let busy = false

function clip(text, width) {
  const value = String(text ?? '')
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value
}

async function refresh() {
  if (busy) return
  busy = true
  try {
    agents = (await ops.listAgents(ctx)).filter(one => one.pane_id !== ctx.from && !one.is_self)
    agents.sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.pane_id.localeCompare(b.pane_id))
    jobs = (await ops.jobGet(ctx, { limit: 8 })).jobs
    await ops.wakePending(ctx)
    holder = ops.lease(ctx).lease
    error = ''
  } catch (failure) {
    error = String(failure.message ?? failure)
  } finally {
    busy = false
  }
  selected = Math.min(selected, Math.max(0, agents.length - 1))
  draw()
}

function draw() {
  const width = process.stdout.columns || 100
  const out = ['\x1b[2J\x1b[H']
  const blocked = agents.filter(one => one.status === 'blocked').length
  const head = `Commander ${ctx.from} · ${ctx.workspace} · lease ${holder ? holder.pane_id : 'none'} · ${agents.length} agents · ${blocked} blocked`
  out.push(`\x1b[1m${clip(head, width)}${RESET}`)
  if (error) out.push(`\x1b[31m${clip(`herdr: ${error}`, width)}${RESET}`)
  out.push('')
  if (agents.length === 0) out.push('\x1b[2mno other agents in this herdr session\x1b[0m')
  agents.forEach((agent, index) => {
    const pointer = index === selected ? '\x1b[7m' : ''
    const tags = [agent.role !== 'plain' ? agent.role : '', agent.job_id ? `job ${agent.job_id.slice(-4)}` : ''].filter(Boolean).join(' ')
    const line = `${MARK[agent.status] ?? '?'} ${agent.pane_id.padEnd(7)} ${agent.kind.padEnd(7)} ${agent.status.padEnd(8)}${RESET}${pointer} ${clip(agent.title, Math.max(10, width - 48))} ${tags ? `[${tags}]` : ''}`
    out.push(`${pointer}${line}${RESET}`)
  })
  out.push('')
  out.push('\x1b[1mjobs\x1b[0m')
  if (jobs.length === 0) out.push('\x1b[2m(none)\x1b[0m')
  for (const job of jobs) {
    out.push(clip(`${job.status.padEnd(16)} ${job.job_id}  → ${job.to}  ${job.summary || job.body.split('\n')[0]}`, width))
  }
  out.push('')
  out.push(pendingInterrupt ? `\x1b[33minterrupt ${pendingInterrupt}? y = Esc, Y = Ctrl+C, n = cancel\x1b[0m` : '\x1b[2m↑↓ select · f focus · x interrupt · r refresh · q quit\x1b[0m')
  if (message) out.push(clip(message, width))
  process.stdout.write(out.join('\n'))
}

async function onKey(text, key) {
  const name = key?.name ?? text
  if (pendingInterrupt) {
    const target = pendingInterrupt
    pendingInterrupt = null
    if (text === 'y' || text === 'Y') {
      try {
        await ops.interrupt(ctx, { target, hard: text === 'Y' })
        message = `sent ${text === 'Y' ? 'Ctrl+C' : 'Esc'} to ${target}`
      } catch (failure) {
        message = String(failure.message ?? failure)
      }
    } else {
      message = 'interrupt cancelled'
    }
    draw()
    return
  }
  if (name === 'q' || (key?.ctrl && name === 'c')) {
    process.stdout.write('\x1b[2J\x1b[H')
    process.exit(0)
  }
  const agent = agents[selected]
  if (name === 'up') selected = Math.max(0, selected - 1)
  else if (name === 'down') selected = Math.min(agents.length - 1, selected + 1)
  else if (name === 'r') await refresh()
  else if (name === 'f' && agent) {
    try {
      await ops.focus(ctx, { target: agent.pane_id })
      message = `focused ${agent.pane_id}`
    } catch (failure) {
      message = String(failure.message ?? failure)
    }
  } else if (name === 'x' && agent) {
    pendingInterrupt = agent.pane_id
  }
  draw()
}

if (process.stdin.isTTY) {
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.on('keypress', (text, key) => {
    onKey(text, key).catch(failure => {
      message = String(failure.message ?? failure)
      draw()
    })
  })
}
process.stdout.on('resize', draw)
await refresh()
setInterval(refresh, 3000)
