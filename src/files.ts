import type { Dirent } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants as zlibConstants } from "node:zlib";
import {
  hashRepositoryContent,
  isRepositoryPathAllowed,
  repositoryMediaType,
  type RepositoryChange,
  type RepositoryFile,
  type RepositoryTree
} from "./repository/index";
import { checkoutBasePath, checkoutDirectoryName, checkoutObjectsPath } from "./config";

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);
const objectHashPattern = /^[a-f0-9]{64}$/u;

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

function objectPath(root: string, hash: string) {
  if (!objectHashPattern.test(hash)) throw new Error(`Invalid StructVibe object hash '${hash}'.`);
  return join(checkoutObjectsPath(root), hash.slice(0, 2), `${hash.slice(2)}.br`);
}

async function readObject(root: string, hash: string) {
  const compressed = await readFile(objectPath(root, hash));
  let content: string;
  try {
    content = (await decompress(compressed)).toString("utf8");
  } catch {
    throw new Error(`StructVibe object '${hash}' is corrupt and cannot be decompressed.`);
  }
  if (hashRepositoryContent(content) !== hash) {
    throw new Error(`StructVibe object '${hash}' failed its content hash check.`);
  }
  return content;
}

async function writeObject(root: string, content: string) {
  const hash = hashRepositoryContent(content);
  const absolute = objectPath(root, hash);
  try {
    await readObject(root, hash);
    return hash;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      await rm(absolute, { force: true });
    }
  }

  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  try {
    const compressed = await compress(Buffer.from(content, "utf8"), {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5
      }
    });
    await writeFile(temporary, compressed, { mode: 0o600 });
    await rename(temporary, absolute);
    await chmod(absolute, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return hash;
}

async function pruneObjects(root: string, retained: ReadonlySet<string>) {
  const objects = checkoutObjectsPath(root);
  let prefixes: Dirent<string>[];
  try {
    prefixes = await readdir(objects, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) {
      await rm(join(objects, prefix.name), { recursive: true, force: true });
      continue;
    }
    const directory = join(objects, prefix.name);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = entry.isFile() ? entry.name.match(/^([a-f0-9]{62})\.br$/u) : null;
      const hash = match?.[1] ? `${prefix.name}${match[1]}` : null;
      if (!hash || !retained.has(hash)) await rm(join(directory, entry.name), { recursive: true, force: true });
    }
    if ((await readdir(directory)).length === 0) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export async function writeBaseFiles(root: string, files: readonly RepositoryFile[]) {
  const retained = new Set<string>();
  for (const file of files) retained.add(await writeObject(root, file.content));
  await pruneObjects(root, retained);
  await rm(checkoutBasePath(root), { recursive: true, force: true });
}

export async function readBaseFiles(root: string, tree: RepositoryTree): Promise<RepositoryFile[]> {
  const files = await Promise.all(
    Object.entries(tree).sort(([left], [right]) => left.localeCompare(right)).map(async ([path, hash]) => {
      let content: string;
      try {
        content = await readObject(root, hash);
      } catch (objectError) {
        try {
          content = await readFile(join(checkoutBasePath(root), path), "utf8");
        } catch {
          throw objectError;
        }
        if (hashRepositoryContent(content) !== hash) {
          throw new Error(`Legacy base file '${path}' failed its content hash check.`);
        }
        await writeObject(root, content);
      }
      return { path, content, mediaType: repositoryMediaType(path) };
    })
  );
  await pruneObjects(root, new Set(Object.values(tree)));
  await rm(checkoutBasePath(root), { recursive: true, force: true });
  return files;
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
