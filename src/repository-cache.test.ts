import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listStoredObjectHashes, readBaseFiles } from "./files";
import {
  listRefs,
  normalizeBranchRef,
  pruneRepositoryCache,
  readCommit,
  storeRepositoryPack,
  trackRemoteBranch
} from "./repository-cache";
import { hashRepositoryContent } from "./repository/index";
import type { RepositoryPackCommit, RepositoryPackResponse } from "./types";

const mainCommitId = "11111111-1111-4111-8111-111111111111";
const featureCommitId = "22222222-2222-4222-8222-222222222222";

test("normalizes familiar origin branch references", () => {
  assert.equal(normalizeBranchRef("design/login"), "design/login");
  assert.equal(normalizeBranchRef("origin/design/login"), "design/login");
  assert.equal(normalizeBranchRef("remotes/origin/design/login"), "design/login");
  assert.throws(() => normalizeBranchRef("origin/../main"), /Invalid StructVibe branch name/u);
});

function commit(id: string, tree: Record<string, string>, message: string): RepositoryPackCommit {
  return {
    id,
    contentHash: "c".repeat(64),
    treeHash: "d".repeat(64),
    tree,
    message,
    authorType: "user",
    authorId: "user-id",
    authorLabel: "Test User",
    createdAt: "2026-07-14T00:00:00.000Z"
  };
}

function pack(includeFeature = true): RepositoryPackResponse {
  const shared = "shared";
  const mainOnly = "main only";
  const featureOnly = "feature only";
  const objects = [shared, mainOnly, ...(includeFeature ? [featureOnly] : [])]
    .map((content) => ({
      hash: hashRepositoryContent(content),
      content,
      mediaType: "text/markdown",
      byteSize: Buffer.byteLength(content)
    }));
  const main = commit(mainCommitId, {
    "overview.md": hashRepositoryContent(shared),
    "decisions/DEC-main.md": hashRepositoryContent(mainOnly)
  }, "Main");
  const feature = commit(featureCommitId, {
    "overview.md": hashRepositoryContent(shared),
    "decisions/DEC-feature.md": hashRepositoryContent(featureOnly)
  }, "Feature");
  return {
    ok: true,
    repositoryProfileVersion: 2,
    project: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Project", slug: "project" },
    branches: [
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "main", protected: true, headCommitId: main.id, updatedAt: "2026-07-14T00:00:00.000Z" },
      ...(includeFeature ? [{ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "design/login", protected: false, headCommitId: feature.id, updatedAt: "2026-07-14T00:00:00.000Z" }] : [])
    ],
    commits: [main, ...(includeFeature ? [feature] : [])],
    objects,
    objectCount: objects.length,
    transferredObjectCount: objects.length
  };
}

test("repository pack stores every remote branch without duplicating shared blobs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-pack-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await storeRepositoryPack(root, pack());
  await trackRemoteBranch(root, "main");
  await pruneRepositoryCache(root);

  assert.deepEqual((await listRefs(root, "remote")).map((ref) => ref.name), ["design/login", "main"]);
  assert.deepEqual((await listRefs(root, "local")).map((ref) => ref.name), ["main"]);
  assert.equal((await listStoredObjectHashes(root)).length, 3);
  const feature = await readCommit(root, featureCommitId);
  assert.ok(feature);
  assert.equal((await readBaseFiles(root, feature.tree)).find((file) => file.path === "overview.md")?.content, "shared");
});

test("cache pruning retains local commits and removes unreachable remote objects", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-pack-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await storeRepositoryPack(root, pack());
  await trackRemoteBranch(root, "main");
  await storeRepositoryPack(root, pack(false));
  await pruneRepositoryCache(root);

  assert.equal((await listStoredObjectHashes(root)).length, 2);
  assert.deepEqual(await readdir(join(root, ".structvibe", "commits")), [`${mainCommitId}.json`]);
});

test("rejects an incomplete pack before replacing remote refs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-pack-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const initial = pack();
  await storeRepositoryPack(root, initial);
  await assert.rejects(
    storeRepositoryPack(root, { ...initial, commits: initial.commits.slice(0, 1) }),
    /Pack is missing head commit/u
  );

  assert.deepEqual((await listRefs(root, "remote")).map((ref) => ref.name), ["design/login", "main"]);
});
