// OpenCode V2 local plugin: exposes the local Antigravity CLI (`agy`) as one
// background tool named `agy`.
//
// Loaded as a plain object ({ id, setup }) so it works without a package.json
// or any dependency. See README.md for the tool contract and manual checks.

import { dirname, isAbsolute, join, resolve } from "node:path"

import {
  formatDenied,
  jobPaths,
  mapUsage,
  readResultFile,
  readTail,
  resolveAgyPath,
  runJob,
  writeResultFile,
  type AgyMode,
  type JobPaths,
  type RunHandle,
  type RunResult,
  type Usage,
} from "./runner.ts"
import { isModelsCacheStale, loadModels, readModelsCache } from "./models.ts"
import {
  loadJob,
  newJobID,
  pruneJobs,
  reconcileOrphans,
  saveJob,
  type JobRecord,
} from "./jobs.ts"

const MODES: AgyMode[] = ["plan", "accept-edits", "auto"]
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]

const DEFAULT_OPTIONS = {
  defaultMode: "plan" as AgyMode,
  maxConcurrent: 2,
  timeoutMinutes: 10,
  outputDir: ".agy-out",
  modelCacheTtlHours: 24,
  notifyOnComplete: true,
}

/** Floor between two forced `agy models` refreshes, so a typo cannot spam it. */
const MODEL_REFRESH_FLOOR_MS = 60_000

const TOOL_DESCRIPTION = `Run the local Antigravity CLI (agy) as a background job.

action="start" (default) spawns agy, returns a jobID immediately, and (unless options.notifyOnComplete is false) delivers the result later as a synthetic message. action="status" shows the state and the last 20 log lines. action="result" returns the final response (first 4000 characters), usage, denied actions and the full JSON path. action="cancel" kills the process tree of a running job and marks it cancelled.

agy defaults to plan mode (read-only). Pass mode="accept-edits" or mode="auto" to allow edits; that asks for permission first. Write prompt like a task for a colleague: state the goal, the files involved, and what done looks like. Do not automatically submit the same task again after a completion notification.`

type PluginState = {
  modelIDs: string[]
  warnedDefaultModel: boolean
}

type Options = {
  defaultMode: AgyMode
  maxConcurrent: number
  timeoutMinutes: number
  outputDir: string
  modelCacheTtlHours: number
  notifyOnComplete: boolean
  defaultModel?: string
}

