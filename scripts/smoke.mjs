// Offline smoke test for the agy plugin's runner, models and jobs layers.
//
//   node scripts/smoke.mjs
//
// It does not need OpenCode, does not install anything, and (unless
// AGY_SMOKE_REAL=1) does not spend Antigravity quota.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildArgs,
  jobPaths,
  readResultFile,
  readTail,
  runJob,
  writeResultFile,
} from "../plugins/agy/runner.ts"
import { isModelsCacheStale, parseModelsOutput } from "../plugins/agy/models.ts"
import { pruneJobs, reconcileOrphans, saveJob } from "../plugins/agy/jobs.ts"
import plugin from "../plugins/agy/index.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")
const FAKE = join(HERE, "fixtures", "fake-agy.mjs")
const WORK = join(ROOT, ".agy-out", `smoke-${Date.now().toString(36)}`)

let checks = 0
let failures = 0

async function test(name, fn) {
  checks += 1
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  FAIL ${name}`)
    console.error(error instanceof Error ? error.stack : String(error))
  }
}

async function runFake(mode, extra = {}) {
  const jobID = `smoke-${mode}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const { env: extraEnv, ...rest } = extra
  const env = { FAKE_AGY_MODE: mode, ...(extraEnv ?? {}) }
  const handle = runJob({
    jobID,
    prompt: rest.prompt ?? "smoke prompt",
    directory: ROOT,
    outputDir: rest.outputDir ?? WORK,
    timeoutMinutes: rest.timeoutMinutes ?? 10,
    launcher: { command: process.execPath, args: [FAKE] },
    ...rest,
    env,
  })
  const result = await handle.done
  return { result, jobID }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === "EPERM"
  }
}

async function waitUntilDead(pid, timeoutMs = 5000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!isAlive(pid)) return true
    await new Promise((resolveNext) => setTimeout(resolveNext, 100))
  }
  return !isAlive(pid)
}

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    async get(key) {
      return data.get(key)
    },
    async set(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)))
    },
    async remove(key) {
      data.delete(key)
    },
    async scan({ prefix, after, limit = 100 }) {
      const keys = [...data.keys()]
        .filter((key) => key.startsWith(prefix))
        .filter((key) => (after ? key > after : true))
        .sort()
      const slice = keys.slice(0, limit)
      const entries = slice.map((key) => ({ key, value: data.get(key) }))
      const next = keys.length > limit ? entries[entries.length - 1].key : undefined
      return { entries, next }
    },
  }
}

function baseJob(id, state, startedAt, paths) {
  return {
    id,
    directory: ROOT,
    mode: "plan",
    startedAt,
    state,
    paths,
    notified: false,
  }
}

console.log(`agy smoke on node ${process.version} (${process.platform})`)
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

// 1. ok: full JSON, all three files.
await test("ok result is done and writes log/err/json", async () => {
  const { result } = await runFake("ok")

  assert.equal(result.state, "done", result.error)
  assert.equal(result.response, "fake agy response\nsecond line")
  assert.equal(result.conversationID, "conv-fake")
  assert.equal(result.numTurns, 1)
  assert.deepEqual(result.usage, { input: 11, output: 22, thinking: 3, cacheRead: 4, total: 33 })
  assert.deepEqual(result.deniedActions, [])

  for (const path of [result.paths.log, result.paths.err, result.paths.json]) {
    assert.ok(existsSync(path), `missing ${path}`)
  }

  // The runner adds its own edges to the log, so status is never empty.
  const log = readFileSync(result.paths.log, "utf8")
  assert.match(log, /\[agy-runner\] started pid=\d+/)
  assert.match(log, /\[agy-runner\] exit code=0 duration=\d+ms/)
  assert.match(log, /fake agy response/)
  const file = JSON.parse(readFileSync(result.paths.json, "utf8"))
  assert.equal(file.agy.status, "SUCCESS")
  assert.equal(file.agy.response, "fake agy response\nsecond line")
  assert.equal(file.job.state, "done")

  // The plugin rewrites the file with the persisted record; keep the shape.
  writeResultFile(result.paths.json, { id: "rewritten", state: "done" }, result.agy)
  const rewritten = JSON.parse(readFileSync(result.paths.json, "utf8"))
  assert.ok(rewritten)
  assert.equal(rewritten.job.state, "done")
  assert.equal(rewritten.agy.status, "SUCCESS")
})

