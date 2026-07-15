import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fetchProjectAsset } from "./api";
import { checkoutDirectoryName } from "./config";
import type { CheckoutState, CliCredential } from "./types";

const assetHashPattern = /^[a-f0-9]{64}$/u;

export interface CheckoutAsset {
  bytes: Uint8Array;
  contentType: string;
}

type AssetFetcher = typeof fetchProjectAsset;
const pendingAssets = new Map<string, Promise<CheckoutAsset>>();

function assetDirectory(root: string, contentHash: string) {
  if (!assetHashPattern.test(contentHash)) throw new Error("Invalid StructVibe asset hash.");
  return join(root, checkoutDirectoryName, "assets", contentHash);
}

function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readCachedAsset(root: string, contentHash: string): Promise<CheckoutAsset | null> {
  const directory = assetDirectory(root, contentHash);
  try {
    const [content, rawMetadata] = await Promise.all([
      readFile(join(directory, "content")),
      readFile(join(directory, "metadata.json"), "utf8")
    ]);
    const metadata = JSON.parse(rawMetadata) as { contentType?: unknown };
    if (typeof metadata.contentType !== "string" || digest(content) !== contentHash) {
      await rm(directory, { recursive: true, force: true });
      return null;
    }
    return { bytes: Uint8Array.from(content), contentType: metadata.contentType };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCachedAsset(
  root: string,
  contentHash: string,
  asset: CheckoutAsset
) {
  const directory = assetDirectory(root, contentHash);
  const temporary = `${directory}.tmp-${randomUUID()}`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    await Promise.all([
      writeFile(join(temporary, "content"), asset.bytes, { mode: 0o600 }),
      writeFile(
        join(temporary, "metadata.json"),
        `${JSON.stringify({ contentType: asset.contentType })}\n`,
        { encoding: "utf8", mode: 0o600 }
      )
    ]);
    await mkdir(join(root, checkoutDirectoryName, "assets"), {
      recursive: true,
      mode: 0o700
    });
    await rm(directory, { recursive: true, force: true });
    await rename(temporary, directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function resolveCheckoutAsset(
  root: string,
  state: CheckoutState,
  credential: CliCredential,
  contentHash: string,
  fetcher: AssetFetcher = fetchProjectAsset
): Promise<CheckoutAsset> {
  const cached = await readCachedAsset(root, contentHash);
  if (cached) return cached;
  const cacheKey = `${root}\0${contentHash}`;
  const pending = pendingAssets.get(cacheKey);
  if (pending) return pending;
  const download = (async () => {
    const fetched = await fetcher(credential, state.projectId, contentHash);
    if (digest(fetched.bytes) !== contentHash) {
      throw new Error(`Asset '${contentHash}' did not match its immutable content hash.`);
    }
    const asset = { bytes: fetched.bytes, contentType: fetched.contentType };
    await writeCachedAsset(root, contentHash, asset);
    return asset;
  })();
  pendingAssets.set(cacheKey, download);
  try {
    return await download;
  } finally {
    if (pendingAssets.get(cacheKey) === download) pendingAssets.delete(cacheKey);
  }
}
