// The only place the bridge runs herdr. Commands are argv arrays (no shell).
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

import { BridgeError } from './paths.mjs'

const FALLBACK_EXE = 'C:\\Users\\jijiahuang\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe'

/**
 * Commands no caller may run through the bridge, whatever asks:
 * stopping the server or sessions, and closing layout the bridge did not make.
 * `pane close` is checked separately against the owned-pane list (ops.mjs).
 */
const FORBIDDEN = [
  ['server', 'stop'],
  ['server', 'live-handoff'],
  ['session', 'stop'],
  ['session', 'delete'],
  ['workspace', 'close'],
  ['tab', 'close'],
  ['worktree', 'remove'],
  ['integration', 'install'],
  ['integration', 'uninstall'],
  ['plugin', 'install'],
  ['plugin', 'uninstall'],
]

export function isForbidden(args) {
  return FORBIDDEN.some(([a, b]) => args[0] === a && args[1] === b)
}

/** How to start herdr: a test may point HERDR_BRIDGE_HERDR_JS at a fake script. */
function command() {
  if (process.env.HERDR_BRIDGE_HERDR_JS) {
    return { file: process.execPath, prefix: [process.env.HERDR_BRIDGE_HERDR_JS] }
  }
  if (process.env.HERDR_BRIDGE_HERDR) {
    return { file: process.env.HERDR_BRIDGE_HERDR, prefix: [] }
  }
  return { file: existsSync(FALLBACK_EXE) ? FALLBACK_EXE : 'herdr', prefix: [] }
}

/**
 * Runs `herdr <args>` and returns `{ code, stdout, stderr }`.
 * Never throws for a non-zero exit; throws BridgeError for a forbidden command
 * or when herdr cannot start.
 */
export function runRaw(args, { timeoutMs = 20000 } = {}) {
  if (isForbidden(args)) {
    return Promise.reject(new BridgeError('forbidden', `herdr ${args.slice(0, 2).join(' ')} is not allowed through the bridge`))
  }
  const { file, prefix } = command()
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...prefix, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error && typeof error.code === 'string' && error.code === 'ENOENT') {
          reject(new BridgeError('herdr_missing', 'herdr executable not found'))
          return
        }
        if (error && error.killed) {
          resolvePromise({ code: 124, stdout: String(stdout), stderr: `timeout after ${timeoutMs}ms` })
          return
        }
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

/** Runs herdr and parses its JSON reply; a server error becomes BridgeError. */
export async function runJson(args, options) {
  const { code, stdout, stderr } = await runRaw(args, options)
  if (code === 124) {
    throw new BridgeError('timeout', stderr)
  }
  const text = stdout.trim()
  if (code !== 0) {
    throw new BridgeError('herdr_error', (stderr.trim() || text || `herdr exited ${code}`).slice(0, 500))
  }
  if (text === '') {
    return null
  }
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && 'result' in parsed ? parsed.result : parsed
  } catch {
    return { text }
  }
}

/** Runs herdr for its text output (pane read, agent read). */
export async function runText(args, options) {
  const { code, stdout, stderr } = await runRaw(args, options)
  if (code === 124) {
    throw new BridgeError('timeout', stderr)
  }
  if (code !== 0) {
    throw new BridgeError('herdr_error', (stderr.trim() || stdout.trim() || `herdr exited ${code}`).slice(0, 500))
  }
  return stdout
}
