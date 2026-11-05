// Fake `agy` used by scripts/smoke.mjs. It receives the same argv the real CLI
// would get and switches on FAKE_AGY_MODE.

import { writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const mode = process.env.FAKE_AGY_MODE ?? "ok"

if (process.env.FAKE_AGY_ARGV_FILE) {
  writeFileSync(process.env.FAKE_AGY_ARGV_FILE, JSON.stringify(args, null, 2))
}

const usage = {
  input_tokens: 11,
  output_tokens: 22,
  thinking_tokens: 3,
  cache_read_tokens: 4,
  total_tokens: 33,
}

const base = {
  conversation_id: "conv-fake",
  status: "SUCCESS",
  duration_seconds: 0.2,
  num_turns: 1,
  usage,
}

switch (mode) {
  case "ok":
    console.log(
      JSON.stringify({
        ...base,
        response: "fake agy response\nsecond line",
        denied_actions: [],
      })
    )
    break

  case "echo-args":
    console.log(JSON.stringify({ ...base, response: JSON.stringify(args), denied_actions: [] }))
    break

  case "empty-denied":
    console.log(JSON.stringify({ ...base, response: "", denied_actions: ["write_file"] }))
    break

  case "badstatus":
    console.log(JSON.stringify({ ...base, status: "ERROR", response: "should not be used" }))
    break

  case "nonzero":
    console.error("boom: agy failed to run\nstack line two")
    process.exit(3)
    break

  case "badjson":
    console.log("this is not json")
    break

  case "timeout":
    if (process.env.FAKE_AGY_PID_FILE) {
      writeFileSync(process.env.FAKE_AGY_PID_FILE, String(process.pid))
    }
    console.log("fake agy is working...")
    // Keep the process alive until the runner's hard kill.
    setTimeout(() => console.log("fake agy finished too late"), 60_000)
    break

  default:
    console.error(`unknown FAKE_AGY_MODE: ${mode}`)
    process.exit(2)
}
