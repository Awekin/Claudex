#!/usr/bin/env node
// SessionStart: hand the companion what only hooks can see. Uses its own variable
// names so it never overrides another plugin's CLAUDE_PLUGIN_DATA in the session.
import fs from "node:fs";
import process from "node:process";

const shellEscape = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
  input = {};
}

const envFile = process.env.CLAUDE_ENV_FILE;
if (envFile) {
  const vars = {
    ANTIGRAVITY_COMPANION_SESSION_ID: input.session_id,
    ANTIGRAVITY_COMPANION_TRANSCRIPT_PATH: input.transcript_path,
    ANTIGRAVITY_COMPANION_DATA: process.env.CLAUDE_PLUGIN_DATA
  };
  const lines = Object.entries(vars)
    .filter(([, value]) => value)
    .map(([name, value]) => `export ${name}=${shellEscape(value)}\n`)
    .join("");
  if (lines) fs.appendFileSync(envFile, lines, "utf8");
}
