// Launchers: how a Claude worker's pane starts, when `claude` alone is not
// enough (a profile, a wrapper). One JSON file per launcher in launchersDir();
// the format is docs/launchers.md. The bridge knows no launcher by name: it
// checks the file, fills its placeholders with values that pass each
// parameter's pattern, and types the line into the pane. The files are a
// user-level entry point for running programs (like settings hooks): the
// model only ever fills parameter values.
import { exec } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { BridgeError, launchersDir } from './paths.mjs'

const LAUNCHER_NAME = /^[a-z0-9][a-z0-9-]{0,30}$/
const PARAM_NAME = /^[a-z][a-z0-9_]{0,30}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const PLACEHOLDER = /\{([a-z][a-z0-9_]{0,30})\}/g
/** Names the built-in worker types use: a launcher's agent types must not shadow them. */
const RESERVED = new Set(['claude', 'codex'])
/** A token typed bare into PowerShell; anything else is single-quoted. */
const BARE = /^[A-Za-z0-9._:\/\\=+-]+$/
/** Never in a typed token: PowerShell 5.1 mangles embedded double quotes; control characters end the line. */
const UNTYPABLE = /["\u0000-\u001f\u007f]/
const CHOICES_TIMEOUT_MS = 15000
const DESCRIPTION_MAX = 200

/** Placeholder names in a template string. */
function placeholders(text) {
  return [...text.matchAll(PLACEHOLDER)].map(match => match[1])
}

function bad(file, message) {
  throw new BridgeError('bad_launcher', `${file}: ${message}`)
}

/** An anchored pattern (`^...$`), so a value matches as a whole. */
function compilePattern(file, name, pattern) {
  if (typeof pattern !== 'string' || !pattern.startsWith('^') || !pattern.endsWith('$')) {
    bad(file, `params.${name}.pattern must be a regular expression anchored with ^ and $`)
  }
  try {
    return new RegExp(pattern)
  } catch (error) {
    bad(file, `params.${name}.pattern: ${error.message}`)
  }
}

function checkChoices(file, name, choices) {
  if (choices === undefined) {
    return null
  }
  if (Array.isArray(choices)) {
    const items = choices.map(one => (typeof one === 'string' ? { value: one, description: '' } : one))
    if (!items.every(one => one && typeof one.value === 'string' && (one.description === undefined || typeof one.description === 'string'))) {
      bad(file, `params.${name}.choices: a list of strings or of { value, description }`)
    }
    return { items: items.map(one => ({ value: one.value, description: one.description ?? '' })) }
  }
  const { command, value = 'value', description = 'description', exclude } = choices ?? {}
  if (!Array.isArray(command) || command.length === 0 || !command.every(one => typeof one === 'string' && one !== '' && !UNTYPABLE.test(one) && !/[%^&|<>]/.test(one))) {
    bad(file, `params.${name}.choices.command: a non-empty list of strings without " % ^ & | < > or control characters`)
  }
  const fields = Array.isArray(description) ? description : [description]
  if (typeof value !== 'string' || !fields.every(one => typeof one === 'string') || (exclude !== undefined && typeof exclude !== 'string')) {
    bad(file, `params.${name}.choices: value and exclude are field names, description a field name or a list of them`)
  }
  return { command, value, description: fields, exclude }
}

/** Checks one launcher file; throws BridgeError('bad_launcher') naming what is wrong. */
export function checkLauncher(data, file) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    bad(file, 'not a JSON object')
  }
  const stem = basename(file).replace(/\.json$/i, '')
  const name = data.name ?? stem
  if (typeof name !== 'string' || !LAUNCHER_NAME.test(name) || RESERVED.has(name)) {
    bad(file, `name must match ${LAUNCHER_NAME} and not be claude or codex`)
  }
  if (name !== stem) {
    bad(file, `name "${name}" must be the file name (${name}.json)`)
  }
  const kind = data.kind ?? 'claude'
  if (kind !== 'claude') {
    bad(file, 'kind: only "claude" launchers are supported')
  }
  if (typeof data.description !== 'string' || data.description.trim() === '') {
    bad(file, 'description is required')
  }
  const { command } = data
  if (!Array.isArray(command) || command.length === 0 || !command.every(one => typeof one === 'string' && one !== '' && !UNTYPABLE.test(one))) {
    bad(file, 'command: a non-empty list of strings without double quotes or control characters')
  }
  const env = data.env ?? {}
  if (typeof env !== 'object' || Array.isArray(env) || !Object.entries(env).every(([key, value]) => ENV_NAME.test(key) && !/^HERDR_/i.test(key) && typeof value === 'string')) {
    bad(file, 'env: an object of NAME: "value" (names not starting with HERDR_)')
  }
  const rawParams = data.params ?? {}
  if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    bad(file, 'params: an object of name: { pattern, ... }')
  }
  const params = {}
  for (const [key, spec] of Object.entries(rawParams)) {
    if (!PARAM_NAME.test(key) || !spec || typeof spec !== 'object') {
      bad(file, `params.${key}: names match ${PARAM_NAME}; each is an object`)
    }
    const pattern = compilePattern(file, key, spec.pattern)
    const required = spec.required ?? true
    if (typeof required !== 'boolean' || (spec.description !== undefined && typeof spec.description !== 'string')) {
      bad(file, `params.${key}: required is true or false, description a string`)
    }
    if (spec.default !== undefined && (typeof spec.default !== 'string' || !pattern.test(spec.default))) {
      bad(file, `params.${key}.default must match its pattern`)
    }
    params[key] = { pattern, source: spec.pattern, required, description: spec.description ?? '', default: spec.default, choices: checkChoices(file, key, spec.choices) }
  }
  const used = new Set([...command, ...Object.values(env)].flatMap(placeholders))
  for (const one of used) {
    if (!(one in params)) {
      bad(file, `{${one}} is not one of its params`)
    }
  }
  for (const key of Object.keys(params)) {
    if (!used.has(key)) {
      bad(file, `params.${key} is not used in command or env`)
    }
  }
  return { name, kind, description: data.description.trim(), command, env, params, file }
}

