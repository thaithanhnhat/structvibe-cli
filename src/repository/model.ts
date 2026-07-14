import { z } from "zod";

export const REPOSITORY_PROFILE_VERSION = 2 as const;

export const repositoryPermissionSchema = z.enum([
  "repository:read",
  "repository:branch",
  "repository:push",
  "merge-request:create"
]);
export type RepositoryPermission = z.infer<typeof repositoryPermissionSchema>;

export const repositoryFileSchema = z.object({
  path: z.string().trim().min(1).max(240),
  content: z.string().max(1_000_000),
  mediaType: z.string().trim().min(1).max(120).optional()
});
export type RepositoryFile = z.infer<typeof repositoryFileSchema>;

export const repositoryTreeSchema = z.record(
  z.string().trim().min(1).max(240),
  z.string().regex(/^[a-f0-9]{64}$/u)
);
export type RepositoryTree = z.infer<typeof repositoryTreeSchema>;

export const repositoryTreeEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blob"), hash: z.string().regex(/^[a-f0-9]{64}$/u) }),
  z.object({ kind: z.literal("tree"), hash: z.string().regex(/^[a-f0-9]{64}$/u) })
]);
export type RepositoryTreeEntry = z.infer<typeof repositoryTreeEntrySchema>;

export const repositoryTreeEntriesSchema = z.record(
  z.string().trim().min(1).max(240),
  repositoryTreeEntrySchema
);
export type RepositoryTreeEntries = z.infer<typeof repositoryTreeEntriesSchema>;

export interface RepositoryTreeObject {
  hash: string;
  entries: RepositoryTreeEntries;
}

export const repositoryChangeSchema = z.object({
  path: z.string().trim().min(1).max(240),
  content: z.string().max(1_000_000).nullable(),
  mediaType: z.string().trim().min(1).max(120).optional()
});
export type RepositoryChange = z.infer<typeof repositoryChangeSchema>;

export const repositoryPushSchema = z.object({
  branch: z.string().trim().min(1).max(120),
  baseCommitId: z.string().uuid(),
  message: z.string().trim().min(1).max(500),
  changes: z.array(repositoryChangeSchema).min(1).max(500),
  idempotencyKey: z.string().trim().min(8).max(200).optional()
});
export type RepositoryPush = z.infer<typeof repositoryPushSchema>;

export const repositoryMergeRequestCreateSchema = z.object({
  sourceBranch: z.string().trim().min(1).max(120),
  targetBranch: z.string().trim().min(1).max(120).default("main"),
  title: z.string().trim().min(1).max(240),
  body: z.string().trim().max(20_000).optional()
});
export type RepositoryMergeRequestCreate = z.infer<typeof repositoryMergeRequestCreateSchema>;

export const repositoryMergeRequestActionSchema = z.object({
  action: z.enum(["merge", "close"])
});
export type RepositoryMergeRequestAction = z.infer<typeof repositoryMergeRequestActionSchema>;

export const repositoryManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  projectSlug: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(200),
  defaultBranch: z.string().trim().min(1).max(120).default("main")
});
export type RepositoryManifest = z.infer<typeof repositoryManifestSchema>;

export const screenManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  code: z.string().regex(/^SCR-[A-Za-z0-9_-]+$/u),
  name: z.string().trim().min(1).max(240),
  status: z.string().trim().min(1).max(80).default("draft"),
  viewport: z.object({
    width: z.number().int().min(160).max(10_000),
    height: z.number().int().min(160).max(10_000)
  })
});
export type ScreenManifest = z.infer<typeof screenManifestSchema>;

export interface RepositoryValidationIssue {
  code: string;
  message: string;
  path?: string | undefined;
  line?: number | undefined;
  column?: number | undefined;
}

export interface RepositoryValidationResult {
  ok: boolean;
  issues: RepositoryValidationIssue[];
  fileCount: number;
  byteSize: number;
}
