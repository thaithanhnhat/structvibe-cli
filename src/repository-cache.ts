import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  checkoutCommitsPath,
  checkoutHeadPath,
  checkoutRefsPath
} from "./config";
import {
  listStoredObjectHashes,
  pruneStoredObjects,
  writeRepositoryObjects
} from "./files";
import type {
  CheckoutState,
  RepositoryPackCommit,
  RepositoryPackResponse
} from "./types";

export interface CheckoutRef {
  schemaVersion: 1;
  name: string;
  commitId: string;
  protected: boolean;
  upstream?: string | undefined;
}

const branchNamePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u;
const commitIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

export function assertBranchName(name: string) {
  if (
    !branchNamePattern.test(name) ||
    name.includes("..") ||
    name.includes("//") ||
    name.endsWith("/")
  ) {
    throw new Error(`Invalid StructVibe branch name '${name}'.`);
  }
  return name;
}

export function normalizeBranchRef(name: string) {
  const normalized = name.startsWith("remotes/origin/")
    ? name.slice("remotes/origin/".length)
    : name.startsWith("origin/")
      ? name.slice("origin/".length)
      : name;
  return assertBranchName(normalized);
}

function encodedBranchName(name: string) {
  return `${encodeURIComponent(assertBranchName(name))}.json`;
}

function localRefsPath(root: string) {
  return join(checkoutRefsPath(root), "heads");
}

function remoteRefsPath(root: string) {
  return join(checkoutRefsPath(root), "remotes", "origin");
}

function refPath(root: string, scope: "local" | "remote", name: string) {
  return join(scope === "local" ? localRefsPath(root) : remoteRefsPath(root), encodedBranchName(name));
}

function commitPath(root: string, commitId: string) {
  if (!commitIdPattern.test(commitId)) throw new Error(`Invalid StructVibe commit id '${commitId}'.`);
  return join(checkoutCommitsPath(root), `${commitId}.json`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writePrivate(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writePrivateJson(path: string, value: unknown) {
  await writePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

function validateRef(ref: CheckoutRef) {
  assertBranchName(ref.name);
  if (!commitIdPattern.test(ref.commitId)) throw new Error(`Invalid commit id in ref '${ref.name}'.`);
  return ref;
}

function validateCommit(commit: RepositoryPackCommit) {
  if (!commitIdPattern.test(commit.id)) throw new Error(`Invalid cached commit id '${commit.id}'.`);
  return commit;
}

export async function writeCommit(root: string, commit: RepositoryPackCommit) {
  await writePrivateJson(commitPath(root, commit.id), validateCommit(commit));
}

export async function readCommit(root: string, commitId: string) {
  const commit = await readJson<RepositoryPackCommit>(commitPath(root, commitId));
  return commit ? validateCommit(commit) : null;
}

export async function writeRef(root: string, scope: "local" | "remote", ref: CheckoutRef) {
  await writePrivateJson(refPath(root, scope, ref.name), validateRef(ref));
}

export function readRef(root: string, scope: "local" | "remote", name: string) {
  return readJson<CheckoutRef>(refPath(root, scope, name)).then((ref) => ref ? validateRef(ref) : null);
}

export async function listRefs(root: string, scope: "local" | "remote") {
  const directory = scope === "local" ? localRefsPath(root) : remoteRefsPath(root);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const refs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJson<CheckoutRef>(join(directory, entry.name)))
  );
  return refs.filter((ref): ref is CheckoutRef => Boolean(ref)).map(validateRef).sort((left, right) => left.name.localeCompare(right.name));
}

export async function removeRef(root: string, scope: "local" | "remote", name: string) {
  await rm(refPath(root, scope, name), { force: true });
}

export async function setHead(root: string, branch: string) {
  await writePrivate(checkoutHeadPath(root), `${assertBranchName(branch)}\n`);
}

export async function storeRepositoryPack(root: string, pack: RepositoryPackResponse) {
  const commitIds = new Set(pack.commits.map((commit) => commit.id));
  for (const branch of pack.branches) {
    assertBranchName(branch.name);
    if (!commitIds.has(branch.headCommitId)) {
      throw new Error(`Pack is missing head commit '${branch.headCommitId}' for '${branch.name}'.`);
    }
  }

  await writeRepositoryObjects(root, pack.objects);
  await Promise.all(pack.commits.map((commit) => writeCommit(root, commit)));
  await Promise.all(pack.branches.map((branch) => writeRef(root, "remote", {
      schemaVersion: 1,
      name: branch.name,
      commitId: branch.headCommitId,
      protected: branch.protected
    })));

  const expectedRefs = new Set(pack.branches.map((branch) => branch.name));
  const staleRefs = (await listRefs(root, "remote"))
    .filter((ref) => !expectedRefs.has(ref.name));
  await Promise.all(staleRefs.map((ref) => removeRef(root, "remote", ref.name)));
}

export async function trackRemoteBranch(root: string, name: string) {
  const remote = await readRef(root, "remote", name);
  if (!remote) return null;
  const local: CheckoutRef = {
    ...remote,
    upstream: `origin/${remote.name}`
  };
  await writeRef(root, "local", local);
  return local;
}

export async function updateTrackedBranch(
  root: string,
  name: string,
  commit: RepositoryPackCommit,
  protectedBranch: boolean
) {
  await writeCommit(root, commit);
  const remote: CheckoutRef = {
    schemaVersion: 1,
    name,
    commitId: commit.id,
    protected: protectedBranch
  };
  await writeRef(root, "remote", remote);
  await writeRef(root, "local", { ...remote, upstream: `origin/${name}` });
}

export async function ensureRepositoryCache(root: string, state: CheckoutState) {
  const local = await readRef(root, "local", state.branch);
  const remote = await readRef(root, "remote", state.branch);
  const commit = await readCommit(root, state.baseCommitId);
  if (!commit) {
    await writeCommit(root, {
      id: state.baseCommitId,
      contentHash: "",
      treeHash: null,
      tree: state.baseTree,
      message: "Imported legacy checkout",
      authorType: "system",
      authorId: "legacy-checkout",
      authorLabel: "StructVibe",
      createdAt: new Date(0).toISOString()
    });
  }
  const fallback: CheckoutRef = {
    schemaVersion: 1,
    name: state.branch,
    commitId: state.baseCommitId,
    protected: state.branch === "main"
  };
  if (!remote) await writeRef(root, "remote", fallback);
  if (!local) await writeRef(root, "local", { ...fallback, upstream: `origin/${state.branch}` });
  await setHead(root, state.branch);
}

export async function pruneRepositoryCache(root: string) {
  const refs = [...await listRefs(root, "local"), ...await listRefs(root, "remote")];
  const commitIds = [...new Set(refs.map((ref) => ref.commitId))];
  const commits = (await Promise.all(commitIds.map((id) => readCommit(root, id))))
    .filter((commit): commit is RepositoryPackCommit => Boolean(commit));
  await pruneStoredObjects(root, commits.map((commit) => commit.tree));

  let entries;
  try {
    entries = await readdir(checkoutCommitsPath(root), { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  const retained = new Set(commitIds.map((id) => `${id}.json`));
  await Promise.all(entries.map((entry) => retained.has(entry.name)
    ? Promise.resolve()
    : rm(join(checkoutCommitsPath(root), entry.name), { recursive: true, force: true })));
}

export { listStoredObjectHashes };
