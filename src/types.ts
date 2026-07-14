import type { RepositoryChange, RepositoryFile, RepositoryTree } from "./repository/index";

export interface CliCredential {
  server: string;
  token: string;
  tokenId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  userEmail: string;
}

export interface CheckoutState {
  schemaVersion: 1;
  server: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  branch: string;
  baseCommitId: string;
  baseTree: RepositoryTree;
}

export interface PendingCommit {
  schemaVersion: 1;
  baseCommitId: string;
  message: string;
  changes: RepositoryChange[];
  createdAt: string;
}

export interface SnapshotResponse {
  ok: true;
  repositoryProfileVersion: number;
  project: { id: string; name: string; slug: string };
  branch: { id: string; name: string; protected: boolean };
  commit: { id: string; tree: RepositoryTree; contentHash: string; message: string };
  files: RepositoryFile[];
}
