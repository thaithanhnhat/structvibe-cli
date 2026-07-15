import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCheckoutAsset } from "./assets";
import type { CheckoutState, CliCredential } from "./types";

const credential: CliCredential = {
  server: "https://structvibe.test",
  token: "secret-test-token",
  tokenId: "token-id",
  workspaceId: "workspace-id",
  workspaceName: "Workspace",
  workspaceSlug: "workspace",
  userEmail: "user@example.com"
};

const state: CheckoutState = {
  schemaVersion: 1,
  server: credential.server,
  projectId: "260e1331-b0a6-47ca-85b7-d53d8d16e95d",
  projectSlug: "luyende",
  projectName: "LuyenDe",
  branch: "main",
  baseCommitId: "b9afe5c8-ff33-4d8d-be4c-3edef54c51cd",
  baseTree: {}
};

test("asset cache verifies content hashes and avoids duplicate downloads", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-assets-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bytes = new TextEncoder().encode("immutable asset");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return { bytes, contentType: "image/svg+xml", etag: `"${hash}"` };
  };

  const first = await resolveCheckoutAsset(root, state, credential, hash, fetcher);
  const second = await resolveCheckoutAsset(root, state, credential, hash, fetcher);
  assert.equal(first.contentType, "image/svg+xml");
  assert.deepEqual(second.bytes, bytes);
  assert.equal(requests, 1);
});

test("asset cache rejects bytes that do not match the requested hash", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-assets-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bytes = new TextEncoder().encode("wrong asset");
  await assert.rejects(
    resolveCheckoutAsset(root, state, credential, "a".repeat(64), async () => ({
      bytes,
      contentType: "image/png",
      etag: null
    })),
    /immutable content hash/u
  );
});

test("asset cache coalesces concurrent downloads of the same content hash", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "structvibe-assets-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bytes = new TextEncoder().encode("shared immutable asset");
  const hash = createHash("sha256").update(bytes).digest("hex");
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { bytes, contentType: "image/png", etag: `"${hash}"` };
  };

  const [first, second, third] = await Promise.all([
    resolveCheckoutAsset(root, state, credential, hash, fetcher),
    resolveCheckoutAsset(root, state, credential, hash, fetcher),
    resolveCheckoutAsset(root, state, credential, hash, fetcher)
  ]);
  assert.equal(requests, 1);
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(second.bytes, third.bytes);
});
