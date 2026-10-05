// Every path the bridge touches lives under Tools/HerdrCommander (project isolation).
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TOOL_ROOT = resolve(BRIDGE_DIR, '..')
export const MOD_DIR = join(TOOL_ROOT, 'claude-mod')
export const CODEX_DIR = join(TOOL_ROOT, 'codex')
export const CLI_PATH = join(BRIDGE_DIR, 'cli.mjs')
export const MCP_PATH = join(BRIDGE_DIR, 'mcp.mjs')
export const DASHBOARD_PATH = join(BRIDGE_DIR, 'dashboard.mjs')

/** Runtime data root; HERDR_BRIDGE_RUNTIME overrides it (tests). */
export function runtimeRoot() {
  return process.env.HERDR_BRIDGE_RUNTIME || join(TOOL_ROOT, '.runtime')
}

/** One workspace's folder: jobs/, results/, bg/, lease.json, owned.json. */
export function workspaceDir(workspaceId) {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
    throw new BridgeError('bad_workspace', `invalid workspace id: ${workspaceId}`)
  }
  return join(runtimeRoot(), workspaceId)
}

export class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
