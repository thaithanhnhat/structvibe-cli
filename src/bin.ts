import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { Command } from "commander";
import { createTwoFilesPatch } from "diff";
import { assertValidRepositoryFiles } from "./repository/index";
import { resolveCheckoutAsset } from "./assets";
import {
  apiRequest,
  CliApiError,
  exchangeDeviceAuthorization,
  fetchCliIdentity,
  fetchRepositoryPack,
  startDeviceAuthorization,
  validateRepositoryProfile,
  type CliIdentityResponse,
  type DeviceTokenResponse
} from "./api";
import {
  findCheckoutRoot,
  pendingCommitPath,
  readCheckout,
  readCredential,
  readPendingCommit,
  removeActiveCredential,
  saveCheckout,
  saveCredential,
  savePendingCommit
} from "./config";
import {
  changesBetween,
  readBaseFiles,
  readWorkingFiles,
  restoreWorkingPaths,
  writeBaseFiles,
  writeWorkingFiles
} from "./files";
import { print, printError } from "./output";
import { startPreviewServer } from "./preview";
import {
  ensureRepositoryCache,
  listRefs,
  listStoredObjectHashes,
  normalizeBranchRef,
  pruneRepositoryCache,
  readCommit,
  readRef,
  removeRef,
  setHead,
  storeRepositoryPack,
  trackRemoteBranch
} from "./repository-cache";
import type { CheckoutState, CliCredential, PendingCommit } from "./types";

declare const __STRUCTVIBE_CLI_VERSION__: string;

const program = new Command();
program
  .name("sv")
  .description("StructVibe repository CLI")
  .version(
    typeof __STRUCTVIBE_CLI_VERSION__ === "undefined"
      ? "development"
      : __STRUCTVIBE_CLI_VERSION__
  )
  .option("--json", "machine-readable output");
const jsonOutput = () => Boolean(program.opts().json);