/** Every launcher file, checked: the good ones, and why each other one was left out. */
export function loadLaunchers() {
  const dir = launchersDir()
  const launchers = []
  const errors = []
  if (!existsSync(dir)) {
    return { dir, launchers, errors }
  }
  for (const entry of readdirSync(dir).filter(one => one.toLowerCase().endsWith('.json')).sort()) {
    const file = join(dir, entry)
    try {
      const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
      launchers.push(checkLauncher(JSON.parse(text), file))
    } catch (error) {
      errors.push({ file, error: String(error.message ?? error) })
    }
  }
  return { dir, launchers, errors }
}

export function getLauncher(name) {
  const { launchers, errors } = loadLaunchers()
  const hit = launchers.find(one => one.name === name)
  if (!hit) {
    const broken = errors.find(one => basename(one.file).replace(/\.json$/i, '') === name)
    const known = launchers.map(one => one.name).join(', ') || '(none)'
    throw new BridgeError('no_launcher', broken ? `launcher ${name} is broken: ${broken.error}` : `no launcher ${name}; known: ${known} (in ${launchersDir()})`)
  }
  return hit
}

/**
 * A launcher with these parameter values: the command's tokens and the env,
 * every placeholder filled. A value must pass its parameter's pattern; an
 * optional parameter left out (no default) drops each token that names it.
 */
export function resolveLaunch(launcher, values = {}) {
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw new BridgeError('bad_params', 'params: an object of name: "value"')
  }
  for (const key of Object.keys(values)) {
    if (!(key in launcher.params)) {
      throw new BridgeError('bad_params', `launcher ${launcher.name} has no parameter ${key}; it takes: ${Object.keys(launcher.params).join(', ') || 'none'}`)
    }
  }
  const filled = {}
  for (const [key, spec] of Object.entries(launcher.params)) {
    const given = values[key]
    const value = given === undefined || given === null || given === '' ? spec.default : given
    if (value === undefined) {
      if (spec.required) {
        throw new BridgeError('bad_params', `launcher ${launcher.name} needs ${key} (${spec.description || spec.source})`)
      }
      continue
    }
    if (typeof value !== 'string' || UNTYPABLE.test(value) || !spec.pattern.test(value)) {
      throw new BridgeError('bad_params', `${key} for launcher ${launcher.name} must match ${spec.source}`)
    }
    filled[key] = value
  }
  const fill = text => text.replace(PLACEHOLDER, (_, key) => filled[key])
  const complete = text => placeholders(text).every(key => key in filled)
  if (!complete(launcher.command[0])) {
    throw new BridgeError('bad_params', `launcher ${launcher.name}: its first command token needs every parameter it names`)
  }
  const argv = launcher.command.filter(complete).map(fill)
  const env = Object.fromEntries(Object.entries(launcher.env).filter(([, value]) => complete(value)).map(([key, value]) => [key, fill(value)]))
  return { argv, env, params: filled }
}

