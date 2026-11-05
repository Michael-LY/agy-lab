# agy-lab

Sandbox repo for prototyping how OpenCode drives the local Antigravity CLI (`agy`) as a background
tool. It is not an application: there is no build, test framework, lint, CI, formatter,
`package.json`, or `node_modules`, and none should be added. Verification is
`node scripts/smoke.mjs` plus the manual checklist in `README.md`.

## The `agy` plugin (v1)

`plugins/agy/` is a zero-dependency OpenCode V2 plugin, loaded from `opencode.json`. It
uses a plain object (`export default { id, setup }`) rather than `Plugin.define` because importing
`@opencode/plugin` is off-limits here.

- `index.ts` — registers the single `agy` tool, validates `action` / `prompt` / `jobID`, calls
  `ctx.permission.assert` for non-`plan` modes, persists jobs, injects synthetic completion
  messages with `delivery: "queue"` (suppressed by `notifyOnComplete: false`), refreshes the model
  list once on an unknown `model`, and serves `action=cancel` from the in-memory job handles.
- `runner.ts` — builds argv, spawns agy without a shell, streams stdout/stderr into the output
  directory, writes `[agy-runner]` start/exit lines into the log, enforces the timeout, kills the
  process tree (timeout or cancel), and reads status tails from the last 64 KB only. Uses only
  erasable TypeScript so Node can import it directly from `scripts/smoke.mjs`.
- `models.ts` — reads `ctx.storage` key `models/cache`, refreshes via `agy models` (5 s timeout),
  and falls back to the old cache or a free-string `model` parameter.
- `jobs.ts` — `jobs/<jobID>` records, 50-finished-job retention, orphan reconciliation.

Options (`opencode.json`): `defaultMode`, `maxConcurrent`, `timeoutMinutes`, `outputDir`,
`modelCacheTtlHours`, `notifyOnComplete`, optional `defaultModel`. Keep v1 scope: no subagents,
slash commands, queueing, `jsonSchema`, `addDir`/`directory` overrides, `agent`/`sandbox`
passthrough, TUI panels, or quota display.

## Calling `agy`

- Print mode has no `run`/`query` subcommand — it is `-p` / `--print`:
  `agy -p "<prompt>" --output-format json`
- `agy models` lists model **IDs** (`gemini-4-argon-high`, `claude-opus-5-5-high`,
  `gpt-oss-120b-medium`, …). Pass those to `--model`; the display names ("Gemini 4 Argon (High)")
  are not valid.
- `--print-timeout` defaults to `0s`, which waits until the turn completes. Set it
  (e.g. `--print-timeout 90s`) for scripted calls so a stuck turn cannot hang the session.
- JSON mode returns one object:
  `{conversation_id, status: "SUCCESS", response, duration_seconds, num_turns,
  usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}}`.
  `total_tokens` is input+output only — cache reads and thinking tokens are reported
  separately, so do not use it as the cost of a run.
- Resume work with `-c` / `--continue` (most recent conversation) or
  `--conversation <conversation_id>`.
- `--dangerously-skip-permissions` auto-approves tool permission requests. It is only
  acceptable here because the repo is throwaway; never reuse it against a real project.
- `--output-format stream-json` requires `--input-format stream-json` (one NDJSON message
  per line on stdin).

## Layout

- `opencode.json` — project OpenCode config; lists the local plugin and its options.
- `plugins/agy/` — the plugin implementation (`index.ts`, `runner.ts`, `models.ts`,
  `jobs.ts`). `.opencode/` is intentionally **not** git-ignored: config here is meant to be
  committed.
- `scripts/smoke.mjs` and `scripts/fixtures/fake-agy.mjs` — offline verification; the fake is
  selected with `FAKE_AGY_MODE`.
- `.agy-out/` — git-ignored job output (`<jobID>.log`, `.err`, `.json`); also `tmp/`, `*.log`.
  Keep experiment noise out of tracked files.
- `.opencode/agents/` does not exist yet; subagents are out of scope for v1.

## Verification

- `node scripts/smoke.mjs` — must be all green before claiming a change works.
- `AGY_SMOKE_REAL=1 node scripts/smoke.mjs` — optional, spends Antigravity quota.
- `opencode plugin list` — the local plugin directory should appear once.
- The full manual checklist (permission prompt, synthetic wake-up, orphaned after restart,
  concurrency error, offline model cache) is in `README.md`.

## Environment notes

- Windows + PowerShell: `head`/`tail` do not exist. Use `Select-Object -First N`.
- `agy` is installed at `C:\Users\moyi_\AppData\Local\agy\bin\agy.EXE` (on PATH).
- Node 26 strips TypeScript types natively; the smoke test relies on that and needs no build step.
- The `antigravity` skill covers established agy delegation / cross-review patterns; read
  it before designing a new subagent or tool wrapper here.
