# agy-lab

Testing ground for calling the local Antigravity CLI (`agy`) from OpenCode as a subagent / custom tool.

## Why a separate repo

Keeps experiments with `agy` subagents isolated from the main workspace: scratch files, throwaway diffs,
and the agent config under `.opencode/` all live here.

## Prerequisites

- `agy` on PATH (`agy models` lists the available models)
- OpenCode 2.x

## Usage

```sh
# what agy actually accepts (no run/query subcommand)
agy -p "Summarize README.md in three bullets" --output-format json
```

```json
{ "conversation_id": "...", "status": "SUCCESS", "response": "...", "usage": { "total_tokens": 2140 } }
```

## Layout

```
opencode.json          project-level OpenCode config
.opencode/agents/      subagent definitions (Markdown)
.opencode/plugins/     local plugins that register tools
src/                   nothing yet
```
