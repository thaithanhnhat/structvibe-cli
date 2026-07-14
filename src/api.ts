import { REPOSITORY_PROFILE_VERSION } from "./repository/index";
import type { CliCredential, SnapshotResponse } from "./types";

export class CliApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly data: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "CliApiError";
  }
}

export async function apiRequest<T>(
  server: string,
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${server.replace(/\/$/u, "")}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(30_000)
    });
  } catch (error) {
    throw new CliApiError("SERVER_UNREACHABLE", error instanceof Error ? error.message : "StructVibe server is unreachable.", 0);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new CliApiError(
      typeof payload.code === "string" ? payload.code : "REQUEST_FAILED",
      typeof payload.error === "string" ? payload.error : `Request failed with HTTP ${response.status}.`,
      response.status,
      payload
    );
  }
  return payload as T;
}

export type CliIdentityResponse = {
  ok: true;
  repositoryProfileVersion: number;
  token: { id: string; label: string; scopes: string[]; expiresAt: string | null };
  workspace: { id: string; name: string; slug: string };
  user: { id: string; email: string; name: string | null };
};

export type DeviceAuthorizationResponse = {
  ok: true;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type DeviceTokenResponse = {
  ok: true;
  repositoryProfileVersion: number;
  accessToken: string;
  tokenType: "Bearer";
  expiresAt: string;
  token: { id: string; label: string; scopes: string[] };
  workspace: { id: string; name: string; slug: string };
  user: { id: string; email: string; name: string | null };
};

export function startDeviceAuthorization(server: string, clientName: string) {
  return apiRequest<DeviceAuthorizationResponse>(server, "/api/cli/oauth/device", {
    method: "POST",
    body: JSON.stringify({ clientName })
  });
}

export function exchangeDeviceAuthorization(server: string, deviceCode: string) {
  return apiRequest<DeviceTokenResponse>(server, "/api/cli/oauth/token", {
    method: "POST",
    body: JSON.stringify({ deviceCode })
  });
}

export function fetchCliIdentity(server: string, token: string) {
  return apiRequest<CliIdentityResponse>(server, "/api/cli/auth/whoami", {}, token);
}

export function validateRepositoryProfile(repositoryProfileVersion: number) {
  if (repositoryProfileVersion !== REPOSITORY_PROFILE_VERSION) {
    throw new CliApiError(
      "REPOSITORY_PROFILE_MISMATCH",
      `Server repository profile ${repositoryProfileVersion} is incompatible with CLI profile ${REPOSITORY_PROFILE_VERSION}. Update the CLI before continuing.`,
      409
    );
  }
}

export function fetchSnapshot(credential: CliCredential, projectRef: string, branch: string) {
  return apiRequest<SnapshotResponse>(
    credential.server,
    `/api/cli/projects/${encodeURIComponent(projectRef)}/snapshot?branch=${encodeURIComponent(branch)}`,
    {},
    credential.token
  ).then((snapshot) => {
    validateRepositoryProfile(snapshot.repositoryProfileVersion);
    return snapshot;
  });
}