async function ensureEmptyDirectory(path: string) {
  try {
    const entries = await readdir(path);
    if (entries.length > 0) throw new Error(`Destination '${path}' is not empty.`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") await mkdir(path, { recursive: true });
    else throw error;
  }
}

async function fetchAndStorePack(
  root: string,
  state: CheckoutState,
  credential: CliCredential
) {
  await ensureRepositoryCache(root, state);
  const have = await listStoredObjectHashes(root);
  const pack = await fetchRepositoryPack(credential, state.projectId, have);
  await storeRepositoryPack(root, pack);
  await pruneRepositoryCache(root);
  return pack;
}

async function cachedBranchCommit(root: string, branch: string) {
  const name = normalizeBranchRef(branch);
  const local = await readRef(root, "local", name) ?? await trackRemoteBranch(root, name);
  if (!local) return null;
  const commit = await readCommit(root, local.commitId);
  return commit ? { ref: local, commit } : null;
}

async function checkoutCachedBranch(root: string, state: CheckoutState, branch: string) {
  const name = normalizeBranchRef(branch);
  const cached = await cachedBranchCommit(root, name);
  if (!cached) throw new Error(`Branch '${name}' is not available locally. Run 'sv fetch' first.`);
  const files = await readBaseFiles(root, cached.commit.tree);
  await writeWorkingFiles(root, files, true);
  await writeBaseFiles(root, files);
  const next: CheckoutState = {
    ...state,
    branch: name,
    baseCommitId: cached.commit.id,
    baseTree: cached.commit.tree
  };
  await saveCheckout(root, next);
  await setHead(root, name);
  await rm(pendingCommitPath(root), { force: true });
  await pruneRepositoryCache(root);
  return next;
}

async function localChanges(root: string) {
  const state = await readCheckout(root);
  const [base, working] = await Promise.all([readBaseFiles(root, state.baseTree), readWorkingFiles(root)]);
  return { state, base, working, changes: changesBetween(base, working) };
}

function sleep(milliseconds: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function openBrowser(url: string) {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "rundll32", args: ["url.dll,FileProtocolHandler", url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

async function readTokenFromInput() {
  const environmentToken = process.env.STRUCTVIBE_TOKEN?.trim();
  if (environmentToken) return environmentToken;
  if (process.stdin.isTTY) {
    throw new Error("Pipe an access token to stdin or set STRUCTVIBE_TOKEN when using --with-token.");
  }
  let value = "";
  for await (const chunk of process.stdin) value += String(chunk);
  const token = value.trim();
  if (!token) throw new Error("The access token is empty.");
  return token;
}

async function storeAuthenticatedCredential(
  server: string,
  accessToken: string,
  identity: CliIdentityResponse | DeviceTokenResponse
) {
  validateRepositoryProfile(identity.repositoryProfileVersion);
  await saveCredential({
    server,
    token: accessToken,
    tokenId: identity.token.id,
    workspaceId: identity.workspace.id,
    workspaceName: identity.workspace.name,
    workspaceSlug: identity.workspace.slug,
    userEmail: identity.user.email
  });
}

const auth = program.command("auth").description("Manage CLI authentication");
auth
  .command("login")
  .option("--server <url>", "StructVibe server", "http://localhost:3000")
  .option("--name <name>", "credential label", `sv on ${hostname()}`)
  .option("--with-token", "read an access token from stdin or STRUCTVIBE_TOKEN")
  .option("--no-browser", "do not open the authorization page automatically")
  .action(async (options: { server: string; name: string; withToken?: boolean; browser: boolean }) => {
    const server = options.server.replace(/\/$/u, "");
    if (options.withToken) {
      const accessToken = await readTokenFromInput();
      const identity = await fetchCliIdentity(server, accessToken);
      await storeAuthenticatedCredential(server, accessToken, identity);
      print(
        jsonOutput()
          ? { ok: true, server, workspace: identity.workspace, user: identity.user, token: identity.token }
          : `Authenticated as ${identity.user.email} for ${identity.workspace.name}.`,
        jsonOutput()
      );
      return;
    }

    const authorization = await startDeviceAuthorization(server, options.name);
    if (jsonOutput()) {
      print({ ...authorization, status: "authorization_required" }, true);
    } else {
      print([
        "Authorize StructVibe CLI in your browser:",
        `  ${authorization.verificationUriComplete}`,
        `Code: ${authorization.userCode}`,
        "Waiting for authorization..."
      ].join("\n"));
    }
    if (options.browser) openBrowser(authorization.verificationUriComplete);

    const deadline = Date.now() + authorization.expiresIn * 1000;
    while (Date.now() < deadline) {
      try {
        const result = await exchangeDeviceAuthorization(server, authorization.deviceCode);
        await storeAuthenticatedCredential(server, result.accessToken, result);
        print(
          jsonOutput()
            ? { ok: true, status: "authenticated", server, workspace: result.workspace, user: result.user, token: result.token }
            : `Authenticated as ${result.user.email} for ${result.workspace.name}.`,
          jsonOutput()
        );
        return;
      } catch (error) {
        if (!(error instanceof CliApiError) || error.code !== "AUTHORIZATION_PENDING") throw error;
        await sleep(Math.max(1, authorization.interval) * 1000);
      }
    }
    throw new CliApiError("DEVICE_CODE_EXPIRED", "The browser authorization expired. Run 'sv auth login' again.", 401);
  });
auth.command("status").action(async () => {
  const credential = await readCredential();
  const identity = await fetchCliIdentity(credential.server, credential.token);
  validateRepositoryProfile(identity.repositoryProfileVersion);
  print(
    jsonOutput()
      ? { ok: true, server: credential.server, workspace: identity.workspace, user: identity.user, token: identity.token }
      : `Authenticated as ${identity.user.email} for ${identity.workspace.name} at ${credential.server}.`,
    jsonOutput()
  );
});
auth.command("logout").action(async () => {
  const removed = await removeActiveCredential();
  print(removed ? "CLI credential removed." : "No active CLI credential.", jsonOutput());
});

program
  .command("clone")
  .argument("<project>", "project UUID or slug")
  .argument("[directory]", "destination directory")
  .option("-b, --branch <branch>", "branch to clone", "main")
  .action(async (project: string, directory: string | undefined, options: { branch: string }) => {
    const credential = await readCredential();
    const pack = await fetchRepositoryPack(credential, project);
    const selectedName = normalizeBranchRef(options.branch);
    const selectedBranch = pack.branches.find((branch) => branch.name === selectedName);
    if (!selectedBranch) throw new Error(`Branch '${selectedName}' was not found in this project.`);
    const selectedCommit = pack.commits.find((commit) => commit.id === selectedBranch.headCommitId);
    if (!selectedCommit) throw new Error(`Clone pack is missing commit '${selectedBranch.headCommitId}'.`);
    const root = resolve(directory ?? pack.project.slug);
    await ensureEmptyDirectory(root);
    await storeRepositoryPack(root, pack);
    const tracked = await trackRemoteBranch(root, selectedBranch.name);
    if (!tracked) throw new Error(`Clone pack is missing branch '${selectedBranch.name}'.`);
    const files = await readBaseFiles(root, selectedCommit.tree);
    await writeWorkingFiles(root, files);
    await writeBaseFiles(root, files);
    const state: CheckoutState = {
      schemaVersion: 1,
      server: credential.server,
      projectId: pack.project.id,
      projectSlug: pack.project.slug,
      projectName: pack.project.name,
      branch: selectedBranch.name,
      baseCommitId: selectedCommit.id,
      baseTree: selectedCommit.tree
    };
    await saveCheckout(root, state);
    await setHead(root, selectedBranch.name);
    await pruneRepositoryCache(root);
    print(
      jsonOutput()
        ? { ok: true, directory: root, project: pack.project, branch: selectedBranch.name, commit: selectedCommit.id, branches: pack.branches.length, objects: pack.objectCount }
        : `Cloned ${pack.project.name}: ${pack.branches.length} branch(es), ${pack.objectCount} shared object(s). Checked out ${selectedBranch.name}.`,
      jsonOutput()
    );
  });

program.command("status").action(async () => {
  const root = await findCheckoutRoot();
  const { state, changes } = await localChanges(root);
  const pending = await readPendingCommit(root);
  const payload = { ok: true, project: state.projectName, branch: state.branch, baseCommitId: state.baseCommitId, pendingCommit: pending?.message ?? null, changes: changes.map((change) => ({ path: change.path, status: change.content === null ? "deleted" : state.baseTree[change.path] ? "modified" : "added" })) };
  if (jsonOutput()) print(payload, true);
  else if (payload.changes.length === 0) print(`On ${state.branch}. Working tree clean.${pending ? ` Pending commit: ${pending.message}` : ""}`);
  else print([`On ${state.branch}`, ...payload.changes.map((change) => `${change.status.padEnd(8)} ${change.path}`)].join("\n"));
});

program.command("check").alias("validate").description("Validate StructVibe repository files").action(async () => {
  const root = await findCheckoutRoot();
  const result = assertValidRepositoryFiles(await readWorkingFiles(root));
  print(
    jsonOutput()
      ? result
      : [
          `Repository is valid: ${result.fileCount} files, ${result.byteSize} bytes.`,
          ...result.warnings.map((warning) =>
            `warning  ${warning.code}${warning.path ? `  ${warning.path}` : ""}\n         ${warning.message}`
          )
        ].join("\n"),
    jsonOutput()
  );
});

program.command("diff").action(async () => {
  const root = await findCheckoutRoot();
  const { base, working, changes } = await localChanges(root);
  if (jsonOutput()) {
    print({ ok: true, changes }, true);
    return;
  }
  const baseByPath = new Map(base.map((file) => [file.path, file.content]));
  const workingByPath = new Map(working.map((file) => [file.path, file.content]));
  const patches = changes.map((change) => createTwoFilesPatch(
    `a/${change.path}`,
    `b/${change.path}`,
    baseByPath.get(change.path) ?? "",
    workingByPath.get(change.path) ?? "",
    "base",
    "working"
  ));
  print(patches.length > 0 ? patches.join("\n") : "Working tree clean.");
});

program
  .command("restore")
  .description("Restore StructVibe files from the current branch snapshot")
  .argument("<paths...>", "tracked path, directory, or '.'")
  .action(async (paths: string[]) => {
    const root = await findCheckoutRoot();
    const { state, base, working } = await localChanges(root);
    const restored = await restoreWorkingPaths(root, base, working, paths);
    const pending = await readPendingCommit(root);
    const payload = { ok: true, branch: state.branch, restored, pendingCommit: pending?.message ?? null };
    print(
      jsonOutput()
        ? payload
        : `Restored ${restored.length} path(s) from ${state.branch}.${pending ? " The pending commit was not changed." : ""}`,
      jsonOutput()
    );
  });

program
  .command("commit")
  .requiredOption("-m, --message <message>", "commit message")
  .action(async (options: { message: string }) => {
    const root = await findCheckoutRoot();
    const { state, working, changes } = await localChanges(root);
    assertValidRepositoryFiles(working);
    if (changes.length === 0) throw new Error("Nothing to commit.");
    const pending: PendingCommit = { schemaVersion: 1, baseCommitId: state.baseCommitId, message: options.message, changes, createdAt: new Date().toISOString() };
    await savePendingCommit(root, pending);
    print(jsonOutput() ? { ok: true, pending } : `Prepared commit '${options.message}' with ${changes.length} changed path(s).`, jsonOutput());
  });

program.command("push").action(async () => {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const pending = await readPendingCommit(root);
  if (!pending) throw new Error("No pending commit. Run 'sv commit -m <message>' first.");
  if (pending.baseCommitId !== state.baseCommitId) throw new Error("Pending commit belongs to an older checkout. Commit again after pulling.");
  const credential = await readCredential(state.server);
  const result = await apiRequest<{ ok: true; branch: { name: string }; commit: { id: string }; tree: CheckoutState["baseTree"]; validation: unknown; deduplicated: boolean }>(
    state.server,
    `/api/cli/projects/${encodeURIComponent(state.projectId)}/push`,
    { method: "POST", body: JSON.stringify({ branch: state.branch, baseCommitId: state.baseCommitId, message: pending.message, changes: pending.changes }) },
    credential.token
  );
  const working = await readWorkingFiles(root);
  const pushedFiles = new Map((await readBaseFiles(root, state.baseTree)).map((file) => [file.path, file]));
  for (const change of pending.changes) {
    if (change.content === null) pushedFiles.delete(change.path);
    else pushedFiles.set(change.path, { path: change.path, content: change.content, mediaType: change.mediaType });
  }
  await writeBaseFiles(root, [...pushedFiles.values()]);
  const nextState = { ...state, baseCommitId: result.commit.id, baseTree: result.tree };
  await saveCheckout(root, nextState);
  await rm(pendingCommitPath(root), { force: true });
  const pack = await fetchAndStorePack(root, nextState, credential);
  const remote = pack.branches.find((branch) => branch.name === state.branch);
  if (!remote || remote.headCommitId !== result.commit.id) {
    throw new Error("Push succeeded, but the refreshed branch ref did not match the new commit.");
  }
  await trackRemoteBranch(root, state.branch);
  await setHead(root, state.branch);
  await pruneRepositoryCache(root);
  const remaining = changesBetween([...pushedFiles.values()], working);
  print(jsonOutput() ? { ...result, remainingChanges: remaining } : `Pushed ${pending.changes.length} path(s) to ${state.branch} at ${result.commit.id.slice(0, 8)}.${remaining.length ? ` ${remaining.length} newer local change(s) remain.` : ""}`, jsonOutput());
});

program.command("fetch").description("Fetch all remote branch heads and missing objects").action(async () => {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const credential = await readCredential(state.server);
  const pack = await fetchAndStorePack(root, state, credential);
  const cachedObjects = await listStoredObjectHashes(root);
  print(
    jsonOutput()
      ? { ok: true, branches: pack.branches, transferredObjectCount: pack.transferredObjectCount, objectCount: pack.objectCount }
      : `Fetched ${pack.branches.length} branch(es); received ${pack.transferredObjectCount} of ${pack.objectCount} object(s). Local cache has ${cachedObjects.length} object(s).`,
    jsonOutput()
  );
});

program
  .command("pull")
  .option("-f, --force", "discard local changes")
  .action(async (options: { force?: boolean }) => {
    const root = await findCheckoutRoot();
    const current = await localChanges(root);
    if ((current.changes.length > 0 || (await readPendingCommit(root))) && !options.force) {
      throw new Error("Working tree or pending commit is not clean. Commit, push, or use --force.");
    }
    const credential = await readCredential(current.state.server);
    await fetchAndStorePack(root, current.state, credential);
    const remote = await readRef(root, "remote", current.state.branch);
    if (!remote) throw new Error(`Remote branch 'origin/${current.state.branch}' no longer exists.`);
    await trackRemoteBranch(root, current.state.branch);
    const state = await checkoutCachedBranch(root, current.state, current.state.branch);
    print(jsonOutput() ? { ok: true, commit: state.baseCommitId, branch: state.branch } : `Pulled ${state.branch} at ${state.baseCommitId.slice(0, 8)}.`, jsonOutput());
  });

async function listBranches(options: { all?: boolean; remotes?: boolean } = {}) {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  await ensureRepositoryCache(root, state);
  const [local, remote] = await Promise.all([listRefs(root, "local"), listRefs(root, "remote")]);
  const rows = options.remotes
    ? remote.map((ref) => ({ scope: "remote" as const, ref }))
    : options.all
      ? [
          ...local.map((ref) => ({ scope: "local" as const, ref })),
          ...remote.map((ref) => ({ scope: "remote" as const, ref }))
        ]
      : local.map((ref) => ({ scope: "local" as const, ref }));
  print(
    jsonOutput()
      ? { ok: true, current: state.branch, local, remote }
      : rows.map(({ scope, ref }) => {
          const name = scope === "remote" ? `remotes/origin/${ref.name}` : ref.name;
          const tracking = scope === "local" && ref.upstream ? `  [${ref.upstream}]` : "";
          return `${scope === "local" && ref.name === state.branch ? "*" : " "} ${name.padEnd(42)} ${ref.commitId.slice(0, 8)}${tracking}`;
        }).join("\n") || "No branches.",
    jsonOutput()
  );
}

async function createBranch(name: string, from?: string) {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const credential = await readCredential(state.server);
  const branchName = normalizeBranchRef(name);
  const fromBranch = normalizeBranchRef(from ?? state.branch);
  const result = await apiRequest<{ ok: true; branch: { name: string } }>(state.server, `/api/cli/projects/${encodeURIComponent(state.projectId)}/branches`, { method: "POST", body: JSON.stringify({ name: branchName, fromBranch }) }, credential.token);
  await fetchAndStorePack(root, state, credential);
  await trackRemoteBranch(root, result.branch.name);
  await pruneRepositoryCache(root);
  print(jsonOutput() ? result : `Created branch ${result.branch.name}.`, jsonOutput());
}

async function deleteBranch(name: string, force: boolean) {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const branchName = normalizeBranchRef(name);
  if (state.branch === branchName) throw new Error("Switch to another branch before deleting the current branch.");
  const credential = await readCredential(state.server);
  const query = new URLSearchParams({ name: branchName, force: String(force) });
  const result = await apiRequest<{
    ok: true;
    branch: { name: string };
    recoverableUntil: string;
  }>(
    state.server,
    `/api/cli/projects/${encodeURIComponent(state.projectId)}/branches?${query}`,
    { method: "DELETE" },
    credential.token
  );
  await removeRef(root, "local", branchName);
  await fetchAndStorePack(root, state, credential);
  await pruneRepositoryCache(root);
  print(
    jsonOutput()
      ? result
      : `Deleted branch ${result.branch.name}. Recover it before ${new Date(result.recoverableUntil).toLocaleDateString()}.`,
    jsonOutput()
  );
}

async function restoreBranch(name: string) {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const branchName = normalizeBranchRef(name);
  const credential = await readCredential(state.server);
  const result = await apiRequest<{ ok: true; branch: { name: string } }>(
    state.server,
    `/api/cli/projects/${encodeURIComponent(state.projectId)}/branches`,
    { method: "PATCH", body: JSON.stringify({ name: branchName, action: "restore" }) },
    credential.token
  );
  await fetchAndStorePack(root, state, credential);
  print(jsonOutput() ? result : `Recovered branch ${result.branch.name}.`, jsonOutput());
}

async function switchBranch(
  name: string,
  options: { create?: boolean; force?: boolean; from?: string | undefined }
) {
  const branchName = normalizeBranchRef(name);
  const root = await findCheckoutRoot();
  const current = await localChanges(root);
  if ((current.changes.length > 0 || (await readPendingCommit(root))) && !options.force) {
    throw new Error("Working tree is not clean. Commit, push, or use --force to discard local changes.");
  }
  await ensureRepositoryCache(root, current.state);
  const credential = await readCredential(current.state.server);
  if (options.create) {
    await apiRequest(
      current.state.server,
      `/api/cli/projects/${encodeURIComponent(current.state.projectId)}/branches`,
      {
        method: "POST",
        body: JSON.stringify({
          name: branchName,
          fromBranch: normalizeBranchRef(options.from ?? current.state.branch)
        })
      },
      credential.token
    );
    await fetchAndStorePack(root, current.state, credential);
  }

  let cached = await cachedBranchCommit(root, branchName);
  if (!cached) {
    await fetchAndStorePack(root, current.state, credential);
    cached = await cachedBranchCommit(root, branchName);
  }
  if (!cached) throw new Error(`Branch '${branchName}' was not found locally or on origin.`);
  const state = await checkoutCachedBranch(root, current.state, branchName);
  print(
    jsonOutput()
      ? { ok: true, branch: state.branch, commit: state.baseCommitId, created: Boolean(options.create) }
      : `${options.create ? "Created and switched" : "Switched"} to ${state.branch}.`,
    jsonOutput()
  );
}

const branch = program
  .command("branch")
  .description("List, create, delete, or recover branches")
  .argument("[name]", "create a branch without switching")
  .option("-a, --all", "show local and remote refs")
  .option("-r, --remotes", "show remote refs only")
  .option("-d, --delete <branch>", "delete a merged branch")
  .option("-D, --force-delete <branch>", "delete an unmerged branch")
  .option("--restore <branch>", "recover a recently deleted branch")
  .action(async (name: string | undefined, options: { all?: boolean; remotes?: boolean; delete?: string; forceDelete?: string; restore?: string }) => {
    const operations = [options.delete, options.forceDelete, options.restore].filter(Boolean);
    if (operations.length + (name ? 1 : 0) > 1) throw new Error("Choose only one branch operation.");
    if (options.delete) await deleteBranch(options.delete, false);
    else if (options.forceDelete) await deleteBranch(options.forceDelete, true);
    else if (options.restore) await restoreBranch(options.restore);
    else if (name) await createBranch(name);
    else await listBranches(options);
  });
branch.command("list").description("List branches")
  .option("-a, --all", "show local and remote refs")
  .option("-r, --remotes", "show remote refs only")
  .action(listBranches);
branch
  .command("create")
  .description("Create a branch without switching")
  .argument("<name>")
  .option("--from <branch>")
  .action(async (name: string, options: { from?: string }) => createBranch(name, options.from));

program.command("switch").description("Switch branches")
  .argument("[start-point]", "branch to switch to, or source branch with -c")
  .option("-c, --create <branch>", "create a branch and switch to it")
  .option("-f, --force", "discard local changes")
  .action(async (startPoint: string | undefined, options: { create?: string; force?: boolean }) => {
    const target = options.create ?? startPoint;
    if (!target) throw new Error("Choose a branch, or use 'sv switch -c <branch>'.");
    await switchBranch(target, {
      create: Boolean(options.create),
      ...(options.force !== undefined ? { force: options.force } : {}),
      ...(options.create && startPoint !== undefined ? { from: startPoint } : {})
    });
  });

program.command("checkout").description("Switch branches using familiar Git-style syntax")
  .argument("[start-point]", "branch to switch to, or source branch with -b")
  .option("-b, --create <branch>", "create a branch and switch to it")
  .option("-f, --force", "discard local changes")
  .action(async (startPoint: string | undefined, options: { create?: string; force?: boolean }) => {
    if (options.create) {
      await switchBranch(options.create, {
        create: true,
        ...(options.force !== undefined ? { force: options.force } : {}),
        ...(startPoint !== undefined ? { from: startPoint } : {})
      });
      return;
    }
    if (!startPoint) throw new Error("Choose a branch, or use 'sv checkout -b <branch>'.");
    await switchBranch(startPoint, options.force !== undefined ? { force: options.force } : {});
  });

program
  .command("log")
  .description("Show branch history")
  .option("-n, --max-count <count>", "number of commits", "20")
  .action(async (options: { maxCount: string }) => {
    const root = await findCheckoutRoot();
    const state = await readCheckout(root);
    const credential = await readCredential(state.server);
    const limit = Number.parseInt(options.maxCount, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--max-count must be between 1 and 100.");
    const query = new URLSearchParams({ branch: state.branch, limit: String(limit) });
    const response = await apiRequest<{
      ok: true;
      branch: string;
      commits: Array<{
        id: string;
        message: string;
        authorLabel: string;
        createdAt: string;
        parentIds: string[];
      }>;
    }>(
      state.server,
      `/api/cli/projects/${encodeURIComponent(state.projectId)}/history?${query}`,
      {},
      credential.token
    );
    print(
      jsonOutput()
        ? response
        : response.commits.map((commit) => [
            `${commit.id.slice(0, 8)}  ${commit.message}`,
            `          ${commit.authorLabel} · ${new Date(commit.createdAt).toLocaleString()}${commit.parentIds.length > 1 ? " · merge" : ""}`
          ].join("\n")).join("\n\n") || "No commits.",
      jsonOutput()
    );
  });

program
  .command("show")
  .description("Show a commit summary")
  .argument("[commit]", "commit UUID, UUID prefix, or content hash prefix")
  .action(async (commitRef?: string) => {
    const root = await findCheckoutRoot();
    const state = await readCheckout(root);
    const credential = await readCredential(state.server);
    const response = await apiRequest<{
      ok: true;
      commit: { id: string; message: string; authorLabel: string; createdAt: string };
      parentIds: string[];
      changes: Array<{ path: string; status: string }>;
    }>(
      state.server,
      `/api/cli/projects/${encodeURIComponent(state.projectId)}/commits/${encodeURIComponent(commitRef ?? state.baseCommitId)}`,
      {},
      credential.token
    );
    print(
      jsonOutput()
        ? response
        : [
            `commit ${response.commit.id}`,
            `Author: ${response.commit.authorLabel}`,
            `Date:   ${new Date(response.commit.createdAt).toLocaleString()}`,
            response.parentIds.length > 1 ? `Merge:  ${response.parentIds.map((id) => id.slice(0, 8)).join(" ")}` : "",
            "",
            `    ${response.commit.message}`,
            "",
            ...response.changes.map((change) => `${change.status.padEnd(8)} ${change.path}`)
          ].filter((line) => line !== "").join("\n"),
      jsonOutput()
    );
  });

program
  .command("preview")
  .description("Preview local web source with live reload")
  .argument("[screen]", "screen code to open")
  .option("-p, --port <port>", "local preview port", "4173")
  .option("--host <host>", "listen address", "127.0.0.1")
  .option("--no-open", "do not open the browser automatically")
  .action(async (screen: string | undefined, options: { port: string; host: string; open: boolean }) => {
    const root = await findCheckoutRoot();
    const state = await readCheckout(root);
    const port = Number.parseInt(options.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port must be between 0 and 65535.");
    let assetCredential: Promise<CliCredential> | null = null;
    const preview = await startPreviewServer({
      root,
      projectName: state.projectName,
      branch: state.branch,
      screen,
      host: options.host,
      port,
      resolveAsset: async (contentHash) => {
        assetCredential ??= readCredential(state.server);
        return resolveCheckoutAsset(
          root,
          state,
          await assetCredential,
          contentHash
        );
      }
    });
    print(
      jsonOutput()
        ? { ok: true, url: preview.url, host: preview.host, port: preview.port, branch: state.branch, screen: screen ?? null }
        : [`StructVibe preview: ${preview.url}`, "Watching local HTML, CSS, SVG, and screen links. Press Ctrl+C to stop."].join("\n"),
      jsonOutput()
    );
    if (options.open) openBrowser(preview.url);
    await new Promise<void>((resolvePromise, reject) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        preview.close().then(resolvePromise, reject);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  });

async function listTasks() {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const credential = await readCredential(state.server);
  const response = await apiRequest<{ ok: true; tasks: Array<{ id: string; status: string; title: string }> }>(state.server, `/api/cli/projects/${encodeURIComponent(state.projectId)}/tasks`, {}, credential.token);
  print(jsonOutput() ? response : response.tasks.map((item) => `${item.id.slice(0, 8)}  ${item.status.padEnd(12)} ${item.title}`).join("\n") || "No tasks.", jsonOutput());
}

async function addTask(title: string, options: { body?: string; screen?: string; feature?: string; priority?: string }) {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const credential = await readCredential(state.server);
  const response = await apiRequest<{ ok: true; task: { id: string; title: string } }>(state.server, `/api/cli/projects/${encodeURIComponent(state.projectId)}/tasks`, { method: "POST", body: JSON.stringify({ title, body: options.body, screenCode: options.screen, featureCode: options.feature, branchName: state.branch, priority: options.priority ? Number(options.priority) : undefined }) }, credential.token);
  print(jsonOutput() ? response : `Created task ${response.task.id.slice(0, 8)}: ${response.task.title}`, jsonOutput());
}

const task = program.command("task").description("List or add project tasks").action(listTasks);
task.command("list").description("List tasks").action(listTasks);
task.command("add").description("Add a task").argument("<title>").option("--body <body>").option("--screen <code>").option("--feature <code>").option("--priority <number>").action(addTask);
task.command("create").description("Compatibility alias for task add").requiredOption("--title <title>").option("--body <body>").option("--screen <code>").option("--feature <code>").option("--priority <number>").action(async (options: { title: string; body?: string; screen?: string; feature?: string; priority?: string }) => addTask(options.title, options));

type MergeRequestSummary = {
  id: string;
  status: string;
  title: string;
  sourceBranch: { name: string } | null;
  targetBranch: { name: string } | null;
};

async function listMergeRequests() {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const credential = await readCredential(state.server);
  const response = await apiRequest<{
    ok: true;
    mergeRequests: MergeRequestSummary[];
  }>(state.server, `/api/cli/projects/${encodeURIComponent(state.projectId)}/merge-requests`, {}, credential.token);
  print(
    jsonOutput()
      ? response
      : response.mergeRequests.map((item) => `${item.id.slice(0, 8)}  ${item.status.padEnd(10)} ${item.sourceBranch?.name ?? "?"} -> ${item.targetBranch?.name ?? "?"}  ${item.title}`).join("\n") || "No merge requests.",
    jsonOutput()
  );
}

async function createMergeRequest(
  titleArgument: string | undefined,
  options: { title?: string; body?: string; target: string }
) {
    const root = await findCheckoutRoot();
    const { state, changes } = await localChanges(root);
    if (changes.length > 0 || (await readPendingCommit(root))) {
      throw new Error("Push or discard local work before creating a merge request.");
    }
    const credential = await readCredential(state.server);
    let title = titleArgument ?? options.title;
    if (!title) {
      const history = await apiRequest<{ ok: true; commits: Array<{ message: string }> }>(
        state.server,
        `/api/cli/projects/${encodeURIComponent(state.projectId)}/history?${new URLSearchParams({ branch: state.branch, limit: "1" })}`,
        {},
        credential.token
      );
      title = history.commits[0]?.message;
    }
    if (!title) throw new Error("Merge request title is required.");
    const response = await apiRequest<{
      ok: true;
      request: { id: string; title: string };
      sourceBranch: { name: string };
      targetBranch: { name: string };
      deduplicated: boolean;
    }>(
      state.server,
      `/api/cli/projects/${encodeURIComponent(state.projectId)}/merge-requests`,
      {
        method: "POST",
        body: JSON.stringify({
          sourceBranch: state.branch,
          targetBranch: options.target,
          title,
          body: options.body
        })
      },
      credential.token
    );
    print(
      jsonOutput()
        ? response
        : `${response.deduplicated ? "Reused" : "Created"} merge request ${response.request.id.slice(0, 8)}: ${response.sourceBranch.name} -> ${response.targetBranch.name}.`,
      jsonOutput()
    );
}

async function mergeRequestAction(id: string, action: "merge" | "close") {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const credential = await readCredential(state.server);
  const response = await apiRequest<{
    ok: true;
    request: { id: string; title: string; status: string };
    commitId?: string | null;
  }>(
    state.server,
    `/api/cli/projects/${encodeURIComponent(state.projectId)}/merge-requests/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ action }) },
    credential.token
  );
  print(
    jsonOutput()
      ? response
      : `${action === "merge" ? "Merged" : "Closed"} merge request ${response.request.id.slice(0, 8)}: ${response.request.title}`,
    jsonOutput()
  );
}

const mergeRequest = program.command("mr").alias("merge-request").description("List and manage merge requests").action(listMergeRequests);
mergeRequest.command("list").description("List merge requests").action(listMergeRequests);
mergeRequest
  .command("create")
  .description("Create a merge request from the current branch")
  .argument("[title]", "review title; defaults to the latest commit message")
  .option("--title <title>", "compatibility title option")
  .option("-b, --body <body>", "review notes")
  .option("-t, --target <branch>", "target branch", "main")
  .action(createMergeRequest);
mergeRequest.command("view").argument("<id>").action(async (id: string) => {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const credential = await readCredential(state.server);
  const response = await apiRequest<{ ok: true; mergeRequest: MergeRequestSummary & { body: string | null; conflictPaths: string[] } }>(
    state.server,
    `/api/cli/projects/${encodeURIComponent(state.projectId)}/merge-requests/${encodeURIComponent(id)}`,
    {},
    credential.token
  );
  const item = response.mergeRequest;
  print(
    jsonOutput()
      ? response
      : [
          `${item.id}  ${item.status}`,
          `${item.sourceBranch?.name ?? "?"} -> ${item.targetBranch?.name ?? "?"}`,
          item.title,
          item.body ?? "",
          item.conflictPaths.length > 0 ? `Conflicts: ${item.conflictPaths.join(", ")}` : ""
        ].filter(Boolean).join("\n"),
    jsonOutput()
  );
});
mergeRequest.command("merge").argument("<id>").action(async (id: string) => mergeRequestAction(id, "merge"));
mergeRequest.command("close").argument("<id>").action(async (id: string) => mergeRequestAction(id, "close"));

program.parseAsync().catch((error) => {
  printError(error, jsonOutput());
  process.exitCode = 1;
});
