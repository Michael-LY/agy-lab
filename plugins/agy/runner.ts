// agy runner: builds the Antigravity CLI argv, spawns it, streams output to
// disk, and classifies the result. Pure Node, no OpenCode imports, and only
// erasable TypeScript so `node scripts/smoke.mjs` can import this file directly
// under Node's type stripping.

import { spawn, spawnSync } from "node:child_process"
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { delimiter, join } from "node:path"

export type JobState =
  | "running"
  | "done"
  | "degraded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "orphaned"

export type JobPaths = {
  log: string
  err: string
  json: string
}

export type Usage = {
  input: number
  output: number
  thinking: number
  cacheRead: number
  total: number
}

export type RunInput = {
  jobID: string
  prompt: string
  directory: string
  outputDir: string
  timeoutMinutes: number
  model?: string
  mode?: string
  effort?: string
  conversation?: string
  continue?: boolean
  /** Explicit agy path; defaults to a PATH lookup. */
  agyPath?: string
  /**
   * Test hook: run `<command> <args...> <agy argv>` instead of agy itself.
   * Smoke uses it to run `node scripts/fixtures/fake-agy.mjs`, since the fake
   * is not a native executable on Windows.
   */
  launcher?: { command: string; args: string[] }
  /** Test hook: hard-kill deadline in milliseconds instead of timeoutMinutes. */
  timeoutMs?: number
  /** Extra environment variables for the child. */
  env?: Record<string, string>
}

export type RunResult = {
  state: JobState
  exitCode: number | null
  startedAt: number
  endedAt: number
  durationMs: number
  response: string
  conversationID?: string
  numTurns?: number
  durationSeconds?: number
  usage?: Usage
  deniedActions: string[]
  error?: string
  /** Parsed agy JSON, when the output parsed. */
  agy: unknown
  pid: number | null
  paths: JobPaths
}

export type RunHandle = {
  pid: number | null
  done: Promise<RunResult>
  /** False when the job is already exiting; nothing was killed. */
  kill: () => boolean
}

const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 1 * 1024 * 1024
/** How much of the log tail `readTail` loads; a status call must stay O(1). */
const TAIL_BYTES = 64 * 1024

/** Lines the runner appends itself, so `status` is not empty while agy is quiet. */
export function heartbeat(line: string): string {
  return `[agy-runner] ${line}`
}

/**
 * agy reports denied actions as objects (`{action, display_name}`), not
 * strings. Flattening one with `String()` yields "[object Object]", which is
 * exactly what the retry hint must never say.
 */
export function formatDenied(item: unknown): string {
  if (typeof item === "string") return item
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>
    if (typeof record.display_name === "string") return record.display_name
    if (typeof record.action === "string") return record.action
    try {
      return JSON.stringify(item)
    } catch {
      return String(item)
    }
  }
  return String(item)
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
}

export function jobPaths(outputDir: string, jobID: string): JobPaths {
  return {
    log: join(outputDir, `${jobID}.log`),
    err: join(outputDir, `${jobID}.err`),
    json: join(outputDir, `${jobID}.json`),
  }
}

/**
 * The single place that knows agy's argument order. `conversation` and
 * `continue` are mutually exclusive: passing both is a caller bug, not
 * something to paper over.
 */
export function buildArgs(input: {
  prompt: string
  timeoutMinutes: number
  model?: string
  mode?: string
  effort?: string
  conversation?: string
  continue?: boolean
}): string[] {
  if (input.conversation && input.continue) {
    throw new Error("agy: conversation and continue are mutually exclusive")
  }

  const printTimeout = Math.max(1, input.timeoutMinutes - 1)
  const args = [
    "-p",
    input.prompt,
    "--output-format",
    "json",
    "--print-timeout",
    `${printTimeout}m`,
  ]

  if (input.model) args.push("--model", input.model)
  if (input.mode) args.push("--mode", input.mode)
  if (input.effort) args.push("--effort", input.effort)
  if (input.conversation) args.push("--conversation", input.conversation)
  else if (input.continue) args.push("-c")

  return args
}

/**
 * Resolve `agy` from PATH without a shell. Windows still probes PATHEXT, which
 * is why spawning a bare "agy" is not enough on its own.
 */
export function resolveAgyPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
  const exts =
    process.platform === "win32"
      ? String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""]

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `agy${ext}`)
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not here; keep walking PATH.
      }
    }
  }
  return null
}

export function killTree(pid: number): void {
  if (!pid) return
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      })
    } else {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        process.kill(pid, "SIGKILL")
      }
    }
  } catch {
    // Already gone.
  }
}

export function mapUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  const keys = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"]
  if (!keys.some((key) => typeof value[key] === "number")) return undefined

  const num = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : 0)
  return {
    input: num("input_tokens"),
    output: num("output_tokens"),
    thinking: num("thinking_tokens"),
    cacheRead: num("cache_read_tokens"),
    total: num("total_tokens"),
  }
}

export function writeResultFile(path: string, job: unknown, agy: unknown): void {
  writeFileSync(path, JSON.stringify({ job, agy }, null, 2), "utf8")
}

