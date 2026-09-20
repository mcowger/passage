import { z } from "zod";

export const gitChangeKindSchema = z.enum(["added", "modified", "deleted", "renamed", "untracked", "conflict", "submodule"]);
export type GitChangeKind = z.infer<typeof gitChangeKindSchema>;
export type GitDiscovery = { checkoutRoot: string; mainCheckoutRoot: string | null; repositoryRoot: string; branchRef: string | null; detached: boolean };
export type GitFileStatus = { path: string; oldPath?: string; kind: GitChangeKind; staged: boolean; workingTree: boolean; binary: boolean; submodule: boolean };
export type GitStatus = GitDiscovery & { ahead: number; behind: number; aheadOfMain: number; behindMain: number; hasUpstream: boolean; dirty: boolean; conflicted: boolean; truncated: boolean; files: GitFileStatus[] };
export type DiffLine = { kind: "context" | "added" | "removed"; text: string };
export type DiffHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; lines: DiffLine[] };
export type GitDiff = { path: string; oldPath?: string; binary: boolean; oversized: boolean; truncated: boolean; additions: number; deletions: number; hunks: DiffHunk[] };
/** Open PR record surfaced from `gh` (never throws when there is none). */
export type GithubPr = { number: number; url: string; title: string; state: string; base: string; head: string; isDraft: boolean };
export type GithubRepo = { nameWithOwner: string; defaultBranch: string };
/** `gh` availability for a workspace checkout. PR commands require both. */
export type GithubStatus = { installed: boolean; available: boolean; repo: GithubRepo | null; pr: GithubPr | null };

/** One Passage workspace row tracking a branch, for branch-review annotation. */
export const trackedBranchWorkspaceSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  displayLabel: z.string().min(1).max(256),
  kind: z.string().min(1).max(64),
  archivedAt: z.string().nullable(),
}).strict();
export type TrackedBranchWorkspace = z.infer<typeof trackedBranchWorkspaceSchema>;

/** One live local git branch annotated with Passage DB tracking state.
 *  Returned by `GET /api/projects/:projectId/branches`; invalidation-only
 *  WS rules do not apply because this is an HTTP snapshot the modal refetches. */
export const projectBranchSchema = z.object({
  name: z.string().min(1).max(1024),
  head: z.string().min(1).max(256),
  upstream: z.string().max(1024).nullable(),
  lastCommitAt: z.string().nullable(),
  subject: z.string().max(1024),
  isCurrent: z.boolean(),
  isMain: z.boolean(),
  isCheckedOut: z.boolean(),
  worktreePath: z.string().max(4096).nullable(),
  mergedIntoMain: z.boolean().nullable(),
  trackedWorkspaces: z.array(trackedBranchWorkspaceSchema).max(100),
}).strict();
export type ProjectBranch = z.infer<typeof projectBranchSchema>;
export const projectBranchListSchema = z.array(projectBranchSchema).max(500);
export type ProjectBranchList = z.infer<typeof projectBranchListSchema>;
