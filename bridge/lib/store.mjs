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
  // Windows refuses a rename over a file another process (a reader, a virus
  // scanner) holds open for a moment: retry briefly before giving up.
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, path)
      return
    } catch (error) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
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
    this.workersDir = ensure(join(this.dir, 'workers'))
    this.outDir = ensure(join(this.dir, 'out'))
    this.panesDir = ensure(join(this.dir, 'panes'))
  }

  // Workers started under a herdr id (Agent takeover, herdr_worker_spawn) --

  workerPath(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`invalid worker id: ${id}`)
    }
    return join(this.workersDir, `${id}.json`)
  }

  getWorker(id) {
    return readJson(this.workerPath(id), null)
  }

  putWorker(worker) {
    writeJson(this.workerPath(worker.herdr_id), { ...worker, updated_at: new Date().toISOString() })
  }

  listWorkers() {
    return readdirSync(this.workersDir)
      .filter(name => name.endsWith('.json'))
      .map(name => readJson(join(this.workersDir, name), null))
      .filter(Boolean)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  }

  /** The Markdown log a herdr id's outputFile points at (what the model Reads). */
  outputPath(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`invalid output id: ${id}`)
    }
    return join(this.outDir, `${id}.md`)
  }

  /** The screen file of any pane: refreshed when the model Reads it. */
  panePath(paneId) {
    const safe = String(paneId).replace(/:/g, '-')
    if (!/^[A-Za-z0-9_-]+$/.test(safe)) {
      throw new Error(`invalid pane id: ${paneId}`)
    }
    return join(this.panesDir, `${safe}.txt`)
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
}