// 2. empty response with denied actions.
await test("empty response + denied_actions is degraded", async () => {
  const { result } = await runFake("empty-denied")
  assert.equal(result.state, "degraded")
  assert.deepEqual(result.deniedActions, ["write_file"])
  assert.match(result.error, /denied actions: write_file/)
})

// 3. hard timeout kills the process tree.
await test("timeout is timed_out and the child is dead", async () => {
  const pidFile = join(WORK, "timeout.pid")
  const started = Date.now()
  const { result } = await runFake("timeout", {
    timeoutMs: 1200,
    env: { FAKE_AGY_PID_FILE: pidFile },
  })
  const elapsed = Date.now() - started

  assert.equal(result.state, "timed_out", result.error)
  assert.ok(result.pid, "expected a pid")
  assert.ok(elapsed < 10_000, `timeout took too long: ${elapsed}ms`)
  assert.ok(existsSync(pidFile), "fake agy did not write its pid file")

  const pid = Number(readFileSync(pidFile, "utf8"))
  assert.ok(Number.isInteger(pid) && pid > 0)
  assert.equal(await waitUntilDead(pid), true, `pid ${pid} is still alive`)
})

// 3b. cancel kills the process tree and reports its own state.
await test("cancel kills the child and reports cancelled", async () => {
  const pidFile = join(WORK, "cancel.pid")
  const handle = runJob({
    jobID: `cancel-${Date.now().toString(36)}`,
    prompt: "cancel me",
    directory: ROOT,
    outputDir: WORK,
    timeoutMinutes: 10,
    launcher: { command: process.execPath, args: [FAKE] },
    env: { FAKE_AGY_MODE: "timeout", FAKE_AGY_PID_FILE: pidFile },
  })

  const started = Date.now()
  while (!existsSync(pidFile) && Date.now() - started < 5000) {
    await new Promise((resolveNext) => setTimeout(resolveNext, 50))
  }
  assert.ok(existsSync(pidFile), "fake agy did not write its pid file")

  handle.kill()
  const result = await handle.done

  assert.equal(result.state, "cancelled", result.error)
  assert.match(result.error, /cancelled/)
  const pid = Number(readFileSync(pidFile, "utf8"))
  assert.equal(await waitUntilDead(pid), true, `pid ${pid} is still alive`)
})

// 3c. readTail must not load a large log.
await test("readTail reads only the end of a large log", () => {
  const path = join(WORK, "big.log")
  writeFileSync(path, `${"x".repeat(1000)}\n`.repeat(2000) + "last-line\n")

  const tail = readTail(path, 5)
  assert.ok(tail.endsWith("last-line"), "tail did not reach the last line")
  assert.ok(tail.length < 64 * 1024, `tail was ${tail.length} bytes`)

  assert.equal(readTail(join(WORK, "missing.log")), "")
})

// 4. non-zero exit, invalid JSON and non-SUCCESS status.
await test("non-zero exit is failed with stderr tail", async () => {
  const { result } = await runFake("nonzero")
  assert.equal(result.state, "failed")
  assert.match(result.error, /exited with code 3/)
  assert.match(result.error, /boom: agy failed to run/)
})

await test("invalid JSON is failed with stdout tail", async () => {
  const { result } = await runFake("badjson")
  assert.equal(result.state, "failed")
  assert.match(result.error, /not valid JSON/)
  assert.match(result.error, /this is not json/)
})

await test("non-SUCCESS status is failed", async () => {
  const { result } = await runFake("badstatus")
  assert.equal(result.state, "failed")
  assert.match(result.error, /agy status was ERROR/)
})

