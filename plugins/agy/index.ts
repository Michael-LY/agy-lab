// OpenCode V2 local plugin: exposes the local Antigravity CLI (`agy`) as one
// background tool named `agy`.
//
// Loaded as a plain object ({ id, setup }) so it works without a package.json
// or any dependency. See README.md for the tool contract and manual checks.

import { dirname, isAbsolute, join, resolve } from "node:path"

import {
  jobPaths,
  mapUsage,
  readResultFile,
  readTail,
  resolveAgyPath,
  runJob,
  writeResultFile,
  type AgyMode,
  type JobPaths,
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
}

const TOOL_DESCRIPTION = `Run the local Antigravity CLI (agy) as a background job.

action="start" (default) spawns agy, returns a jobID immediately, and delivers the result later as a synthetic message. action="status" shows the state and the last 20 log lines. action="result" returns the final response (first 4000 characters), usage, denied actions and the full JSON path.

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
  defaultModel?: string
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
  const model =
    state.modelIDs.length > 0
      ? { type: "string", enum: state.modelIDs, description: "agy model ID from `agy models`." }
      : { type: "string", description: "agy model ID (free-form while `agy models` is unavailable)." }

  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "status", "result"],
        description: 'Dispatch action. Default "start".',
      },
      prompt: {
        type: "string",
        description: "Required for action=start. Passed to agy unchanged; write it like a task brief.",
      },
      jobID: { type: "string", description: "Required for action=status and action=result." },
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

function startText(job: JobRecord): string {
  return [
    "agy job started",
    `jobID: ${job.id}`,
    "state: running",
    `mode: ${job.mode}`,
    `model: ${job.model ?? "agy default"}`,
    job.conversation ? `conversation: ${job.conversation}` : job.continue ? "continue: most recent" : "",
    "files:",
    formatFiles(job.paths),
    "The job runs in the background. Completion is delivered as a synthetic message; use action=status for progress or action=result for the final answer. Do not resubmit the same task.",
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
    ? agy.denied_actions.map((item) => String(item))
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
  if (conversationID) {
    lines.push(`To continue this exact conversation, pass conversation="${conversationID}".`)
  }

  return lines.join("\n")
}

function notificationText(job: JobRecord, response: string): string {
  const head = `[agy] job ${job.id} ${job.state}`
  const meta = `mode=${job.mode} model=${job.model ?? "agy default"} duration=${job.durationMs === undefined ? "unknown" : formatSeconds(job.durationMs)}`

  if (job.state === "done") {
    const denied = job.denied?.length ? `\nWarning: agy denied actions: ${job.denied.join(", ")}.` : ""
    const preview = response.length > 2000 ? `${response.slice(0, 2000)}\n…` : response
    return [
      head,
      meta,
      denied.trim(),
      "Response (first 2000 chars):",
      preview || "(empty)",
      `Use action="result" with jobID="${job.id}" for metadata and the 4000-character response. Full JSON: ${job.paths.json}`,
      "Do not automatically submit the same task again.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  const reason = job.error ?? `state=${job.state}`
  const detail =
    job.state === "degraded"
      ? "agy returned no usable response. Retry with mode=plan, or inspect denied_actions."
      : job.state === "orphaned"
        ? "The plugin reloaded while this job was running and did not adopt the child process; files may still be changing."
        : "The job failed. Check the error and the log/err files."
  return [
    head,
    meta,
    `reason: ${reason}`,
    detail,
    `Use action="result" with jobID="${job.id}" for details. Files: ${job.paths.log} | ${job.paths.err} | ${job.paths.json}`,
    "Do not automatically submit the same task again.",
  ].join("\n")
}

async function notifyJob(ctx: any, job: JobRecord, response: string): Promise<void> {
  if (!job.sessionID || job.notified) return

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
  active: Map<string, JobRecord>,
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
  const model = explicitModel ?? resolveDefaultModel(state, options)

  const running = Array.from(active.values()).filter((job) => job.state === "running")
  if (running.length >= options.maxConcurrent) {
    throw new Error(
      `agy: maxConcurrent=${options.maxConcurrent} reached; running jobs: ${running.map((job) => job.id).join(", ") || "none"}`
    )
  }

  if (mode !== "plan") {
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
  }

  await pruneJobs(ctx.storage, 50)

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

  await saveJob(ctx.storage, job)
  active.set(id, job)

  let handle: ReturnType<typeof runJob>
  try {
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
    await saveJob(ctx.storage, job)
    throw error
  }

  job.pid = handle.pid
  await saveJob(ctx.storage, job)

  void handle.done
    .then(async (result: RunResult) => {
      active.delete(id)
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
      try {
        writeResultFile(job.paths.json, job, result.agy)
      } catch (error) {
        console.warn(`[agy] failed to write result file for ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      await notifyJob(ctx, job, result.response)
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
      await notifyJob(ctx, job, "")
    })

  return startText(job)
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
    const active = new Map<string, JobRecord>()

    console.log(`[agy] setup directory=${directory} output=${outputDir}`)

    const cached = await readModelsCache(ctx.storage)
    if (cached) state.modelIDs = cached.ids

    let registered = false

    const refreshModels = async (): Promise<void> => {
      const result = await loadModels(ctx.storage, {
        ttlHours: options.modelCacheTtlHours,
        agyBin: resolveAgyPath() ?? undefined,
      })
      if (!result.ids.length) {
        if (result.error) console.warn(`[agy] model list unavailable, model accepts free-form IDs: ${result.error}`)
        return
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
    }

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "agy",
        description: TOOL_DESCRIPTION,
        input: buildSchema(state),
        execute: async (input: Record<string, unknown>, context: any) => {
          const action = asString(input?.action) ?? "start"

          if (action === "start") {
            const content = await startJob(ctx, state, options, directory, outputDir, active, input ?? {}, context)
            return { content }
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
        await notifyJob(ctx, job, typeof agy.response === "string" ? agy.response : "")
      }
    } catch (error) {
      console.warn(`[agy] orphan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}
