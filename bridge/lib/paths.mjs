// The bridge's own files sit inside the plugin (the repo root, or its copy in
// Claude Code's plugin cache); runtime data lives outside it so a plugin update
// keeps it and every copy (installed, --plugin-dir, the Codex launcher) shares it.
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TOOL_ROOT = resolve(BRIDGE_DIR, '..')
export const CODEX_DIR = join(TOOL_ROOT, 'codex')
export const CLI_PATH = join(BRIDGE_DIR, 'cli.mjs')
export const MCP_PATH = join(BRIDGE_DIR, 'mcp.mjs')
export const DASHBOARD_PATH = join(BRIDGE_DIR, 'dashboard.mjs')

/** Runtime data root: %LOCALAPPDATA%\herdr-commander\runtime; HERDR_BRIDGE_RUNTIME overrides it (tests). */
export function runtimeRoot() {
  if (process.env.HERDR_BRIDGE_RUNTIME) {
    return process.env.HERDR_BRIDGE_RUNTIME
  }
  return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'herdr-commander', 'runtime')
}

/**
 * True when this copy is the one Claude Code installed (in its plugin cache):
 * a plain `claude` then loads it, while a working copy is passed by --plugin-dir.
 */
export function isInstalledCopy(root = TOOL_ROOT) {
  return /[\\/]plugins[\\/]cache[\\/]/i.test(root)
}

/** One workspace's folder: jobs/, results/, tasks/, workers/, out/, panes/, lease.json, owned.json. */
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
