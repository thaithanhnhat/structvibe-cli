import assert from "node:assert/strict";
import test from "node:test";
import { fetchCliIdentity, fetchRepositoryPack, fetchSnapshot, startDeviceAuthorization } from "./api";
import { REPOSITORY_PROFILE_VERSION } from "./repository/index";
import type { CliCredential, SnapshotResponse } from "./types";

const credential: CliCredential = {
  server: "https://structvibe.test",
  token: "secret-test-token",
  tokenId: "token-id",
  workspaceId: "workspace-id",
  workspaceName: "Workspace",
  workspaceSlug: "workspace",
  userEmail: "user@example.com"
};

function snapshot(repositoryProfileVersion: number): SnapshotResponse {
  return {
    ok: true,
    repositoryProfileVersion,
    project: { id: "project-id", name: "Project", slug: "project" },
    branch: { id: "branch-id", name: "main", protected: true },
    commit: { id: "commit-id", tree: {}, contentHash: "hash", message: "Initial" },
    files: []
  };
}

test("sends the token only as a Bearer header and accepts the matching profile", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://structvibe.test/api/cli/projects/project/snapshot?branch=main");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-test-token");
    return Response.json(snapshot(REPOSITORY_PROFILE_VERSION));
  };
  try {
    const result = await fetchSnapshot(credential, "project", "main");
    assert.equal(result.repositoryProfileVersion, REPOSITORY_PROFILE_VERSION);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stops before using a repository profile the CLI does not understand", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(snapshot(REPOSITORY_PROFILE_VERSION + 1));
  try {
    await assert.rejects(
      fetchSnapshot(credential, "project", "main"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "REPOSITORY_PROFILE_MISMATCH"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetches a deduplicated repository pack with the local have set", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://structvibe.test/api/cli/projects/project/pack");
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), { have: ["a".repeat(64)] });
    return Response.json({
      ok: true,
      repositoryProfileVersion: REPOSITORY_PROFILE_VERSION,
      project: { id: "project-id", name: "Project", slug: "project" },
      branches: [],
      commits: [],
      objects: [],
      objectCount: 1,
      transferredObjectCount: 0
    });
  };
  try {
    const result = await fetchRepositoryPack(credential, "project", ["a".repeat(64)]);
    assert.equal(result.transferredObjectCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("starts browser authorization without sending a bearer credential", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://structvibe.test/api/cli/oauth/device");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.deepEqual(JSON.parse(String(init?.body)), { clientName: "sv test" });
    return Response.json({
      ok: true,
      deviceCode: "device-code",
      userCode: "SV-TEST-CODE",
      verificationUri: "https://structvibe.test/cli/authorize",
      verificationUriComplete: "https://structvibe.test/cli/authorize?code=SV-TEST-CODE",
      expiresIn: 600,
      interval: 2
    });
  };
  try {
    const result = await startDeviceAuthorization("https://structvibe.test", "sv test");
    assert.equal(result.userCode, "SV-TEST-CODE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validates a supplied access token with whoami", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://structvibe.test/api/cli/auth/whoami");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer supplied-token");
    return Response.json({
      ok: true,
      repositoryProfileVersion: REPOSITORY_PROFILE_VERSION,
      token: { id: "token-id", label: "CI", scopes: ["repository:read"], expiresAt: null },
      workspace: { id: "workspace-id", name: "Workspace", slug: "workspace" },
      user: { id: "user-id", email: "user@example.com", name: null }
    });
  };
  try {
    const result = await fetchCliIdentity("https://structvibe.test", "supplied-token");
    assert.equal(result.token.id, "token-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
