import { rm, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import {
  hashRepositoryContent,
  isRepositoryPathAllowed,
  repositoryMediaType,
  type RepositoryChange,
  type RepositoryFile,
  type RepositoryTree
} from "./repository/index";
import { checkoutBasePath, checkoutDirectoryName } from "./config";

async function walk(root: string, directory: string, files: string[]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === checkoutDirectoryName || entry.name === ".git" || entry.name === ".DS_Store") continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) await walk(root, absolute, files);
    else if (entry.isFile()) files.push(relative(root, absolute).replaceAll("\\", "/"));
  }
}

export async function readWorkingFiles(root: string): Promise<RepositoryFile[]> {
  const paths: string[] = [];
  await walk(root, root, paths);
  const unsupported = paths.filter((path) => !isRepositoryPathAllowed(path));
  if (unsupported.length > 0) throw new Error(`Unsupported repository path(s): ${unsupported.join(", ")}`);
  return Promise.all(
    paths.sort().map(async (path) => ({
      path,
      content: await readFile(join(root, path), "utf8"),
      mediaType: repositoryMediaType(path)
    }))
  );
}

export async function writeWorkingFiles(root: string, files: readonly RepositoryFile[], clear = false) {
  if (clear) {
    const current = await readWorkingFiles(root);
    await Promise.all(current.map((file) => rm(join(root, file.path), { force: true })));
  }
  for (const file of files) {
    const absolute = join(root, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, "utf8");
  }
}

export async function writeBaseFiles(root: string, files: readonly RepositoryFile[]) {
  const base = checkoutBasePath(root);
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const absolute = join(base, file.path);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFile(absolute, file.content, { encoding: "utf8", mode: 0o600 });
  }
}

export async function readBaseFiles(root: string, tree: RepositoryTree): Promise<RepositoryFile[]> {
  return Promise.all(
    Object.keys(tree).sort().map(async (path) => ({
      path,
      content: await readFile(join(checkoutBasePath(root), path), "utf8"),
      mediaType: repositoryMediaType(path)
    }))
  );
}

export function changesBetween(base: readonly RepositoryFile[], working: readonly RepositoryFile[]): RepositoryChange[] {
  const baseByPath = new Map(base.map((file) => [file.path, file]));
  const workingByPath = new Map(working.map((file) => [file.path, file]));
  const paths = [...new Set([...baseByPath.keys(), ...workingByPath.keys()])].sort();
  const changes: RepositoryChange[] = [];
  for (const path of paths) {
    const before = baseByPath.get(path);
    const after = workingByPath.get(path);
    if (!after) changes.push({ path, content: null });
    else if (!before || hashRepositoryContent(before.content) !== hashRepositoryContent(after.content)) {
      changes.push({ path, content: after.content, mediaType: after.mediaType });
    }
  }
  return changes;
}

export function treeForFiles(files: readonly RepositoryFile[]): RepositoryTree {
  return Object.fromEntries(
    files
      .map((file) => [file.path, hashRepositoryContent(file.content)] as const)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function normalizeSelection(path: string) {
  const normalized = normalize(path).replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  if (
    !normalized ||
    isAbsolute(path) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === checkoutDirectoryName ||
    normalized.startsWith(`${checkoutDirectoryName}/`)
  ) {
    throw new Error(`Path '${path}' is outside the StructVibe working tree.`);
  }
  return normalized;
}

export async function restoreWorkingPaths(
  root: string,
  base: readonly RepositoryFile[],
  working: readonly RepositoryFile[],
  selections: readonly string[]
) {
  if (selections.length === 0) throw new Error("Choose a path to restore, or use '.' for all StructVibe files.");
  if (selections.includes(".")) {
    await writeWorkingFiles(root, base, true);
    return [...new Set([...base, ...working].map((file) => file.path))].sort();
  }

  const normalized = selections.map(normalizeSelection);
  const baseByPath = new Map(base.map((file) => [file.path, file]));
  const knownPaths = [...new Set([...base, ...working].map((file) => file.path))];
  const selectedPaths = knownPaths.filter((path) =>
    normalized.some((selection) => path === selection || path.startsWith(`${selection}/`))
  );
  if (selectedPaths.length === 0) throw new Error("No tracked StructVibe path matches the selection.");

  for (const path of selectedPaths) {
    const file = baseByPath.get(path);
    const absolute = join(root, path);
    if (!file) {
      await rm(absolute, { force: true });
      continue;
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, "utf8");
  }
  return selectedPaths.sort();
}
