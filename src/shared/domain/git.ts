import { z } from "zod";

export const gitChangeKindSchema = z.enum(["added", "modified", "deleted", "renamed", "untracked", "conflict", "submodule"]);
export type GitChangeKind = z.infer<typeof gitChangeKindSchema>;
export type GitDiscovery = { checkoutRoot: string; mainCheckoutRoot: string | null; repositoryRoot: string; branchRef: string | null; detached: boolean };
export type GitFileStatus = { path: string; oldPath?: string; kind: GitChangeKind; staged: boolean; workingTree: boolean; binary: boolean; submodule: boolean };
export type GitStatus = GitDiscovery & { ahead: number; behind: number; aheadOfMain: number; behindMain: number; hasUpstream: boolean; dirty: boolean; conflicted: boolean; truncated: boolean; files: GitFileStatus[] };
export type DiffLine = { kind: "context" | "added" | "removed"; text: string };
export type DiffHunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; lines: DiffLine[] };
export type GitDiff = { path: string; oldPath?: string; binary: boolean; oversized: boolean; truncated: boolean; additions: number; deletions: number; hunks: DiffHunk[] };