function endStream(stream: NodeJS.WritableStream & { closed?: boolean }): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) return resolve()
    stream.once("close", () => resolve())
    stream.once("error", () => resolve())
    stream.end()
  })
}

export function tailText(text: string, limit = 4000): string {
  if (!text) return ""
  return text.length > limit ? text.slice(text.length - limit) : text
}

/**
 * Spawn agy and resolve once. The returned promise never rejects for a normal
 * run: an unusable result is reported as a state (`failed`, `timed_out`), so
 * callers persist it instead of losing the job. Only invalid arguments and a
 * missing agy binary throw synchronously.
 */
export function runJob(input: RunInput): RunHandle {
  const args = buildArgs(input)
  const command = input.launcher?.command ?? input.agyPath ?? resolveAgyPath()
  if (!command) {
    throw new Error(
      "agy was not found on PATH. Install the Antigravity CLI or put agy.EXE on PATH."
    )
  }

  const prefix = input.launcher?.args ?? []
  const timeoutMs = input.timeoutMs ?? Math.max(1, input.timeoutMinutes) * 60_000
  const startedAt = Date.now()
  mkdirSync(input.outputDir, { recursive: true })
  const paths = jobPaths(input.outputDir, input.jobID)

  const logStream = createWriteStream(paths.log)
  const errStream = createWriteStream(paths.err)
  logStream.on("error", () => {})
  errStream.on("error", () => {})

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(command, [...prefix, ...args], {
      cwd: input.directory,
      env: { ...process.env, NO_COLOR: "1", ...(input.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    void endStream(logStream)
    void endStream(errStream)
    return {
      pid: null,
      kill: () => false,
      done: Promise.resolve({
        state: "failed",
        exitCode: null,
        startedAt,
        endedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        response: "",
        deniedActions: [],
        error: `failed to start agy: ${message}`,
        agy: null,
        paths,
      }),
    }
  }

  // A single line at each edge of the run. agy's json output arrives in one
  // burst at exit, so without this `status` shows an empty log for minutes.
  logStream.write(
    `${heartbeat(`started pid=${child.pid ?? "unknown"} at ${new Date(startedAt).toISOString()}`)}\n`
  )

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let stdoutOverflow = false
  let stderrOverflow = false

  let timedOut = false
  let cancelled = false
  let settled = false
  let exitCode: number | null = null
  let spawnError: Error | null = null

  const finish = async (): Promise<RunResult> => {
    const endedAt = Date.now()
    logStream.write(
      `${heartbeat(`exit code=${exitCode ?? "null"} duration=${endedAt - startedAt}ms`)}\n`
    )
    await endStream(logStream)
    await endStream(errStream)

    const stdoutText = stripAnsi(Buffer.concat(stdoutChunks).toString("utf8"))
    const stderrText = stripAnsi(Buffer.concat(stderrChunks).toString("utf8"))
    const combined = `${stdoutText}\n${stderrText}`

    let agy: unknown = null
    let parseError: string | null = null
    const trimmed = stdoutText.trim()
    if (!trimmed) {
      parseError = "stdout was empty"
    } else {
      try {
        agy = JSON.parse(trimmed)
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error)
      }
    }

    const record = (agy && typeof agy === "object" ? agy : {}) as Record<string, unknown>
    const response = typeof record.response === "string" ? record.response : ""
    const deniedActions = Array.isArray(record.denied_actions)
      ? record.denied_actions.map(formatDenied)
      : []

    let state: JobState = "failed"
    let error: string | undefined

    if (spawnError) {
      error = `failed to start agy: ${spawnError.message}`
    } else if (cancelled) {
      state = "cancelled"
      error = "cancelled by the caller; process tree killed"
    } else if (timedOut) {
      state = "timed_out"
      error = `timed out after ${Math.round(timeoutMs / 1000)}s; process tree killed`
    } else if (stdoutOverflow) {
      error = `stdout exceeded ${MAX_STDOUT_BYTES} bytes; log file is complete, result was not parsed`
    } else if (exitCode !== 0) {
      const timeoutReported = /print[- ]?timeout|timed out|timeout/i.test(combined)
      if (timeoutReported) {
        state = "timed_out"
        error = `agy reported a timeout (exit ${exitCode}): ${tailText(stderrText || stdoutText, 2000)}`
      } else {
        error = `agy exited with code ${exitCode}: ${tailText(stderrText || stdoutText, 2000)}`
      }
    } else if (parseError) {
      error = `agy output was not valid JSON (${parseError}). Output tail: ${tailText(stdoutText, 2000)}`
    } else if (record.status !== "SUCCESS") {
      error = `agy status was ${String(record.status ?? "missing")}: ${tailText(stdoutText, 2000)}`
    } else if (!response.trim()) {
      state = "degraded"
      error = deniedActions.length
        ? `empty response; denied actions: ${deniedActions.join(", ")}`
        : "empty response"
    } else {
      state = "done"
    }

    const result: RunResult = {
      state,
      exitCode,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      response,
      conversationID:
        typeof record.conversation_id === "string" ? record.conversation_id : undefined,
      numTurns: typeof record.num_turns === "number" ? record.num_turns : undefined,
      durationSeconds:
        typeof record.duration_seconds === "number" ? record.duration_seconds : undefined,
      usage: mapUsage(record.usage),
      deniedActions,
      error,
      agy,
      pid: child.pid ?? null,
      paths,
    }

    // Preliminary copy so a result is on disk even if the plugin process is
    // interrupted right after the child exits. index.ts rewrites it with the
    // full persisted job record.
    try {
      writeResultFile(
        paths.json,
        {
          id: input.jobID,
          state,
          exitCode,
          startedAt,
          endedAt,
          mode: input.mode,
          model: input.model,
          effort: input.effort,
          conversation: input.conversation,
          directory: input.directory,
          usage: result.usage,
          // `denied` plus the timing fields are what jobs.ts merges back into
          // the record when a reload has to recover this file.
          denied: deniedActions,
          durationMs: result.durationMs,
          conversationID: result.conversationID,
          numTurns: result.numTurns,
          error,
          paths,
        },
        agy
      )
    } catch {
      // A missing JSON file is reported by status/result; the run itself counts.
    }

    return result
  }

  const settle = () => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(killTimer)
    finish()
      .then((result) => resolveDone(result))
      .catch((error: unknown) => {
        // Without this the promise never resolves and the job holds a slot
        // forever; the .catch in index.ts could never fire.
        resolveDone({
          state: "failed",
          exitCode,
          startedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          response: "",
          deniedActions: [],
          error: `runner crashed while finishing: ${error instanceof Error ? error.message : String(error)}`,
          agy: null,
          pid: child.pid ?? null,
          paths,
        })
      })
  }

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child.pid ?? 0)
    // If the child ignores taskkill, resolve anyway shortly after.
    killTimer = setTimeout(() => settle(), 2000)
  }, timeoutMs)
  let killTimer: ReturnType<typeof setTimeout>

  child.on("error", (error) => {
    spawnError = error
    settle()
  })

  // `exit` fires before `close`: after it, the pid is gone and a kill would
  // either be a no-op or hit a recycled pid.
  let exited = false
  child.on("exit", () => {
    exited = true
  })

  child.stdout?.on("data", (chunk: Buffer) => {
    // A forced settle (timeout/cancel fallback) already ended the stream; a
    // late chunk would hit write-after-end and be lost silently anyway.
    if (!settled) logStream.write(chunk)
    stdoutBytes += chunk.length
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      stdoutOverflow = true
    } else {
      stdoutChunks.push(chunk)
    }
  })

  child.stderr?.on("data", (chunk: Buffer) => {
    if (!settled) errStream.write(chunk)
    stderrBytes += chunk.length
    if (stderrBytes <= MAX_STDERR_BYTES) stderrChunks.push(chunk)
    else stderrOverflow = true
  })

  child.on("close", (code) => {
    exitCode = code
    settle()
  })

  let resolveDone: (result: RunResult) => void = () => {}
  const done = new Promise<RunResult>((resolve) => {
    resolveDone = resolve
  })

  // `stderrOverflow` currently only guards memory; the .err file is complete.
  void stderrOverflow

  return {
    pid: child.pid ?? null,
    done,
    kill: () => {
      // Nothing to kill: the result is already being written, the child is
      // gone, or the timeout path owns the tree. Reporting "cancelled" here
      // would be a lie, so tell the caller it did not apply.
      if (settled || exited || timedOut) return false
      cancelled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      killTree(child.pid ?? 0)
      // Same guard as the timeout path: resolve even if taskkill is ignored.
      killTimer = setTimeout(() => settle(), 2000)
      return true
    },
  }
}

