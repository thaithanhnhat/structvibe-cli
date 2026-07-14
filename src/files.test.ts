import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RepositoryFile } from "./repository/index";
import { hashRepositoryContent } from "./repository/index";
import { readBaseFiles, restoreWorkingPaths, treeForFiles, writeBaseFiles } from "./files";

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

async function objectFiles(root: string) {
  const objects = join(root, ".structvibe", "objects");
  const result: string[] = [];
  for (const prefix of await readdir(objects)) {
    for (const entry of await readdir(join(objects, prefix))) result.push(`${prefix}/${entry}`);
  }
  return result.sort();
}

test("base snapshots use compressed content-addressed objects without a mirrored tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-objects-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = [file("overview.md", "same content"), file("decisions/DEC-001.md", "same content")];

  await writeBaseFiles(root, files);

  assert.equal((await objectFiles(root)).length, 1);
  await assert.rejects(access(join(root, ".structvibe", "base")), { code: "ENOENT" });
  assert.deepEqual(await readBaseFiles(root, treeForFiles(files)), [
    file("decisions/DEC-001.md", "same content"),
    file("overview.md", "same content")
  ]);
});

test("pruning objects also removes empty hash prefix directories", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-objects-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const retained = file("overview.md", "retained");

  await writeBaseFiles(root, [retained, file("decisions/DEC-001.md", "orphaned")]);
  await writeBaseFiles(root, [retained]);

  const prefixes = await readdir(join(root, ".structvibe", "objects"));
  assert.deepEqual(prefixes, [hashRepositoryContent(retained.content).slice(0, 2)]);
});

test("legacy mirrored snapshots migrate automatically", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-legacy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = "overview.md";
  const content = "legacy snapshot";
  await mkdir(join(root, ".structvibe", "base"), { recursive: true });
  await writeFile(join(root, ".structvibe", "base", path), content, "utf8");

  const result = await readBaseFiles(root, { [path]: hashRepositoryContent(content) });

  assert.equal(result[0]?.content, content);
  assert.equal((await objectFiles(root)).length, 1);
  await assert.rejects(access(join(root, ".structvibe", "base")), { code: "ENOENT" });
});

test("base object corruption is detected", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-corrupt-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const files = [file("overview.md", "trusted snapshot")];
  await writeBaseFiles(root, files);
  const [stored] = await objectFiles(root);
  assert.ok(stored);
  await writeFile(join(root, ".structvibe", "objects", stored), "not brotli");

  await assert.rejects(readBaseFiles(root, treeForFiles(files)), /corrupt|hash check/u);
});
