// The world beneath the mod in tests: env, a fake bridge behind $.process.run,
// and a record of what the mod asked the engine to do.
import type { On, RenderElement, RenderNode } from 'claude-code'

export type BridgeCall = { command: string; args: Record<string, unknown>; flags: string[] }

export type World = {
  bridge: BridgeCall[]
  tools: string[]
  agentTypes: string[]
  commands: string[]
  opened: string[]
  closed: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  /** Replies per bridge command; a function gets the call. */
  replies: Record<string, unknown | ((call: BridgeCall) => unknown)>
  failures: Record<string, { code: string; message: string }>
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function fromBase64(text: string): string {
  const clean = text.replace(/=+$/, '')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    buffer = (buffer << 6) | B64.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 255)
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

export const HERDR_ENV = { HERDR_ENV: '1', HERDR_PANE_ID: 'wA:p1', HERDR_WORKSPACE_ID: 'wA', HERDR_BRIDGE_RUNTIME: 'C:/rt' }

export const AGENTS = [
  { pane_id: 'wA:p1', name: null, kind: 'claude', status: 'working', title: 'me', cwd: 'D:\\work', workspace_id: 'wA', role: 'plain', job_id: null, owned_by: null, is_self: true, focused: true },
  { pane_id: 'wA:p2', name: 'impl-ab12', kind: 'codex', status: 'blocked', title: 'Allow git apply?', cwd: 'D:\\work', workspace_id: 'wA', role: 'worker', job_id: 'job-1', owned_by: 'wA:p1', is_self: false, focused: false },
  { pane_id: 'wD:p2', name: null, kind: 'claude', status: 'idle', title: 'LLMWIKI cleanup', cwd: 'D:\\LLMWIKI', workspace_id: 'wD', role: 'plain', job_id: null, owned_by: null, is_self: false, focused: false },
]

export function worldOf(on: On, env: Readonly<Record<string, string>> = {}): World {
  const world: World = {
    bridge: [],
    tools: [],
    agentTypes: [],
    commands: [],
    opened: [],
    closed: [],
    toasts: [],
    statuses: [],
    replies: {
      snapshot: { agents: AGENTS, lease: null, jobs: [], workers: [], panes_dir: 'C:/rt/wA/panes' },
      agents: AGENTS,
      claim: { claimed: true, holder: { pane_id: 'wA:p1', kind: 'claude' } },
      release: { released: true },
      read: { pane_id: 'wA:p2', text: 'line one\nAllow git apply? (y/n)' },
    },
    failures: {},
  }

  on('session.start', () => ({ cwd: 'D:\work' }))
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('store.delete', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: 'D:\\work' }))

  on('process.run', ($, e) => {
    const argv = e.argv
    const command = argv[2] ?? ''
    const payload = argv[3] ?? ''
    const args = payload.startsWith('b64:') ? (JSON.parse(fromBase64(payload.slice(4))) as Record<string, unknown>) : {}
    const call: BridgeCall = { command, args, flags: argv.slice(4) }
    world.bridge.push(call)
    const failure = world.failures[command]
    const reply = world.replies[command]
    const body = failure
      ? { ok: false, error: failure }
      : { ok: true, result: typeof reply === 'function' ? (reply as (one: BridgeCall) => unknown)(call) : (reply ?? {}) }
    return {
      value: { exitCode: failure ? 1 : 0, stdout: `${JSON.stringify(body)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    } as never
  })

  on('tool.register', ($, e) => {
    world.tools.push(e.name)
    return { value: { tool: `mcp__herdr-commander__${e.name}` } }
  })

  on('agent.register', ($, e) => {
    world.agentTypes.push(e.name)
    return { value: { agent: `herdr-commander:${e.name}` } } as never
  })

  on('command.register', ($, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })

  on('ui.open', ($, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })

  on('ui.close', ($, e) => {
    world.closed.push(e.id)
    return { value: undefined }
  })

  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })

  on('ui.status', ($, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })

  on('ui.invalidate', () => ({ value: undefined }))

  return world
}

export const SESSION = { surface: 'terminal', isInteractive: true, cwd: 'D:\\work' } as const

export const command = (name: string, args = '') => ({
  command: name,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 180 },
})

export const PANE = {
  component: 'Pane' as const,
  surface: 'terminal' as const,
  requestId: 'commander',
  viewport: { columns: 180, rows: 48, isFullscreen: true },
  props: {
    title: 'Commander',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 44 },
    view: {},
  },
}

export function textOf(node: RenderNode | RenderElement | null | undefined): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  const props = (node as { props?: Record<string, unknown> }).props
  const own = node.type === 'Button' && typeof props?.label === 'string' ? `[${props.label}]` : ''
  const children = (node as { children?: readonly RenderNode[] }).children ?? []
  return own + children.map(child => textOf(child)).join('')
}
