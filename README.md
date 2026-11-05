# agy-lab

Testing ground for calling the local Antigravity CLI (`agy`) from OpenCode as a background tool.

## Why a separate repo

Keeps experiments with `agy` isolated from the main workspace: scratch files, throwaway diffs,
and the agent config under `.opencode/` all live here.

## Prerequisites

- `agy` on PATH (`agy models` lists the available models)
- OpenCode 2.x
- Node.js 26+ for the offline smoke tests (Node runs `runner.ts` directly via type stripping)

## Usage

Direct CLI call, for reference:

```sh
# what agy actually accepts (no run/query subcommand)
agy -p "Summarize README.md in three bullets" --output-format json
```

```json
{ "conversation_id": "...", "status": "SUCCESS", "response": "...", "usage": { "total_tokens": 2140 } }
```

## The `agy` OpenCode tool

The local plugin in `plugins/agy/` registers one tool, `agy`. Every call starts a
background job and returns a `jobID` immediately; completion arrives as a synthetic message.
Use `action=status` to poll and `action=result` to read the outcome.

| Parameter | Type | Meaning |
|---|---|---|
| `action` | `start` \| `status` \| `result`, default `start` | Dispatch |
| `prompt` | string, required for `start` | Passed to agy unchanged (`-p`) |
| `jobID` | string, required for `status`/`result` | ID returned by `start` |
| `model` | enum when a model cache exists, else string | Omitted: `options.defaultModel`, then agy's default |
| `mode` | `plan` \| `accept-edits` \| `auto` | Defaults to `options.defaultMode` (`plan`) |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | Optional `--effort` |
| `conversation` | string | Resume an exact agy conversation (`--conversation`) |
| `continue` | boolean | Resume agy's most recent conversation (`-c`); mutual exclusion with `conversation` |

`start` never rewrites the prompt. Write it as a complete task brief: goal, files, constraints, and
what done looks like.

Results are written to `.agy-out/` (configurable):

- `<jobID>.log` — stdout streamed while agy runs
- `<jobID>.err` — stderr
- `<jobID>.json` — `{ job, agy }`, pretty-printed; `agy` is the raw CLI JSON

`result` returns the state, duration, `conversation_id`, `num_turns`, token usage (input / output /
thinking / cache_read / total), denied actions, and the first 4000 characters of the response. A
`degraded` job (empty response, usually denied actions) also suggests retrying with `mode=plan`.
`status` returns the state, elapsed time, mode/model, the last 20 log lines, and all three paths.

### States

`running → done | degraded | failed | timed_out | orphaned`

- `done`: exit 0, valid JSON, `status=SUCCESS`, non-empty response.
- `degraded`: exit 0 but the response is empty (denied actions are called out).
- `failed`: non-zero exit, invalid JSON, or a non-`SUCCESS` status; the error carries the tail.
- `timed_out`: `--print-timeout` fired, or the plugin hard-killed the process tree.
- `orphaned`: the plugin reloaded while the job was running. If `<jobID>.json` already holds a
  terminal state, that state is restored instead.

Storage keeps the newest 50 finished jobs (and all running jobs); `.agy-out/` files are never
deleted by the plugin.

## Configuration

`opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/agy",
      "options": {
        "defaultMode": "plan",
        "maxConcurrent": 2,
        "timeoutMinutes": 10,
        "outputDir": ".agy-out",
        "modelCacheTtlHours": 24
      }
    }
  ]
}
```

`defaultModel` is optional. If it is set but not present in `agy models`, the plugin warns and lets
agy choose. Non-`plan` modes call `ctx.permission.assert` first; if permission is denied, no job is
created.

## Verification

Offline smoke test (fake agy, no quota):

```sh
node scripts/smoke.mjs
```

It covers `done`, `degraded`, `timed_out` (and confirms the process is really dead), `failed` for a
non-zero exit / invalid JSON / bad status, argv mapping including `conversation` vs `continue`,
model parsing, job retention, and orphan reconciliation.

One real agy turn, when you want to spend quota:

```sh
AGY_SMOKE_REAL=1 node scripts/smoke.mjs
```

### Manual checklist (real OpenCode)

1. Call the tool once: `agy` appears in the tool list, and the server log has a single
   `[agy] setup` line (no duplicate load).
2. `mode=plan`: `start` → `status` → `result`; `.agy-out/` contains the log, err, and JSON files.
3. `mode=accept-edits`: a permission prompt appears; rejecting it produces no job.
4. `continue` and `conversation` each resume the previous agy conversation.
5. Start a long job, then `opencode service restart`: after reload the job is `orphaned`.
6. Let a job finish while idle: with no input, the model is woken by the synthetic message and can
   read the result.
7. Start offline: the cached model list is used, or `model` degrades to a free string; the tool
   still works.
8. Start three jobs with `maxConcurrent: 2`: the third fails immediately and lists the running
   jobIDs.

### Known limits

- The plugin lives in `plugins/agy/`, not `.opencode/plugins/`: OpenCode 2.2.5 loaded
  `.opencode/plugins/agy/` twice (auto-discovery plus the `plugins` entry), so the directory was
  moved out of the auto-discovered path. `opencode plugin list` now shows it once.
- `ctx.storage` is treated as plugin-global. If it is actually location-scoped, the 50-job cap
  becomes per-location, which the plan accepts.
- Every completion synthetic triggers one real model turn. Do not automatically resubmit the same
  task after a completion; the notification says so too.
- `continue` targets agy's globally most recent conversation, which may belong to another repo.
  Use `conversation` when the exact conversation matters.
- A reload marks old jobs `orphaned` but does not adopt their child processes; files may keep
  changing after the state says orphaned.
- A single stdout larger than 8 MB marks the job `failed`; the log is still complete.
- The model enum is a hard check; a model added within the TTL is rejected until the cache refreshes
  or OpenCode restarts.
- POSIX process-tree termination is not exercised on this Windows machine.
- The plugin shows nothing about Antigravity quota; failures surface as agy errors.

Out of scope for v1: subagents, `/agy` command, cancellation, queueing, `jsonSchema`, `addDir` /
`directory` overrides, `agent` / `sandbox` passthrough, TUI panels, quota display.

## Layout

```
opencode.json               project-level OpenCode config (loads the plugin and its options)
plugins/agy/
  index.ts                  setup, tool schema, permissions, synthetic delivery
  runner.ts                 argv, child process, streamed logs, timeout, process-tree kill
  models.ts                 `agy models` fetch, storage cache, TTL and fallback
  jobs.ts                   job records, 50-job retention, orphan reconciliation
scripts/
  smoke.mjs                 offline runner/models/jobs checks
  fixtures/fake-agy.mjs     fake agy selected by FAKE_AGY_MODE
.agy-out/                   job logs and JSON (gitignored)
tmp/                        scratch (gitignored)
```