// 5. argv mapping, including mutual exclusion.
await test("buildArgs maps model/mode/effort/conversation and -c", () => {
  assert.deepEqual(
    buildArgs({
      prompt: "hi",
      timeoutMinutes: 10,
      model: "model-a",
      mode: "accept-edits",
      effort: "high",
      conversation: "conv-1",
    }),
    [
      "-p",
      "hi",
      "--output-format",
      "json",
      "--print-timeout",
      "9m",
      "--model",
      "model-a",
      "--mode",
      "accept-edits",
      "--effort",
      "high",
      "--conversation",
      "conv-1",
    ]
  )

  const continued = buildArgs({ prompt: "hi", timeoutMinutes: 1, continue: true })
  assert.equal(continued.at(-1), "-c")
  assert.equal(continued.includes("--conversation"), false)
  assert.equal(continued[continued.indexOf("--print-timeout") + 1], "1m")

  assert.throws(
    () => buildArgs({ prompt: "hi", timeoutMinutes: 10, conversation: "c", continue: true }),
    /mutually exclusive/
  )
})

await test("runner passes mapped argv through to agy", async () => {
  const argvFile = join(WORK, "argv.json")
  const expected = buildArgs({
    prompt: "mapped prompt",
    timeoutMinutes: 10,
    model: "model-a",
    mode: "plan",
    effort: "low",
    conversation: "conv-9",
  })
  const { result } = await runFake("echo-args", {
    prompt: "mapped prompt",
    model: "model-a",
    mode: "plan",
    effort: "low",
    conversation: "conv-9",
    env: { FAKE_AGY_ARGV_FILE: argvFile },
  })

  assert.equal(result.state, "done", result.error)
  assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), expected)
  assert.deepEqual(JSON.parse(result.response), expected)
})

// 6. model parsing / cache staleness.
await test("models parser ignores the ANSI banner and blank rows", () => {
  const raw = "\u001b[31;1mFetching available models...\u001b[0m\nmodel-a\tModel A\n\nmodel-b\tModel B\n"
  assert.deepEqual(parseModelsOutput(raw), ["model-a", "model-b"])
  assert.equal(
    isModelsCacheStale({ ids: ["model-a"], fetchedAt: Date.now() - 25 * 60 * 60 * 1000 }, 24),
    true
  )
  assert.equal(isModelsCacheStale({ ids: ["model-a"], fetchedAt: Date.now() }, 24), false)
})

// 7. job retention and orphan reconciliation.
await test("pruneJobs keeps the newest 50 finished jobs and all running ones", async () => {
  const storage = makeStorage()
  const now = Date.now()
  for (let index = 0; index < 55; index += 1) {
    await saveJob(
      storage,
      baseJob(`done-${index}`, "done", now - (55 - index) * 1000, jobPaths(WORK, `done-${index}`))
    )
  }
  await saveJob(storage, baseJob("running-1", "running", now, jobPaths(WORK, "running-1")))

  const removed = await pruneJobs(storage, 50)
  assert.equal(removed.length, 5)
  assert.equal(storage.data.has("jobs/running-1"), true)
  assert.equal(storage.data.has("jobs/done-0"), false)
  assert.equal(storage.data.has("jobs/done-4"), false)
  assert.equal(storage.data.has("jobs/done-5"), true)
  assert.equal(storage.data.has("jobs/done-54"), true)
  assert.equal([...storage.data.keys()].filter((key) => key.startsWith("jobs/")).length, 51)
})

await test("reconcileOrphans recovers a finished file and marks the rest orphaned", async () => {
  const storage = makeStorage()
  const now = Date.now()

  const recovered = baseJob("recovered", "running", now, jobPaths(WORK, "recovered"))
  writeResultFile(
    recovered.paths.json,
    { id: "recovered", state: "done", endedAt: now + 10, durationMs: 10 },
    { status: "SUCCESS", response: "from file" }
  )
  await saveJob(storage, recovered)

  const orphan = baseJob("orphan", "running", now, jobPaths(WORK, "orphan"))
  await saveJob(storage, orphan)

  const outcome = await reconcileOrphans(storage, WORK)
  assert.equal(outcome.recovered.length, 1)
  assert.equal(outcome.orphaned.length, 1)
  assert.equal(storage.data.get("jobs/recovered").state, "done")
  assert.equal(storage.data.get("jobs/orphan").state, "orphaned")
})

