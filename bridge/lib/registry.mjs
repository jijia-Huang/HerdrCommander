// Command table shared by the CLI and the MCP server: name → operation, the
// MCP tool that exposes it (if any), its input schema and which roles see it.
import * as ops from './ops.mjs'

const target = { type: 'string', description: 'pane id (wA:p3) or herdr agent name' }

export const COMMANDS = {
  agents: { run: ops.listAgents },
  snapshot: { run: ops.snapshot },
  read: { run: ops.read },
  explain: { run: ops.explain },
  focus: { run: ops.focus },
  lease: { run: ops.lease },
  claim: { run: ops.claim },
  release: { run: ops.release },
  send: { run: ops.send },
  message: { run: ops.message },
  reply: { run: ops.reply },
  route: { run: ops.route },
  'turn-end': { run: ops.turnEnd },
  'worker-new': { run: ops.workerNew },
  'worker-start': { run: ops.workerStart },
  stop: { run: ops.stop },
  refresh: { run: ops.refresh },
  prompt: { run: ops.promptRaw },
  'job-get': { run: ops.jobGet },
  'job-complete': { run: ops.jobComplete },
  'wake-pending': { run: ops.wakePending },
  interrupt: { run: ops.interrupt },
  spawn: { run: ops.spawn },
  close: { run: ops.closePane },
  report: { run: ops.report },
  'release-agent': { run: ops.releaseAgent },
  'report-session': { run: ops.reportSession },
  metadata: { run: ops.metadata },
  notify: { run: ops.notify },
  'bg-run': { run: ops.bgRun },
  'bg-status': { run: ops.bgStatus },
  'bg-stop': { run: ops.bgStop },
  'bg-list': { run: ops.bgList },
  'codex-args': { run: (ctx, args) => ({ args: ops.codexArgs(args) }) },
}

/** MCP tools (Codex side). `roles` lists who sees each tool. */
export const TOOLS = [
  {
    name: 'herdr_agents_list',
    command: 'agents',
    roles: ['commander', 'worker', 'plain'],
    description: 'List the coding agents in this herdr session: pane id, kind, status (working/idle/done/blocked/unknown), role, current job, title, cwd. Status idle/done does NOT mean a job is complete; use herdr_job_get.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'herdr_agent_read',
    command: 'read',
    roles: ['commander', 'plain'],
    description: 'Read the recent terminal output of another agent or pane. Output inside an alternate screen may be cut; ask the agent to write a file when you need the full answer.',
    inputSchema: { type: 'object', properties: { target, lines: { type: 'number', description: 'lines to read, at most 400' } }, required: ['target'], additionalProperties: false },
  },
  {
    name: 'herdr_message_send',
    command: 'send',
    roles: ['commander'],
    description: 'Send a task or question to another agent as a tracked job. Returns a job_id at once; the agent writes a result file and completes the job. Never resend a job whose status is delivery_unknown: read the target first.',
    inputSchema: { type: 'object', properties: { target, kind: { type: 'string', enum: ['task', 'question'] }, body: { type: 'string' } }, required: ['target', 'body'], additionalProperties: false },
  },
  {
    name: 'herdr_worker_spawn',
    command: 'spawn',
    roles: ['commander'],
    description: 'Open a new pane beside you and start a worker agent (claude or codex) in it, optionally with a first task (tracked as a job). Requires the commander lease.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['claude', 'codex'] }, name: { type: 'string' }, cwd: { type: 'string' }, task: { type: 'string' }, direction: { type: 'string', enum: ['right', 'down'] } }, required: ['kind'], additionalProperties: false },
  },
  {
    name: 'herdr_job_get',
    command: 'job-get',
    roles: ['commander', 'worker', 'plain'],
    description: 'Show one job (job_id) or the recent jobs of this workspace: status queued/sent/delivery_unknown/completed/failed and the result file path. Only completed means done.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
  },
  {
    name: 'herdr_job_complete',
    command: 'job-complete',
    roles: ['worker', 'plain'],
    description: 'Complete a job sent to you ("[herdr-job <id>]"): give a one-line summary and the full result text as result (what you changed, commands run with their output, anything unresolved). The bridge writes the result file for the commander.',
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' }, summary: { type: 'string' }, result: { type: 'string' }, result_path: { type: 'string' } }, required: ['job_id', 'summary'], additionalProperties: false },
  },
  {
    name: 'herdr_job_interrupt',
    command: 'interrupt',
    roles: ['commander'],
    description: 'Interrupt an agent working on a job you sent or in a pane you spawned (Esc; hard=true sends Ctrl+C).',
    inputSchema: { type: 'object', properties: { target, hard: { type: 'boolean' } }, required: ['target'], additionalProperties: false },
  },
  {
    name: 'herdr_commander_claim',
    command: 'claim',
    roles: ['commander'],
    description: 'Take the commander lease of this workspace (one commander per workspace). Fails while another live pane holds it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'herdr_commander_release',
    command: 'release',
    roles: ['commander'],
    description: 'Give up the commander lease of this workspace.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

export function toolsFor(role) {
  return TOOLS.filter(tool => tool.roles.includes(role))
}
