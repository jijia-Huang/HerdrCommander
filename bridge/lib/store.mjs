// File-backed state for one herdr workspace. Each write is tmp + rename so a
// reader never sees half a file; the bridge is one short process per call.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { workspaceDir } from './paths.mjs'

function ensure(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, path)
}

export function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${prefix}-${stamp}-${randomBytes(2).toString('hex')}`
}

export class Store {
  constructor(workspaceId) {
    this.workspaceId = workspaceId
    this.dir = ensure(workspaceDir(workspaceId))
    this.jobsDir = ensure(join(this.dir, 'jobs'))
    this.resultsDir = ensure(join(this.dir, 'results'))
    this.tasksDir = ensure(join(this.dir, 'tasks'))
    this.bgDir = ensure(join(this.dir, 'bg'))
  }

  // Jobs ---------------------------------------------------------------

  jobPath(jobId) {
    if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
      throw new Error(`invalid job id: ${jobId}`)
    }
    return join(this.jobsDir, `${jobId}.json`)
  }

  resultPath(jobId) {
    return join(this.resultsDir, `${jobId}.md`)
  }

  taskPath(jobId) {
    return join(this.tasksDir, `${jobId}.md`)
  }

  getJob(jobId) {
    return readJson(this.jobPath(jobId), null)
  }

  putJob(job) {
    writeJson(this.jobPath(job.job_id), { ...job, updated_at: new Date().toISOString() })
  }

  listJobs() {
    return readdirSync(this.jobsDir)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(join(this.jobsDir, name), null))
      .filter(Boolean)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }

  // Commander lease ----------------------------------------------------

  getLease() {
    return readJson(join(this.dir, 'lease.json'), null)
  }

  setLease(lease) {
    writeJson(join(this.dir, 'lease.json'), lease)
  }

  clearLease() {
    writeJson(join(this.dir, 'lease.json'), null)
  }

  // Panes the bridge created (the only ones it may close) ---------------

  getOwned() {
    return readJson(join(this.dir, 'owned.json'), [])
  }

  addOwned(entry) {
    const owned = this.getOwned().filter(one => one.pane_id !== entry.pane_id)
    writeJson(join(this.dir, 'owned.json'), [...owned, entry])
  }

  removeOwned(paneId) {
    writeJson(
      join(this.dir, 'owned.json'),
      this.getOwned().filter(one => one.pane_id !== paneId),
    )
  }

  isOwned(paneId) {
    return this.getOwned().some(one => one.pane_id === paneId)
  }

  // Background commands --------------------------------------------------

  bgPath(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`invalid background id: ${id}`)
    }
    return join(this.bgDir, `${id}.json`)
  }

  getBg(id) {
    return readJson(this.bgPath(id), null)
  }

  putBg(bg) {
    writeJson(this.bgPath(bg.id), bg)
  }

  listBg() {
    if (!existsSync(this.bgDir)) {
      return []
    }
    return readdirSync(this.bgDir)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(join(this.bgDir, name), null))
      .filter(Boolean)
  }
}