// 8. Plugin setup registers exactly one tool with cached model enum.
await test("plugin setup registers one agy tool with the cached model enum", async () => {
  const storage = makeStorage({
    "models/cache": { ids: ["model-a", "model-b"], fetchedAt: Date.now() },
  })
  const tools = []
  const ctx = {
    options: { defaultMode: "plan", outputDir: WORK },
    location: { directory: ROOT },
    storage,
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => tools.push(tool) })
      },
      reload: async () => {},
    },
    session: { synthetic: async () => {} },
    permission: { assert: async () => {} },
  }

  await plugin.setup(ctx)

  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "agy")
  assert.deepEqual(tools[0].input.properties.action.enum, ["start", "status", "result", "cancel"])
  // Free-form on purpose: a new agy model must not wait for a restart.
  assert.equal(tools[0].input.properties.model.type, "string")
  assert.equal(tools[0].input.properties.model.enum, undefined)
  assert.match(tools[0].input.properties.model.description, /model-a, model-b/)
  assert.deepEqual(tools[0].input.properties.mode.enum, ["plan", "accept-edits", "auto"])

  const context = { sessionID: "session-1", agent: "build", messageID: "msg-1", id: "call-1" }

  await assert.rejects(
    () => tools[0].execute({ action: "start" }, context),
    /prompt is required/
  )
  await assert.rejects(
    () =>
      tools[0].execute(
        { action: "start", prompt: "x", conversation: "conv-1", continue: true },
        context
      ),
    /mutually exclusive/
  )

  const seededID = "seeded-degraded"
  const seededPaths = jobPaths(WORK, seededID)
  const startedAt = Date.now() - 5000
  await saveJob(storage, {
    id: seededID,
    sessionID: "session-1",
    directory: ROOT,
    mode: "plan",
    model: "model-a",
    startedAt,
    endedAt: startedAt + 5000,
    durationMs: 5000,
    state: "degraded",
    usage: { input: 1, output: 0, thinking: 0, cacheRead: 0, total: 1 },
    denied: ["write_file"],
    paths: seededPaths,
    notified: true,
  })
  writeResultFile(
    seededPaths.json,
    { id: seededID, state: "degraded" },
    {
      status: "SUCCESS",
      response: "",
      denied_actions: ["write_file"],
      conversation_id: "conv-seeded",
      num_turns: 2,
      usage: { input_tokens: 1, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1 },
    }
  )

  const resultOutput = await tools[0].execute({ action: "result", jobID: seededID }, context)
  assert.match(resultOutput.content, /state: degraded/)
  assert.match(resultOutput.content, /conversation_id: conv-seeded/)
  assert.match(resultOutput.content, /Retry with mode=plan/)

  const statusOutput = await tools[0].execute({ action: "status", jobID: seededID }, context)
  assert.match(statusOutput.content, /state: degraded/)
  assert.match(statusOutput.content, /log tail/)
})

// 9. Completion notifications: enough metadata for a one-round follow-up, and
// the silent switch.
function makePluginCtx({ storage, options = {}, synthetic = [] }) {
  const tools = []
  return {
    tools,
    synthetic,
    ctx: {
      options: { defaultMode: "plan", outputDir: WORK, ...options },
      location: { directory: ROOT },
      storage,
      tool: {
        transform: async (callback) => {
          callback({ add: (tool) => tools.push(tool) })
        },
        reload: async () => {},
      },
      session: {
        synthetic: async (message) => {
          synthetic.push(message)
        },
      },
      permission: { assert: async () => {} },
    },
  }
}