/** One token as PowerShell takes it typed: bare when plain, else single-quoted. */
export function psToken(token) {
  if (UNTYPABLE.test(token)) {
    throw new BridgeError('bad_launcher', `cannot type ${JSON.stringify(token)} into a pane`)
  }
  return BARE.test(token) ? token : `'${token.replace(/'/g, "''")}'`
}

/** The line typed into the pane: a quoted first token needs `&` to run as a command. */
export function launchLine(argv, extra = []) {
  const [first, ...rest] = argv.map(psToken)
  return [first.startsWith("'") ? `& ${first}` : first, ...rest, ...extra].join(' ')
}

function cmdToken(token) {
  return BARE.test(token) ? token : `"${token}"`
}

/** Runs a choices command (through the shell, so a .cmd shim works) and reads its JSON list. */
function runChoices(spec) {
  return new Promise(done => {
    exec(spec.command.map(cmdToken).join(' '), { timeout: CHOICES_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        done({ error: `choices command failed: ${String(error.message ?? error).split('\n')[0]}` })
        return
      }
      try {
        const list = JSON.parse(String(stdout).replace(/^﻿/, ''))
        if (!Array.isArray(list)) {
          throw new Error('not a JSON list')
        }
        done({ list })
      } catch (parseError) {
        done({ error: `choices command output: ${parseError.message}` })
      }
    })
  })
}

function shorten(text) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > DESCRIPTION_MAX ? `${one.slice(0, DESCRIPTION_MAX - 1)}…` : one
}

async function choicesOf(spec) {
  if (spec.choices === null) {
    return { choices: null }
  }
  let items
  if (spec.choices.items) {
    items = spec.choices.items
  } else {
    const ran = await runChoices(spec.choices)
    if (ran.error) {
      return { choices: null, choices_error: ran.error }
    }
    const { value, description, exclude } = spec.choices
    items = ran.list
      .map(one => (typeof one === 'string' ? { value: one, description: '' } : one && typeof one === 'object' ? one : null))
      .filter(one => one !== null && !(exclude && (Array.isArray(one[exclude]) ? one[exclude].length > 0 : Boolean(one[exclude]))))
      .map(one => ({ value: typeof one === 'string' ? one : one[value] ?? one.value, description: description.map(field => one[field]).filter(part => typeof part === 'string' && part.trim() !== '').join(' · ') }))
  }
  return { choices: items.filter(one => typeof one.value === 'string' && !UNTYPABLE.test(one.value) && spec.pattern.test(one.value)).map(one => ({ value: one.value, description: shorten(one.description) })) }
}

/**
 * Every launcher with its parameters (choices listed, their commands run) and
 * the parameter its agent types pick (`agent_param`: the one with choices,
 * when every other parameter is optional or has a default).
 */
export async function listLaunchers() {
  const { dir, launchers, errors } = loadLaunchers()
  const out = []
  for (const launcher of launchers) {
    const params = {}
    for (const [key, spec] of Object.entries(launcher.params)) {
      params[key] = { pattern: spec.source, required: spec.required, description: spec.description, default: spec.default ?? null, ...(await choicesOf(spec)) }
    }
    const withChoices = Object.keys(params).filter(key => params[key].choices)
    const agentParam = withChoices.length === 1 && Object.keys(params).every(key => key === withChoices[0] || !params[key].required || params[key].default !== null) ? withChoices[0] : null
    out.push({ name: launcher.name, kind: launcher.kind, description: launcher.description, file: launcher.file, params, agent_param: agentParam })
  }
  return { dir, launchers: out, errors }
}
