import { spawn } from "node:child_process";
import { access, mkdir, readdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { createTwoFilesPatch } from "diff";
import { assertValidRepositoryFiles } from "./repository/index";
import {
  apiRequest,
  CliApiError,
  exchangeDeviceAuthorization,
  fetchCliIdentity,
  fetchSnapshot,
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
import type { CheckoutState, CliCredential, PendingCommit, SnapshotResponse } from "./types";

const program = new Command();
program.name("sv").description("StructVibe repository CLI").version("0.1.0").option("--json", "machine-readable output");
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

async function checkoutSnapshot(root: string, credential: CliCredential, snapshot: SnapshotResponse) {
  await writeWorkingFiles(root, snapshot.files, true);
  await writeBaseFiles(root, snapshot.files);
  const state: CheckoutState = {
    schemaVersion: 1,
    server: credential.server,
    projectId: snapshot.project.id,
    projectSlug: snapshot.project.slug,
    projectName: snapshot.project.name,
    branch: snapshot.branch.name,
    baseCommitId: snapshot.commit.id,
    baseTree: snapshot.commit.tree
  };
  await saveCheckout(root, state);
  await rm(pendingCommitPath(root), { force: true });
  return state;
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
    const snapshot = await fetchSnapshot(credential, project, options.branch);
    const root = resolve(directory ?? snapshot.project.slug);
    await ensureEmptyDirectory(root);
    await writeWorkingFiles(root, snapshot.files);
    await writeBaseFiles(root, snapshot.files);
    await saveCheckout(root, {
      schemaVersion: 1,
      server: credential.server,
      projectId: snapshot.project.id,
      projectSlug: snapshot.project.slug,
      projectName: snapshot.project.name,
      branch: snapshot.branch.name,
      baseCommitId: snapshot.commit.id,
      baseTree: snapshot.commit.tree
    });
    print(jsonOutput() ? { ok: true, directory: root, project: snapshot.project, branch: snapshot.branch.name, commit: snapshot.commit.id } : `Cloned ${snapshot.project.name} (${snapshot.branch.name}) into ${root}.`, jsonOutput());
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
  print(jsonOutput() ? result : `Repository is valid: ${result.fileCount} files, ${result.byteSize} bytes.`, jsonOutput());
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
  await saveCheckout(root, { ...state, baseCommitId: result.commit.id, baseTree: result.tree });
  await rm(pendingCommitPath(root), { force: true });
  const remaining = changesBetween([...pushedFiles.values()], working);
  print(jsonOutput() ? { ...result, remainingChanges: remaining } : `Pushed ${pending.changes.length} path(s) to ${state.branch} at ${result.commit.id.slice(0, 8)}.${remaining.length ? ` ${remaining.length} newer local change(s) remain.` : ""}`, jsonOutput());
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
    const snapshot = await fetchSnapshot(credential, current.state.projectId, current.state.branch);
    const state = await checkoutSnapshot(root, credential, snapshot);
    print(jsonOutput() ? { ok: true, commit: state.baseCommitId, branch: state.branch } : `Pulled ${state.branch} at ${state.baseCommitId.slice(0, 8)}.`, jsonOutput());
  });

async function listBranches() {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const credential = await readCredential(state.server);
  const response = await apiRequest<{
    ok: true;
    branches: Array<{
      branch: { name: string };
      commit: { id: string };
      ahead: number;
      behind: number;
      mergedIntoMain: boolean;
    }>;
  }>(state.server, `/api/cli/projects/${encodeURIComponent(state.projectId)}/branches`, {}, credential.token);
  print(
    jsonOutput()
      ? response
      : response.branches.map(({ branch: item, commit, ahead, behind, mergedIntoMain }) => {
          const relation = item.name === "main"
            ? ""
            : `  +${ahead}/-${behind}${mergedIntoMain ? "  merged" : ""}`;
          return `${item.name === state.branch ? "*" : " "} ${item.name.padEnd(28)} ${commit.id.slice(0, 8)}${relation}`;
        }).join("\n"),
    jsonOutput()
  );
}

async function createBranch(name: string, from?: string) {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const credential = await readCredential(state.server);
  const result = await apiRequest<{ ok: true; branch: { name: string } }>(state.server, `/api/cli/projects/${encodeURIComponent(state.projectId)}/branches`, { method: "POST", body: JSON.stringify({ name, fromBranch: from ?? state.branch }) }, credential.token);
  print(jsonOutput() ? result : `Created branch ${result.branch.name}.`, jsonOutput());
}

async function deleteBranch(name: string, force: boolean) {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  if (state.branch === name) throw new Error("Switch to another branch before deleting the current branch.");
  const credential = await readCredential(state.server);
  const query = new URLSearchParams({ name, force: String(force) });
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
  const credential = await readCredential(state.server);
  const result = await apiRequest<{ ok: true; branch: { name: string } }>(
    state.server,
    `/api/cli/projects/${encodeURIComponent(state.projectId)}/branches`,
    { method: "PATCH", body: JSON.stringify({ name, action: "restore" }) },
    credential.token
  );
  print(jsonOutput() ? result : `Recovered branch ${result.branch.name}.`, jsonOutput());
}

const branch = program
  .command("branch")
  .description("List, create, delete, or recover branches")
  .option("-d, --delete <branch>", "delete a merged branch")
  .option("-D, --force-delete <branch>", "delete an unmerged branch")
  .option("--restore <branch>", "recover a recently deleted branch")
  .action(async (options: { delete?: string; forceDelete?: string; restore?: string }) => {
    const operations = [options.delete, options.forceDelete, options.restore].filter(Boolean);
    if (operations.length > 1) throw new Error("Choose only one branch operation.");
    if (options.delete) await deleteBranch(options.delete, false);
    else if (options.forceDelete) await deleteBranch(options.forceDelete, true);
    else if (options.restore) await restoreBranch(options.restore);
    else await listBranches();
  });
branch.command("list").description("List branches").action(listBranches);
branch
  .command("create")
  .description("Create a branch without switching")
  .argument("<name>")
  .option("--from <branch>")
  .action(async (name: string, options: { from?: string }) => createBranch(name, options.from));

program.command("switch").alias("checkout").description("Switch branches")
  .argument("<branch>")
  .option("-c, --create", "create the branch before switching")
  .option("-f, --force", "discard local changes")
  .action(async (name: string, options: { create?: boolean; force?: boolean }) => {
  const root = await findCheckoutRoot();
  const current = await localChanges(root);
  if ((current.changes.length > 0 || (await readPendingCommit(root))) && !options.force) throw new Error("Working tree is not clean. Use --force to discard local changes.");
  const credential = await readCredential(current.state.server);
  if (options.create) {
    await apiRequest(
      current.state.server,
      `/api/cli/projects/${encodeURIComponent(current.state.projectId)}/branches`,
      { method: "POST", body: JSON.stringify({ name, fromBranch: current.state.branch }) },
      credential.token
    );
  }
  const snapshot = await fetchSnapshot(credential, current.state.projectId, name);
  const state = await checkoutSnapshot(root, credential, snapshot);
  print(jsonOutput() ? { ok: true, branch: state.branch, commit: state.baseCommitId } : `Switched to ${state.branch}.`, jsonOutput());
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

program.command("preview").argument("<screen>").action(async (screen: string) => {
  const root = await findCheckoutRoot();
  const state = await readCheckout(root);
  const path = join(root, "design", "screens", screen, "screen.html");
  await access(path);
  print(jsonOutput() ? { ok: true, screen, path, url: pathToFileURL(path).toString(), branch: state.branch } : pathToFileURL(path).toString(), jsonOutput());
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