/** A running job and its handle, kept together so `action=cancel` can reach it. */
type ActiveJob = {
  job: JobRecord
  handle?: RunHandle
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeOptions(raw: unknown): Options {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}

  let defaultMode: AgyMode = DEFAULT_OPTIONS.defaultMode
  if (source.defaultMode !== undefined) {
    if (MODES.includes(source.defaultMode as AgyMode)) defaultMode = source.defaultMode as AgyMode
    else console.warn(`[agy] options.defaultMode "${String(source.defaultMode)}" is not one of ${MODES.join(", ")}; using plan`)
  }

  const outputDir = asString(source.outputDir) ?? DEFAULT_OPTIONS.outputDir

  return {
    defaultMode,
    maxConcurrent: Math.max(1, Math.floor(asPositiveNumber(source.maxConcurrent, DEFAULT_OPTIONS.maxConcurrent))),
    timeoutMinutes: asPositiveNumber(source.timeoutMinutes, DEFAULT_OPTIONS.timeoutMinutes),
    outputDir,
    modelCacheTtlHours: asPositiveNumber(source.modelCacheTtlHours, DEFAULT_OPTIONS.modelCacheTtlHours),
    notifyOnComplete:
      typeof source.notifyOnComplete === "boolean"
        ? source.notifyOnComplete
        : DEFAULT_OPTIONS.notifyOnComplete,
    defaultModel: asString(source.defaultModel),
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

function formatUsage(usage: Usage | undefined): string {
  if (!usage) return "unavailable"
  return `input=${usage.input} output=${usage.output} thinking=${usage.thinking} cache_read=${usage.cacheRead} total=${usage.total}`
}

function formatFiles(paths: JobPaths): string {
  return `  log: ${paths.log}\n  err: ${paths.err}\n  json: ${paths.json}`
}

function readJobResult(job: JobRecord) {
  return readResultFile(dirname(job.paths.json), job.id)
}

function resolveDefaultModel(state: PluginState, options: Options): string | undefined {
  if (!options.defaultModel) return undefined
  if (state.modelIDs.length > 0 && !state.modelIDs.includes(options.defaultModel)) {
    if (!state.warnedDefaultModel) {
      console.warn(
        `[agy] options.defaultModel "${options.defaultModel}" is not in \`agy models\`; falling back to agy's default`
      )
      state.warnedDefaultModel = true
    }
    return undefined
  }
  return options.defaultModel
}

function buildSchema(state: PluginState): Record<string, unknown> {
  // Free-form on purpose: an `enum` would reject a model that agy added after
  // the cache was written, before `start` runs and can refresh the list.
  const known = state.modelIDs.length > 0 ? ` Known IDs: ${state.modelIDs.join(", ")}.` : ""
  const model = {
    type: "string",
    description: `agy model ID from \`agy models\`.${known} An unknown ID triggers one refresh, then fails.`,
  }

  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "status", "result", "cancel"],
        description: 'Dispatch action. Default "start".',
      },
      prompt: {
        type: "string",
        description: "Required for action=start. Passed to agy unchanged; write it like a task brief.",
      },
      jobID: { type: "string", description: "Required for action=status, action=result and action=cancel." },
      model,
      mode: {
        type: "string",
        enum: MODES,
        description: "plan is read-only; accept-edits/auto ask for permission first.",
      },
      effort: { type: "string", enum: EFFORTS },
      conversation: {
        type: "string",
        description: "Exact conversation ID to resume; mutually exclusive with continue.",
      },
      continue: {
        type: "boolean",
        description: "Resume agy's most recent conversation (-c); mutually exclusive with conversation.",
      },
    },
    additionalProperties: false,
  }
}

function startText(job: JobRecord, options: Options): string {
  const completion = options.notifyOnComplete
    ? "Completion is delivered as a synthetic message; use action=status for progress or action=result for the final answer."
    : "options.notifyOnComplete is false: nothing will wake this session. Poll with action=status, then read action=result."
  return [
    "agy job started",
    `jobID: ${job.id}`,
    "state: running",
    `mode: ${job.mode}`,
    `model: ${job.model ?? "agy default"}`,
    job.conversation ? `conversation: ${job.conversation}` : job.continue ? "continue: most recent" : "",
    "files:",
    formatFiles(job.paths),
    `The job runs in the background. ${completion}`,
    `Use action=cancel with jobID="${job.id}" to stop it. Do not resubmit the same task.`,
  ]
    .filter(Boolean)
    .join("\n")
}

