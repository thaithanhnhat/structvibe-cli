import { createHash } from "node:crypto";
import type {
  RepositoryTree,
  RepositoryTreeEntries,
  RepositoryTreeObject
} from "./model";

export function hashRepositoryContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function canonicalRepositoryTree(tree: RepositoryTree): RepositoryTree {
  return Object.fromEntries(Object.entries(tree).sort(([left], [right]) => left.localeCompare(right)));
}

export function hashRepositoryTree(tree: RepositoryTree): string {
  return hashRepositoryContent(JSON.stringify(canonicalRepositoryTree(tree)));
}

function canonicalTreeEntries(entries: RepositoryTreeEntries): RepositoryTreeEntries {
  return Object.fromEntries(
    Object.entries(entries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [name, { kind: entry.kind, hash: entry.hash }])
  );
}

export function hashRepositoryTreeObject(entries: RepositoryTreeEntries): string {
  return hashRepositoryContent(
    JSON.stringify({ schemaVersion: 1, entries: canonicalTreeEntries(entries) })
  );
}

type MutableTreeNode = {
  blobs: Map<string, string>;
  directories: Map<string, MutableTreeNode>;
};

function mutableTreeNode(): MutableTreeNode {
  return { blobs: new Map(), directories: new Map() };
}

function requireTreePath(path: string) {
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.endsWith("/") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid repository tree path '${path}'.`);
  }
  return segments;
}

/**
 * Converts the public flat path map into immutable, content-addressed directory
 * objects. A one-file edit only creates new objects along that file's path.
 */
export function buildRepositoryTreeObjects(tree: RepositoryTree): {
  rootHash: string;
  objects: RepositoryTreeObject[];
} {
  const root = mutableTreeNode();
  for (const [path, blobHash] of Object.entries(tree)) {
    const segments = requireTreePath(path);
    const fileName = segments.pop();
    if (!fileName) throw new Error(`Invalid repository tree path '${path}'.`);
    let node = root;
    for (const segment of segments) {
      if (node.blobs.has(segment)) {
        throw new Error(`Repository path '${path}' collides with a file.`);
      }
      const child = node.directories.get(segment) ?? mutableTreeNode();
      node.directories.set(segment, child);
      node = child;
    }
    if (node.directories.has(fileName)) {
      throw new Error(`Repository path '${path}' collides with a directory.`);
    }
    node.blobs.set(fileName, blobHash);
  }

  const objects = new Map<string, RepositoryTreeObject>();
  const finalize = (node: MutableTreeNode): string => {
    const entries: RepositoryTreeEntries = {};
    for (const [name, hash] of [...node.blobs].sort(([left], [right]) => left.localeCompare(right))) {
      entries[name] = { kind: "blob", hash };
    }
    for (const [name, child] of [...node.directories].sort(([left], [right]) => left.localeCompare(right))) {
      entries[name] = { kind: "tree", hash: finalize(child) };
    }
    const hash = hashRepositoryTreeObject(entries);
    objects.set(hash, { hash, entries: canonicalTreeEntries(entries) });
    return hash;
  };

  const rootHash = finalize(root);
  return { rootHash, objects: [...objects.values()] };
}

export function flattenRepositoryTreeObjects(
  rootHash: string,
  objects: ReadonlyMap<string, Pick<RepositoryTreeObject, "entries">>
): RepositoryTree {
  const tree: RepositoryTree = {};
  const active = new Set<string>();

  const entriesFor = (hash: string): RepositoryTreeEntries => {
    const object = objects.get(hash);
    if (!object) throw new Error(`Repository tree object '${hash}' is unavailable.`);
    return object.entries;
  };

  const visit = (hash: string, prefix: string, depth: number) => {
    if (depth > 128) throw new Error("Repository tree exceeds the maximum directory depth.");
    if (active.has(hash)) throw new Error(`Repository tree cycle detected at '${hash}'.`);
    active.add(hash);
    for (const [name, entry] of Object.entries(entriesFor(hash))) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
        throw new Error(`Invalid repository tree entry '${name}'.`);
      }
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === "blob") {
        if (tree[path]) throw new Error(`Duplicate repository path '${path}'.`);
        tree[path] = entry.hash;
      } else {
        visit(entry.hash, path, depth + 1);
      }
    }
    active.delete(hash);
  };

  visit(rootHash, "", 0);
  return canonicalRepositoryTree(tree);
}

export function hashRepositoryCommit(input: {
  projectId: string;
  parentCommitId: string | null;
  tree: RepositoryTree;
  message: string;
  authorId: string;
}): string {
  return hashRepositoryContent(
    JSON.stringify({
      schemaVersion: 1,
      projectId: input.projectId,
      parentCommitId: input.parentCommitId,
      tree: canonicalRepositoryTree(input.tree),
      message: input.message,
      authorId: input.authorId
    })
  );
}

export function hashRepositoryCommitV2(input: {
  projectId: string;
  parentCommitIds: readonly string[];
  treeHash: string;
  message: string;
  authorId: string;
}): string {
  return hashRepositoryContent(
    JSON.stringify({
      schemaVersion: 2,
      projectId: input.projectId,
      parentCommitIds: [...input.parentCommitIds],
      treeHash: input.treeHash,
      message: input.message,
      authorId: input.authorId
    })
  );
}
