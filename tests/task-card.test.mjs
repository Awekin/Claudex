import assert from "node:assert/strict";
import test from "node:test";

import { renderTaskResult, summarizeFileChanges } from "../plugins/codex/scripts/lib/render.mjs";

const fileChanges = [
  { changes: [{ path: "/repo/src/auth.ts", kind: { type: "update" }, diff: "--- a\n+++ b\n+one\n+two\n-old" }] },
  { changes: [{ path: "/repo/src/auth.ts", kind: { type: "update" }, diff: "+three" }, { path: "/repo/new.ts", kind: { type: "add" }, diff: "+x" }] }
];

test("summarizeFileChanges merges paths and counts diff lines", () => {
  assert.deepEqual(summarizeFileChanges(fileChanges, "/repo"), [
    { path: "src/auth.ts", kind: "update", added: 3, removed: 1 },
    { path: "new.ts", kind: "add", added: 1, removed: 0 }
  ]);
});

test("task card shows status, answer, files, commands and thread", () => {
  delete process.env.CODEX_COMPANION_PLAIN_OUTPUT;
  const card = renderTaskResult(
    { rawOutput: "Fixed the refresh bug.", reasoningSummary: ["Token expiry was ignored"] },
    {
      status: 0,
      write: true,
      threadId: "thread-1",
      threadName: "Claude → Codex: Fix login",
      workspaceRoot: "/repo",
      durationMs: 134000,
      fileChanges,
      commandExecutions: [
        { command: "/bin/zsh -lc 'npm test'", exitCode: 0 },
        { command: "/bin/zsh -lc 'npm run lint'", exitCode: 1 }
      ]
    }
  );
  assert.match(card, /^✅ \*\*Codex: готово\*\* · «Fix login» · 2 мин 14 с/);
  assert.match(card, /Fixed the refresh bug\./);
  assert.match(card, /Изменённые файлы \(2\)\*\* · \+4 −1/);
  assert.match(card, /🆕 `new\.ts`/);
  assert.match(card, /✗ `npm run lint` \(exit 1\)/);
  assert.match(card, /Token expiry was ignored/);
  assert.match(card, /thread-1/);
});

test("plain output mode keeps the bare message", () => {
  process.env.CODEX_COMPANION_PLAIN_OUTPUT = "1";
  try {
    assert.equal(renderTaskResult({ rawOutput: "done" }, { status: 0 }), "done\n");
  } finally {
    delete process.env.CODEX_COMPANION_PLAIN_OUTPUT;
  }
});
