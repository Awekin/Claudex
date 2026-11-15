import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const CODEX_BIN_ENV = "CODEX_COMPANION_CODEX_BIN";

// Codex CLI copies bundled with the desktop apps, used when `codex` is not on PATH.
const BUNDLED_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex"
];

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function onPath(name) {
  const dirs = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return dirs.some((dir) => exts.some((ext) => isExecutable(path.join(dir, name + ext))));
}

let cached = null;

/**
 * Returns the command used to launch Codex: $CODEX_COMPANION_CODEX_BIN, then `codex` on PATH,
 * then the CLI bundled inside the ChatGPT / Codex desktop app.
 */
export function resolveCodexBinary() {
  if (cached) {
    return cached;
  }
  const override = process.env[CODEX_BIN_ENV];
  if (override) {
    cached = override;
  } else if (onPath("codex")) {
    cached = "codex";
  } else {
    cached = BUNDLED_CANDIDATES.find(isExecutable) ?? "codex";
  }
  return cached;
}
