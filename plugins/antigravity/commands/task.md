---
description: Delegate a coding task, fix or second opinion to an Antigravity model via agy (Gemini 4 Hydrogen/Argon, Flash, Claude Opus/Sonnet)
argument-hint: "[--model <hydrogen|hydrogen-high|hydrogen-xhigh|argon|flash|opus|sonnet|auto>] [--background] [--fresh] [--no-context] [--read-only] <task>"
allowed-tools: Bash(node:*)
---

Run the Antigravity companion with the user's request and show its output verbatim.

Raw request:
$ARGUMENTS

Rules:
- If the request has no `--model`, pick one yourself using the model guide in the `antigravity:antigravity-cli` skill and add `--model <alias>`.
- Keep `--background`, `--fresh`, `--no-context`, `--read-only` as given. Long or multi-file tasks: add `--background`.
- Run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-companion.mjs" task <flags> "<task text>"`
- Show the companion's stdout to the user as is (it is a Markdown card). Then, if files changed, briefly check the diff before claiming the work is done.
