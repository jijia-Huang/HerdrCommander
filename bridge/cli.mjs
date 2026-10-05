#!/usr/bin/env node
// herdr-bridge CLI: node cli.mjs <command> [json | b64:<base64 json>] [--pane P] [--workspace W] [--role R] [--by-user]
// Prints one JSON line: { ok: true, result } or { ok: false, error: { code, message } }.
import { COMMANDS } from './lib/registry.mjs'

function parse(argv) {
  const [command, ...rest] = argv
  const ctx = {
    from: process.env.HERDR_PANE_ID || '',
    workspace: process.env.HERDR_WORKSPACE_ID || '',
    role: process.env.HERDR_COMMANDER_ROLE || 'plain',
    byUser: false,
  }
  let args = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === '--pane') {
      ctx.from = rest[++i] ?? ''
    } else if (token === '--workspace') {
      ctx.workspace = rest[++i] ?? ''
    } else if (token === '--role') {
      ctx.role = rest[++i] ?? 'plain'
    } else if (token === '--by-user') {
      ctx.byUser = true
    } else if (token.startsWith('b64:')) {
      args = JSON.parse(Buffer.from(token.slice(4), 'base64').toString('utf8'))
    } else {
      args = JSON.parse(token)
    }
  }
  return { command, ctx, args }
}

async function main() {
  let parsed
  try {
    parsed = parse(process.argv.slice(2))
  } catch (error) {
    return { ok: false, error: { code: 'bad_args', message: String(error.message ?? error) } }
  }
  const entry = COMMANDS[parsed.command]
  if (!entry) {
    return { ok: false, error: { code: 'unknown_command', message: `unknown command: ${parsed.command}; known: ${Object.keys(COMMANDS).join(', ')}` } }
  }
  try {
    return { ok: true, result: await entry.run(parsed.ctx, parsed.args) }
  } catch (error) {
    return { ok: false, error: { code: error.code ?? 'error', message: String(error.message ?? error) } }
  }
}

/**
 * codex-launch runs Codex in this terminal (stdio inherited) with the role's
 * -c overrides. Node quotes each argv entry for Windows itself, which the
 * pane's PowerShell 5.1 would not do for the embedded quotes in them.
 */
async function codexLaunch(ctx, args) {
  const { codexArgs, codexEntry } = await import('./lib/ops.mjs')
  const { runJson } = await import('./lib/herdr.mjs')
  const { DASHBOARD_PATH } = await import('./lib/paths.mjs')
  const role = args.role ?? 'commander'
  const pane = args.pane || ctx.from
  const workspace = args.workspace || ctx.workspace
  if (process.env.HERDR_ENV !== '1' || !pane) {
    process.stderr.write('herdr-codex: not inside a herdr pane; start plain codex instead.\n')
    return 2
  }
  if (role === 'commander' && args.dashboard) {
    try {
      const split = await runJson(['pane', 'split', '--pane', pane, '--direction', 'down', '--ratio', '0.7', '--no-focus', '--env', 'HERDR_COMMANDER_ROLE=dashboard'])
      const dash = split?.pane?.pane_id
      if (dash) {
        const { Store } = await import('./lib/store.mjs')
        new Store(workspace).addOwned({ pane_id: dash, owner: pane, kind: 'dashboard', name: 'commander-dashboard', created_at: new Date().toISOString() })
        await runJson(['pane', 'rename', dash, 'commander-dashboard']).catch(() => {})
        await runJson(['pane', 'run', dash, `& '${process.execPath}' '${DASHBOARD_PATH}' --pane ${pane} --workspace ${workspace}`])
      }
    } catch (error) {
      process.stderr.write(`herdr-codex: dashboard not opened: ${error.message}\n`)
    }
  }
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [codexEntry(), ...codexArgs({ role, pane, workspace }), ...(args.extra ?? [])], {
    stdio: 'inherit',
    env: { ...process.env, HERDR_COMMANDER_ROLE: role },
  })
  const code = await new Promise(done => child.on('exit', exit => done(exit ?? 0)))
  // Codex has no session-end hook: give the commander lease back here.
  if (role === 'commander') {
    const { release } = await import('./lib/ops.mjs')
    try {
      release({ from: pane, workspace }, {})
    } catch {}
  }
  return code
}

const first = process.argv[2]
if (first === 'codex-launch') {
  const { ctx, args } = parse(process.argv.slice(2))
  process.exitCode = await codexLaunch(ctx, args)
} else {
  const out = await main()
  process.stdout.write(`${JSON.stringify(out)}\n`)
  process.exitCode = out.ok ? 0 : 1
}
