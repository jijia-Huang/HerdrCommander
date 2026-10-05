#!/usr/bin/env node
// herdr-bridge as an MCP server over STDIO (newline-delimited JSON-RPC 2.0).
// No network listener. Identity comes from --pane/--workspace/--role (set by the
// launcher), falling back to the HERDR_* environment.
import { createInterface } from 'node:readline'

import { COMMANDS, toolsFor } from './lib/registry.mjs'

const ctx = {
  from: process.env.HERDR_PANE_ID || '',
  workspace: process.env.HERDR_WORKSPACE_ID || '',
  role: process.env.HERDR_COMMANDER_ROLE || 'plain',
  // Only Codex runs this server (claude panes use the mod): leases it takes are codex leases.
  kind: 'codex',
  byUser: false,
}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--pane') ctx.from = argv[++i] ?? ''
  else if (argv[i] === '--workspace') ctx.workspace = argv[++i] ?? ''
  else if (argv[i] === '--role') ctx.role = argv[++i] ?? 'plain'
}
if (!ctx.workspace && /^w[^:]+:/.test(ctx.from)) {
  ctx.workspace = ctx.from.split(':')[0]
}

const tools = toolsFor(ctx.role)

// A commander's MCP server lives as long as its Codex: it retries the wake of
// completed jobs whose sender was busy when they finished.
if (ctx.role === 'commander' && ctx.from && ctx.workspace) {
  const timer = setInterval(() => {
    COMMANDS['wake-pending'].run(ctx, {}).catch(() => {})
  }, 10000)
  timer.unref()
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handle(request) {
  const { id, method, params } = request
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'herdr-bridge', version: '0.1.0' },
      instructions: `herdr-bridge for pane ${ctx.from || '?'} (${ctx.role}). Jobs are complete only when herdr_job_get says completed.`,
    }
  }
  if (method === 'ping') {
    return {}
  }
  if (method === 'tools/list') {
    return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }
  }
  if (method === 'tools/call') {
    const tool = tools.find(one => one.name === params?.name)
    if (!tool) {
      return { content: [{ type: 'text', text: `unknown tool for role ${ctx.role}: ${params?.name}` }], isError: true }
    }
    try {
      const result = await COMMANDS[tool.command].run(ctx, params?.arguments ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: `${error.code ?? 'error'}: ${error.message ?? error}` }], isError: true }
    }
  }
  if (id === undefined) {
    return undefined
  }
  throw Object.assign(new Error(`method not found: ${method}`), { rpc: -32601 })
}

const lines = createInterface({ input: process.stdin })
lines.on('line', async line => {
  if (line.trim() === '') {
    return
  }
  let request
  try {
    request = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  try {
    const result = await handle(request)
    if (request.id !== undefined && result !== undefined) {
      send({ jsonrpc: '2.0', id: request.id, result })
    }
  } catch (error) {
    if (request.id !== undefined) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: error.rpc ?? -32603, message: String(error.message ?? error) } })
    }
  }
})