async function seedRunningJobWithResult(storage, id, sessionID = "session-1") {
  const paths = jobPaths(WORK, id)
  writeResultFile(
    paths.json,
    { id, state: "done", endedAt: Date.now(), durationMs: 10 },
    {
      status: "SUCCESS",
      response: "notified response",
      conversation_id: `conv-${id}`,
      num_turns: 2,
      usage: {
        input_tokens: 5,
        output_tokens: 6,
        thinking_tokens: 1,
        cache_read_tokens: 2,
        total_tokens: 11,
      },
    }
  )
  await saveJob(storage, {
    id,
    sessionID,
    directory: ROOT,
    mode: "plan",
    startedAt: Date.now() - 1000,
    state: "running",
    paths,
    notified: false,
  })
}

await test("completion notification carries conversation_id and usage", async () => {
  const storage = makeStorage({ "models/cache": { ids: ["model-a"], fetchedAt: Date.now() } })
  const jobID = `notify-${Date.now().toString(36)}`
  await seedRunningJobWithResult(storage, jobID)

  const { ctx, synthetic } = makePluginCtx({ storage })
  await plugin.setup(ctx)

  assert.equal(synthetic.length, 1)
  const text = synthetic[0].text
  assert.match(text, new RegExp(`conversation_id: conv-${jobID}`))
  assert.match(text, /num_turns: 2/)
  assert.match(text, /usage: input=5 output=6 thinking=1 cache_read=2 total=11/)
  assert.match(text, new RegExp(`pass conversation="conv-${jobID}"`))
  assert.equal(storage.data.get(`jobs/${jobID}`).notified, true)
})

await test("notifyOnComplete=false marks the job notified without a wake-up", async () => {
  const storage = makeStorage({ "models/cache": { ids: ["model-a"], fetchedAt: Date.now() } })
  const jobID = `silent-${Date.now().toString(36)}`
  await seedRunningJobWithResult(storage, jobID)

  const { ctx, synthetic } = makePluginCtx({ storage, options: { notifyOnComplete: false } })
  await plugin.setup(ctx)

  assert.equal(synthetic.length, 0)
  const stored = storage.data.get(`jobs/${jobID}`)
  assert.equal(stored.notified, true)
  assert.equal(stored.state, "done")
})

// 10. Cancellation: only jobs this process owns can be killed.
await test("cancel refuses unowned jobs and reports finished ones", async () => {
  const storage = makeStorage({ "models/cache": { ids: ["model-a"], fetchedAt: Date.now() } })
  const { ctx, tools } = makePluginCtx({ storage })
  await plugin.setup(ctx)

  const context = { sessionID: "session-1", agent: "build", messageID: "msg-1", id: "call-1" }

  const orphanID = `orphan-${Date.now().toString(36)}`
  await seedRunningJobWithResult(storage, orphanID) // running record, started after setup

  await assert.rejects(
    () => tools[0].execute({ action: "cancel", jobID: orphanID }, context),
    /not running in this process/
  )
  await assert.rejects(
    () => tools[0].execute({ action: "cancel", jobID: "nope" }, context),
    /no job nope/
  )

  const doneID = `finished-${Date.now().toString(36)}`
  await saveJob(storage, baseJob(doneID, "done", Date.now(), jobPaths(WORK, doneID)))
  const output = await tools[0].execute({ action: "cancel", jobID: doneID }, context)
  assert.match(output.content, /Nothing to cancel/)
})

// 11. Optional real agy run.
if (process.env.AGY_SMOKE_REAL === "1") {
  await test("real agy returns a response", async () => {
    const jobID = `smoke-real-${Date.now().toString(36)}`
    const handle = runJob({
      jobID,
      prompt: "Reply with exactly: AGY_SMOKE_OK",
      directory: ROOT,
      outputDir: join(WORK, "real"),
      timeoutMinutes: 2,
      mode: "plan",
    })
    const result = await handle.done
    assert.equal(result.state, "done", result.error)
    assert.match(result.response, /AGY_SMOKE_OK/)
  })
} else {
  console.log("  skip real agy (set AGY_SMOKE_REAL=1 to include it)")
}

if (failures > 0) {
  console.error(`\n${failures}/${checks} checks failed; scratch kept at ${WORK}`)
  process.exitCode = 1
} else {
  rmSync(WORK, { recursive: true, force: true })
  console.log(`\n${checks} checks passed`)
}