/**
 * Last N non-empty lines of a log file, for `action=status`. Only the final
 * `maxBytes` of the file are read: a status call must not load an 8 MB log.
 */
export function readTail(path: string, lines = 20, maxBytes = TAIL_BYTES): string {
  let text: string
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const length = size - start
    if (length <= 0) return ""

    const buffer = Buffer.allocUnsafe(length)
    const fd = openSync(path, "r")
    let read = 0
    try {
      read = readSync(fd, buffer, 0, length, start)
    } finally {
      closeSync(fd)
    }
    if (read <= 0) return ""

    // Only the bytes actually read: allocUnsafe may hold older data.
    text = buffer.subarray(0, read).toString("utf8")
    // When the window starts mid-file, the first line is a fragment: drop it.
    if (start > 0) {
      const newline = text.indexOf("\n")
      text = newline < 0 ? "" : text.slice(newline + 1)
    }
  } catch {
    return ""
  }

  const all = text.split(/\r?\n/)
  while (all.length && all[all.length - 1] === "") all.pop()
  return all.slice(-lines).join("\n")
}

/** Reads a result file produced by writeResultFile, or null when absent/broken. */
export function readResultFile(
  outputDir: string,
  jobID: string
): { job?: unknown; agy?: unknown } | null {
  const path = join(outputDir, `${jobID}.json`)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (!parsed || typeof parsed !== "object") return null
    return parsed as { job?: unknown; agy?: unknown }
  } catch {
    return null
  }
}
