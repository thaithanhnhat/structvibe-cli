import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RepositoryFile } from "./repository/index";
import { restoreWorkingPaths } from "./files";

function file(path: string, content: string): RepositoryFile {
  return { path, content, mediaType: "text/markdown" };
}

test("restore only changes tracked StructVibe paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-restore-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, "overview.md"), "changed", "utf8");
  await writeFile(join(root, "application.ts"), "user source", "utf8");

  const restored = await restoreWorkingPaths(
    root,
    [file("overview.md", "original")],
    [file("overview.md", "changed")],
    ["overview.md"]
  );

  assert.deepEqual(restored, ["overview.md"]);
  assert.equal(await readFile(join(root, "overview.md"), "utf8"), "original");
  assert.equal(await readFile(join(root, "application.ts"), "utf8"), "user source");
});

test("restore removes a newly added tracked file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-restore-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(join(root, "tasks.md"), "new task", "utf8");
  const restored = await restoreWorkingPaths(root, [], [file("tasks.md", "new task")], ["tasks.md"]);

  assert.deepEqual(restored, ["tasks.md"]);
  await assert.rejects(readFile(join(root, "tasks.md"), "utf8"), { code: "ENOENT" });
});

test("restore rejects paths outside the StructVibe working tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-restore-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    restoreWorkingPaths(root, [file("overview.md", "original")], [file("overview.md", "changed")], ["../src"]),
    /outside the StructVibe working tree/u
  );
  await assert.rejects(
    restoreWorkingPaths(root, [file("overview.md", "original")], [file("overview.md", "changed")], [".structvibe"]),
    /outside the StructVibe working tree/u
  );
});
