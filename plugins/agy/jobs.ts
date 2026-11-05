// Job records, persistence and retention for the `agy` plugin.
//
// Records live in ctx.storage under `jobs/<jobID>`; completed records are
// capped at 50 on every start. Logs and result JSON files under outputDir are
// never deleted by the plugin.

import { randomBytes } from "node:crypto"
import { formatDenied, readResultFile, type JobPaths, type JobState, type Usage } from "./runner.ts"

export const JOBS_PREFIX = "jobs/"
export const MAX_JOBS = 50

export type JobRecord = {
  id: string
  sessionID?: string
  directory: string
  mode: string
  model?: string
  effort?: string
  conversation?: string
  continue?: boolean
  pid?: number | null
  startedAt: number
  endedAt?: number
  durationMs?: number
  state: JobState
  exitCode?: number | null
  usage?: Usage
  denied?: string[]
  conversationID?: string
  numTurns?: number
  error?: string
  paths: JobPaths
  notified: boolean
}

export type StorageLike = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
    entries: { key: string; value: unknown }[]
    next?: string
  }>
}

export function isTerminalState(state: string): boolean {
  return state !== "running"
}

export function newJobID(): string {
  return `agy-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`
}

export function jobKey(id: string): string {
  return `${JOBS_PREFIX}${id}`
}

function isJobRecord(value: unknown): value is JobRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === "string" &&
    typeof record.startedAt === "number" &&
    typeof record.state === "string" &&
    !!(record.paths && typeof record.paths === "object")
  )
}

export async function saveJob(storage: StorageLike, job: JobRecord): Promise<void> {
  await storage.set(jobKey(job.id), job)
}

export async function loadJob(storage: StorageLike, id: string): Promise<JobRecord | null> {
  const value = await storage.get(jobKey(id))
  return isJobRecord(value) ? value : null
}

export async function listJobs(storage: StorageLike): Promise<JobRecord[]> {
  const jobs: JobRecord[] = []
  let after: string | undefined
  for (let page = 0; page < 100; page += 1) {
    const result = await storage.scan({ prefix: JOBS_PREFIX, after, limit: 100 })
    for (const entry of result.entries) {
      if (isJobRecord(entry.value)) jobs.push(entry.value)
    }
    if (!result.next) break
    after = result.next
  }
  return jobs
}

/**
 * Keeps running jobs forever and the newest `max` finished jobs. Only the
 * storage records are removed; files stay on disk for the user to inspect.
 */
export async function pruneJobs(storage: StorageLike, max = MAX_JOBS): Promise<string[]> {
  const jobs = await listJobs(storage)
  const finished = jobs
    .filter((job) => isTerminalState(job.state))
    .sort((a, b) => b.startedAt - a.startedAt)

  const removed: string[] = []
  for (const job of finished.slice(Math.max(0, max))) {
    try {
      await storage.remove(jobKey(job.id))
      removed.push(job.id)
    } catch {
      // Pruning is best effort; never fail a start because of it.
    }
  }
  return removed
}

function mergeFromResultFile(job: JobRecord, fileJob: unknown): boolean {
  if (!fileJob || typeof fileJob !== "object") return false
  const source = fileJob as Partial<JobRecord>
  if (typeof source.state !== "string" || !isTerminalState(source.state)) return false

  job.state = source.state
  if (typeof source.exitCode === "number" || source.exitCode === null) job.exitCode = source.exitCode
  if (typeof source.endedAt === "number") job.endedAt = source.endedAt
  if (typeof source.durationMs === "number") job.durationMs = source.durationMs
  if (source.usage && typeof source.usage === "object") job.usage = source.usage
  if (Array.isArray(source.denied)) job.denied = source.denied.map(formatDenied)
  if (typeof source.error === "string") job.error = source.error
  if (typeof source.conversationID === "string") job.conversationID = source.conversationID
  if (typeof source.numTurns === "number") job.numTurns = source.numTurns
  return true
}

/**
 * After a reload every `running` record is suspect. If its result file already
 * holds a terminal state, adopt it; otherwise mark the job orphaned. The child
 * process is not adopted (documented v1 behaviour).
 */
export async function reconcileOrphans(
  storage: StorageLike,
  outputDir: string
): Promise<{ changed: JobRecord[]; recovered: JobRecord[]; orphaned: JobRecord[] }> {
  const jobs = await listJobs(storage)
  const changed: JobRecord[] = []
  const recovered: JobRecord[] = []
  const orphaned: JobRecord[] = []

  for (const job of jobs) {
    if (job.state !== "running") continue

    const file = readResultFile(outputDir, job.id)
    const fileJob = file?.job

    if (fileJob && mergeFromResultFile(job, fileJob)) {
      await saveJob(storage, job)
      changed.push(job)
      recovered.push(job)
      continue
    }

    job.state = "orphaned"
    job.endedAt = job.endedAt ?? Date.now()
    job.error = "plugin reloaded or the service restarted while this job was running; the child process was not adopted"
    await saveJob(storage, job)
    changed.push(job)
    orphaned.push(job)
  }

  return { changed, recovered, orphaned }
}
