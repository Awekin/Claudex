---
name: antigravity-cli
description: How to delegate work to Antigravity models from Claude Code and how to choose the model (Gemini 4 Hydrogen/Argon, Flash, Claude Opus/Sonnet). Use when the user asks to send something to Antigravity/Gemini, or when a second model would help.
---

# Antigravity from Claude Code

Requires the Antigravity app to be running (the companion talks to its local agent server).

Companion: `node "${CLAUDE_PLUGIN_ROOT}/scripts/antigravity-companion.mjs" <command>`

| Command | Purpose |
|---|---|
| `models` | Models with remaining quota and their aliases |
| `task [--model A] [--background] [--fresh] [--no-context] [--read-only] "<task>"` | Run a task; Antigravity edits files in the git root of the current directory |
| `status [job-id]` | Jobs and live progress |
| `result [job-id]` | Result card |

Behaviour:
- Without `--fresh` a task continues this Claude session's Antigravity conversation, so the model keeps its context.
- Recent Claude conversation is attached as context unless `--no-context`.
- `--read-only` only asks the model not to edit; it is not enforced.
- If the chosen model has no quota, the companion picks the next one and says so in the card.

Choosing the model yourself (default `hydrogen`):
- quick question / tiny edit → `flash-low`
- normal task → `hydrogen`
- hard bug, multi-file change → `hydrogen-high`
- architecture, very hard or long task → `hydrogen-xhigh`
- second Gemini opinion or Hydrogen exhausted → `argon`
- Claude-family second opinion → `opus` (hard) / `sonnet` (normal); small quota

After a task that changed files, look at `git diff` before telling the user it is done.
