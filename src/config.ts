import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CheckoutState, CliCredential, PendingCommit } from "./types";

const globalDirectory = join(homedir(), ".structvibe");
const credentialsPath = join(globalDirectory, "credentials.json");
export const checkoutDirectoryName = ".structvibe";

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readCredential(server?: string): Promise<CliCredential> {
  const credentials = (await readJson<{ activeServer?: string; servers?: Record<string, CliCredential> }>(credentialsPath)) ?? {};
  const selected = server?.replace(/\/$/u, "") ?? credentials.activeServer;
  const credential = selected ? credentials.servers?.[selected] : undefined;
  if (!credential) throw new Error("No CLI credential is configured. Run 'sv auth login' first.");
  return credential;
}

export async function saveCredential(credential: CliCredential) {
  const current = (await readJson<{ activeServer?: string; servers?: Record<string, CliCredential> }>(credentialsPath)) ?? {};
  await writePrivateJson(credentialsPath, {
    activeServer: credential.server,
    servers: { ...(current.servers ?? {}), [credential.server]: credential }
  });
}

export async function removeActiveCredential() {
  const current = await readJson<{ activeServer?: string; servers?: Record<string, CliCredential> }>(credentialsPath);
  if (!current?.activeServer) return false;
  const servers = { ...(current.servers ?? {}) };
  delete servers[current.activeServer];
  const activeServer = Object.keys(servers)[0];
  await writePrivateJson(credentialsPath, { ...(activeServer ? { activeServer } : {}), servers });
  return true;
}

export function checkoutMetadataPath(root: string) {
  return join(root, checkoutDirectoryName, "state.json");
}

export function checkoutBasePath(root: string) {
  return join(root, checkoutDirectoryName, "base");
}

export function checkoutObjectsPath(root: string) {
  return join(root, checkoutDirectoryName, "objects");
}

export function checkoutCommitsPath(root: string) {
  return join(root, checkoutDirectoryName, "commits");
}

export function checkoutRefsPath(root: string) {
  return join(root, checkoutDirectoryName, "refs");
}

export function checkoutHeadPath(root: string) {
  return join(root, checkoutDirectoryName, "HEAD");
}

export function pendingCommitPath(root: string) {
  return join(root, checkoutDirectoryName, "pending.json");
}

export async function findCheckoutRoot(start = process.cwd()): Promise<string> {
  let current = resolve(start);
  while (true) {
    if (await readJson<CheckoutState>(checkoutMetadataPath(current))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error("This directory is not a StructVibe checkout.");
    current = parent;
  }
}

export async function readCheckout(root: string) {
  const state = await readJson<CheckoutState>(checkoutMetadataPath(root));
  if (!state) throw new Error("StructVibe checkout metadata is missing.");
  return state;
}

export function saveCheckout(root: string, state: CheckoutState) {
  return writePrivateJson(checkoutMetadataPath(root), state);
}

export function readPendingCommit(root: string) {
  return readJson<PendingCommit>(pendingCommitPath(root));
}

export function savePendingCommit(root: string, pending: PendingCommit) {
  return writePrivateJson(pendingCommitPath(root), pending);
}