function statusText(job: JobRecord): string {
  const elapsed = (job.endedAt ?? Date.now()) - job.startedAt
  const tail = readTail(job.paths.log, 20)
  return [
    `agy job ${job.id}`,
    `state: ${job.state}`,
    `elapsed: ${formatSeconds(elapsed)}`,
    `mode: ${job.mode}`,
    `model: ${job.model ?? "agy default"}`,
    job.conversation ? `conversation: ${job.conversation}` : job.continue ? "continue: most recent" : "",
    "files:",
    formatFiles(job.paths),
    "log tail (last 20 lines):",
    tail || "(empty)",
    job.state === "running" ? `Use action=cancel with jobID="${job.id}" to stop this job.` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function resultText(job: JobRecord): string {
  if (job.state === "running") {
    return `${statusText(job)}\n\nThe job is still running; poll with action=status or wait for the completion message.`
  }

  const file = readJobResult(job)
  const agy = (file?.agy && typeof file.agy === "object" ? file.agy : {}) as Record<string, unknown>
  const response = typeof agy.response === "string" ? agy.response : ""
  const usage = mapUsage(agy.usage) ?? job.usage
  const conversationID =
    typeof agy.conversation_id === "string" ? agy.conversation_id : job.conversationID
  const numTurns = typeof agy.num_turns === "number" ? agy.num_turns : job.numTurns
  const seconds =
    typeof job.durationMs === "number"
      ? job.durationMs / 1000
      : typeof agy.duration_seconds === "number"
        ? agy.duration_seconds
        : undefined
  const denied = Array.isArray(agy.denied_actions)
    ? agy.denied_actions.map(formatDenied)
    : (job.denied ?? [])
  const truncated = response.length > 4000 ? `${response.slice(0, 4000)}\n… (truncated; full response in ${job.paths.json})` : response

  const lines = [
    `agy job ${job.id}`,
    `state: ${job.state}`,
    `duration: ${seconds === undefined ? "unknown" : `${seconds.toFixed(1)}s`}`,
    `conversation_id: ${conversationID ?? "unknown"}`,
    `num_turns: ${numTurns ?? "unknown"}`,
    `usage: ${formatUsage(usage)}`,
    `denied_actions: ${denied.length ? denied.join(", ") : "none"}`,
    job.error ? `error: ${job.error}` : "",
    "response (first 4000 chars):",
    truncated || "(empty)",
    `full JSON: ${job.paths.json}`,
  ].filter(Boolean)

  if (job.state === "degraded") {
    lines.push(
      "The job did not complete usefully: agy returned an empty response. Retry with mode=plan (or inspect denied_actions above), and use conversation to continue the same agy conversation."
    )
  }
  if (job.state === "failed" || job.state === "timed_out") {
    lines.push(`See ${job.paths.err} and ${job.paths.log} for the child process output.`)
  }
  if (job.state === "cancelled") {
    lines.push("The job was cancelled and its process tree was killed; no output was produced.")
  }
  if (conversationID) {
    lines.push(`To continue this exact conversation, pass conversation="${conversationID}".`)
  }

  return lines.join("\n")
}

function notificationText(job: JobRecord, response: string): string {
  const head = `[agy] job ${job.id} ${job.state}`
  const meta = `mode=${job.mode} model=${job.model ?? "agy default"} duration=${job.durationMs === undefined ? "unknown" : formatSeconds(job.durationMs)}`
  // Enough metadata that one wake-up answers "retry or continue?" without a
  // follow-up action=result call.
  const details = [
    job.numTurns === undefined ? "" : `num_turns: ${job.numTurns}`,
    job.usage ? `usage: ${formatUsage(job.usage)}` : "",
    job.conversationID ? `conversation_id: ${job.conversationID}` : "",
  ].filter(Boolean)

  if (job.state === "done") {
    const denied = job.denied?.length ? `\nWarning: agy denied actions: ${job.denied.join(", ")}.` : ""
    const preview = response.length > 2000 ? `${response.slice(0, 2000)}\n…` : response
    return [
      head,
      meta,
      ...details,
      denied.trim(),
      "Response (first 2000 chars):",
      preview || "(empty)",
      `Use action="result" with jobID="${job.id}" for the 4000-character response. Full JSON: ${job.paths.json}`,
      job.conversationID ? `To continue this exact conversation, pass conversation="${job.conversationID}".` : "",
      "Do not automatically submit the same task again.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  const reason = job.error ?? `state=${job.state}`
  const detail =
    job.state === "degraded"
      ? "agy returned no usable response. Retry with mode=plan, or inspect denied_actions."
      : job.state === "cancelled"
        ? "The job was cancelled and its process tree was killed."
        : job.state === "orphaned"
          ? "The plugin reloaded while this job was running and did not adopt the child process; files may still be changing."
          : "The job failed. Check the error and the log/err files."
  return [
    head,
    meta,
    ...details,
    `reason: ${reason}`,
    detail,
    `Use action="result" with jobID="${job.id}" for details. Files: ${job.paths.log} | ${job.paths.err} | ${job.paths.json}`,
    "Do not automatically submit the same task again.",
  ].join("\n")
}

async function notifyJob(ctx: any, job: JobRecord, response: string, options: Options): Promise<void> {
  if (!job.sessionID || job.notified) return

  // Silent mode still marks the job notified, so a later reload does not wake
  // the session for a completion the user chose not to hear about.
  if (!options.notifyOnComplete) {
    job.notified = true
    try {
      await saveJob(ctx.storage, job)
    } catch (error) {
      console.warn(`[agy] failed to persist silent notification for ${job.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return
  }

  try {
    await ctx.session.synthetic({
      sessionID: job.sessionID,
      text: notificationText(job, response),
      description: `agy ${job.state} ${job.id}`,
      delivery: "queue",
    })
    job.notified = true
    await saveJob(ctx.storage, job)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[agy] could not deliver synthetic message for ${job.id}: ${message}`)
  }
}

async function startJob(
  ctx: any,
  state: PluginState,
  options: Options,
  directory: string,
  outputDir: string,
  active: Map<string, ActiveJob>,
  refreshModels: (force?: boolean) => Promise<string[]>,
  input: Record<string, unknown>,
  context: any
): Promise<string> {
  const prompt = typeof input.prompt === "string" ? input.prompt : ""
  if (!prompt.trim()) throw new Error("agy: prompt is required for action=start")

  const conversation = asString(input.conversation)
  const useContinue = input.continue === true
  if (conversation && useContinue) {
    throw new Error("agy: conversation and continue are mutually exclusive")
  }

  const mode = (asString(input.mode) ?? options.defaultMode) as AgyMode
  if (!MODES.includes(mode)) {
    throw new Error(`agy: mode must be one of ${MODES.join(", ")}`)
  }

  const effort = asString(input.effort)
  if (effort && !EFFORTS.includes(effort)) {
    throw new Error(`agy: effort must be one of ${EFFORTS.join(", ")}`)
  }

  const explicitModel = asString(input.model)
  let model = explicitModel ?? resolveDefaultModel(state, options)

  const running = Array.from(active.values())
    .map((entry) => entry.job)
    .filter((job) => job.state === "running")
  if (running.length >= options.maxConcurrent) {
    throw new Error(
      `agy: maxConcurrent=${options.maxConcurrent} reached; running jobs: ${running.map((job) => job.id).join(", ") || "none"}`
    )
  }

  // Reserve the slot before the next await. A permission prompt can wait on a
  // human, and two parallel starts would otherwise both pass the check above.
  const id = newJobID()
  const job: JobRecord = {
    id,
    sessionID: typeof context?.sessionID === "string" ? context.sessionID : undefined,
    directory,
    mode,
    model,
    effort,
    conversation,
    continue: useContinue || undefined,
    startedAt: Date.now(),
    state: "running",
    paths: jobPaths(outputDir, id),
    notified: false,
  }
  const entry: ActiveJob = { job }
  active.set(id, entry)

  // A denied permission must not leave a job behind: release the reservation
  // and persist nothing.
  if (mode !== "plan") {
    try {
      await ctx.permission.assert({
        sessionID: context?.sessionID,
        agent: context?.agent,
        source: {
          type: "tool",
          messageID: context?.messageID,
          id: context?.id,
        },
        action: "agy",
        resources: [directory],
        save: [directory],
      })
    } catch (error) {
      active.delete(id)
      throw error
    }
  }

  // The model list is free-form in the schema, so validate here. A miss may
  // just mean agy added a model after the cache was written: refresh once.
  // Ordered after the concurrency gate so a doomed start does not spend it.
  if (explicitModel && state.modelIDs.length > 0 && !state.modelIDs.includes(explicitModel)) {
    const known = await refreshModels(true)
    if (known.length > 0 && !known.includes(explicitModel)) {
      active.delete(id)
      throw new Error(`agy: unknown model "${explicitModel}"; known IDs: ${known.join(", ")}`)
    }
    model = explicitModel
    job.model = model
  }

  let handle: ReturnType<typeof runJob>
  try {
    await pruneJobs(ctx.storage, 50)
    await saveJob(ctx.storage, job)
    handle = runJob({
      jobID: id,
      prompt,
      directory,
      outputDir,
      timeoutMinutes: options.timeoutMinutes,
      model,
      mode,
      effort,
      conversation,
      continue: useContinue,
    })
  } catch (error) {
    active.delete(id)
    job.state = "failed"
    job.endedAt = Date.now()
    job.error = error instanceof Error ? error.message : String(error)
    try {
      await saveJob(ctx.storage, job)
    } catch {
      // The start already failed; a missing record is not worth a second error.
    }
    throw error
  }

  entry.handle = handle
  job.pid = handle.pid
  try {
    await saveJob(ctx.storage, job)
  } catch (error) {
    // agy is already running: keep going, and let the completion path save
    // the terminal state. Reporting a failed start here would invite a resubmit.
    console.warn(`[agy] failed to persist pid for ${id}: ${error instanceof Error ? error.message : String(error)}`)
  }

  void handle.done
    .then(async (result: RunResult) => {
      job.state = result.state
      job.exitCode = result.exitCode
      job.endedAt = result.endedAt
      job.durationMs = result.durationMs
      job.usage = result.usage
      job.denied = result.deniedActions
      job.conversationID = result.conversationID
      job.numTurns = result.numTurns
      job.error = result.error
      job.pid = result.pid ?? job.pid

      try {
        await saveJob(ctx.storage, job)
      } catch (error) {
        console.warn(`[agy] failed to persist job ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Released only after the terminal state is on disk: a cancel in this
      // window would otherwise see a running record with no handle and call
      // a freshly finished job orphaned.
      active.delete(id)
      try {
        writeResultFile(job.paths.json, job, result.agy)
      } catch (error) {
        console.warn(`[agy] failed to write result file for ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      await notifyJob(ctx, job, result.response, options)
    })
    .catch(async (error) => {
      active.delete(id)
      job.state = "failed"
      job.endedAt = Date.now()
      job.durationMs = job.endedAt - job.startedAt
      job.error = `runner crashed: ${error instanceof Error ? error.message : String(error)}`
      try {
        await saveJob(ctx.storage, job)
        writeResultFile(job.paths.json, job, null)
      } catch {
        // Keep the failure in memory; storage is best effort here.
      }
      await notifyJob(ctx, job, "", options)
    })

  return startText(job, options)
}

export default {
  id: "agy",

  async setup(ctx: any): Promise<void> {
    const directory = resolve(String(ctx?.location?.directory ?? process.cwd()))
    const options = normalizeOptions(ctx?.options)
    const outputDir = isAbsolute(options.outputDir)
      ? options.outputDir
      : join(directory, options.outputDir)
    const state: PluginState = { modelIDs: [], warnedDefaultModel: false }
    const active = new Map<string, ActiveJob>()

    console.log(`[agy] setup directory=${directory} output=${outputDir}`)

    const cached = await readModelsCache(ctx.storage)
    if (cached) state.modelIDs = cached.ids

    let registered = false
    let lastForcedRefresh = 0
    let inflightRefresh: Promise<string[]> | null = null

    /**
     * Returns the ids it ended up with. `force` bypasses the TTL (a model that
     * was added after the cache was written) but is rate limited so a typo in
     * `model` cannot spawn `agy models` on every call. Concurrent callers share
     * one fetch instead of the second one failing against a stale list.
     */
    const refreshModels = async (force = false, known = cached): Promise<string[]> => {
      if (inflightRefresh) return inflightRefresh
      if (force && Date.now() - lastForcedRefresh < MODEL_REFRESH_FLOOR_MS) return state.modelIDs
      if (force) lastForcedRefresh = Date.now()

      const pending = (async () => {
        const result = await loadModels(ctx.storage, {
          ttlHours: options.modelCacheTtlHours,
          // A forced call must fall back to the *latest* persisted cache, not
          // to this setup-time snapshot: otherwise a failed fetch rewinds the
          // list and hides a model that a later refresh already found.
          cache: force ? undefined : known,
          force,
          agyBin: resolveAgyPath() ?? undefined,
        })
        if (!result.ids.length) {
          if (result.error) console.warn(`[agy] model list unavailable, model accepts free-form IDs: ${result.error}`)
          return state.modelIDs
        }

        const changed = result.ids.join("\n") !== state.modelIDs.join("\n")
        state.modelIDs = result.ids

        if (changed && registered) {
          try {
            await ctx.tool.reload()
          } catch (error) {
            console.warn(`[agy] tool reload after model refresh failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return state.modelIDs
      })()

      inflightRefresh = pending
      try {
        return await pending
      } finally {
        if (inflightRefresh === pending) inflightRefresh = null
      }
    }

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "agy",
        description: TOOL_DESCRIPTION,
        input: buildSchema(state),
        execute: async (input: Record<string, unknown>, context: any) => {
          const action = asString(input?.action) ?? "start"

          if (action === "start") {
            const content = await startJob(
              ctx,
              state,
              options,
              directory,
              outputDir,
              active,
              refreshModels,
              input ?? {},
              context
            )
            return { content }
          }

          if (action === "cancel") {
            const jobID = asString(input?.jobID)
            if (!jobID) throw new Error("agy: jobID is required for action=cancel")

            const entry = active.get(jobID)
            if (!entry?.handle) {
              const stored = await loadJob(ctx.storage, jobID)
              if (!stored) throw new Error(`agy: no job ${jobID} in storage (it may have been pruned)`)
              if (stored.state !== "running") {
                return { content: `agy job ${jobID}\nstate: ${stored.state}\nNothing to cancel.` }
              }
              throw new Error(
                `agy: job ${jobID} is not running in this process (orphaned after a reload); it cannot be cancelled from here`
              )
            }

            const stopped = entry.handle.kill()
            if (!stopped) {
              return {
                content: `agy job ${jobID}\nstate: ${entry.job.state}\ncancel: not applied\n\nThe job is already finishing (or its tree is gone); nothing was killed. Use action=result for the final state.`,
              }
            }
            return {
              content: `agy job ${jobID}\ncancel: requested\nstate: cancelled\n\nThe process tree was killed. Use action=result to confirm the final state.`,
            }
          }

          if (action === "status" || action === "result") {
            const jobID = asString(input?.jobID)
            if (!jobID) throw new Error(`agy: jobID is required for action=${action}`)
            const job = await loadJob(ctx.storage, jobID)
            if (!job) throw new Error(`agy: no job ${jobID} in storage (it may have been pruned)`)
            return { content: action === "status" ? statusText(job) : resultText(job) }
          }

          throw new Error(`agy: unknown action ${action}`)
        },
      })
    })
    registered = true

    if (!cached || isModelsCacheStale(cached, options.modelCacheTtlHours)) {
      void refreshModels().catch((error) => {
        console.warn(`[agy] model refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    try {
      const { changed } = await reconcileOrphans(ctx.storage, outputDir)
      for (const job of changed) {
        if (!job.sessionID || job.notified) continue
        const file = readJobResult(job)
        const agy = (file?.agy && typeof file.agy === "object" ? file.agy : {}) as Record<string, unknown>
        // A record recovered from .agy-out only knows what the preliminary file
        // held; take the rest from agy's own JSON so the notification is as
        // complete as a live one.
        if (!job.conversationID && typeof agy.conversation_id === "string") {
          job.conversationID = agy.conversation_id
        }
        if (job.numTurns === undefined && typeof agy.num_turns === "number") {
          job.numTurns = agy.num_turns
        }
        if (!job.denied?.length && Array.isArray(agy.denied_actions)) {
          job.denied = agy.denied_actions.map(formatDenied)
        }
        if (!job.usage) job.usage = mapUsage(agy.usage)
        await notifyJob(ctx, job, typeof agy.response === "string" ? agy.response : "", options)
      }
    } catch (error) {
      console.warn(`[agy] orphan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}
