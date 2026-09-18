import { z } from "zod";
import { MAX_FILE_PATH_LENGTH } from "../domain/files.ts";

const workspaceIdSchema = z.string().min(1).max(256);

export const workspaceSubscriptionPayloadSchema = z.object({
  workspaceId: workspaceIdSchema,
  afterSequence: z.number().int().nonnegative().safe().default(0),
}).strict();

export const workspaceTargetPayloadSchema = z.object({ workspaceId: workspaceIdSchema }).strict();

export const filesChangedReasonSchema = z.enum(["create", "rename", "duplicate", "delete", "write"]);
export type FilesChangedReason = z.infer<typeof filesChangedReasonSchema>;

/** Invalidation-only payload for `files-changed` workspace events. Receivers
 *  refetch authoritative HTTP snapshots; file contents never ride the wire.
 *  `path` is the affected workspace-relative path (the destination for
 *  renames); `previousPath` is the rename source when applicable. */
export const filesChangedPayloadSchema = z.object({
  workspaceId: workspaceIdSchema,
  reason: filesChangedReasonSchema,
  path: z.string().min(1).max(MAX_FILE_PATH_LENGTH).optional(),
  previousPath: z.string().min(1).max(MAX_FILE_PATH_LENGTH).optional(),
}).strict();
export type FilesChangedPayload = z.infer<typeof filesChangedPayloadSchema>;

export const filesSearchQuerySchema = z.object({
  q: z.string().max(64).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export type FilesSearchQuery = z.infer<typeof filesSearchQuerySchema>;

export const fileSearchEntrySchema = z.object({
  path: z.string().min(1).max(MAX_FILE_PATH_LENGTH),
  kind: z.enum(["file", "directory"]),
}).strict();
export type FileSearchEntry = z.infer<typeof fileSearchEntrySchema>;

export const filesSearchResponseSchema = z.object({
  query: z.string().max(64),
  entries: z.array(fileSearchEntrySchema).max(50),
  truncated: z.boolean(),
}).strict();
export type FilesSearchResponse = z.infer<typeof filesSearchResponseSchema>;

/** Host directory suggestions for the Add Project directory picker.
 *  The picker browses daemon-local paths outside registered workspace
 *  roots by design (it selects a new root); the endpoint is read-only and
 *  bounded, and `registerProject` still resolves/verifies the final choice
 *  before persisting anything. */
export const directorySuggestQuerySchema = z.object({
  path: z.string().max(MAX_FILE_PATH_LENGTH).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export type DirectorySuggestQuery = z.infer<typeof directorySuggestQuerySchema>;

export const directorySuggestEntrySchema = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1).max(MAX_FILE_PATH_LENGTH),
}).strict();
export type DirectorySuggestEntry = z.infer<typeof directorySuggestEntrySchema>;

export const directorySuggestResponseSchema = z.object({
  base: z.string().min(1).max(MAX_FILE_PATH_LENGTH),
  entries: z.array(directorySuggestEntrySchema).max(50),
  truncated: z.boolean(),
}).strict();
export type DirectorySuggestResponse = z.infer<typeof directorySuggestResponseSchema>;

export const gitStatusChangedReasonSchema = z.enum([
  "stage", "unstage", "stage-all", "unstage-all", "discard", "commit", "pull", "fetch", "merge", "rebase", "push",
]);
export type GitStatusChangedReason = z.infer<typeof gitStatusChangedReasonSchema>;

/** Invalidation-only payload for `git-status-changed` workspace events.
 *  Receivers refetch the authoritative HTTP status snapshot; `GitStatus`
 *  never rides the wire. */
export const gitStatusChangedPayloadSchema = z.object({
  workspaceId: workspaceIdSchema,
  reason: gitStatusChangedReasonSchema,
}).strict();
export type GitStatusChangedPayload = z.infer<typeof gitStatusChangedPayloadSchema>;

/** Invalidation-only payload for `actions-changed` workspace events.
 *  Receivers refetch the authoritative action-run HTTP snapshot; run
 *  results never ride the wire. */
export const workspaceActionsChangedPayloadSchema = z.object({
  workspaceId: workspaceIdSchema,
  runId: z.string().min(1).max(128),
}).strict();
export type WorkspaceActionsChangedPayload = z.infer<typeof workspaceActionsChangedPayloadSchema>;

/** Well-known subject for workspace-list invalidations. Per-workspace
 *  subjects (`files-changed`, `git-status-changed`, `actions-changed`)
 *  only reach clients subscribed to that workspace; the sidebar snapshot
 *  (`GET /api/workspaces/snapshot`) needs a global subject so a second
 *  window learns about creates, deletes, archives, renames, and location
 *  changes made elsewhere. */
export const WORKSPACES_SNAPSHOT_SUBJECT = "workspaces" as const;

export const workspacesChangedReasonSchema = z.enum([
  "create", "remove", "archive", "reopen", "update",
]);
export type WorkspacesChangedReason = z.infer<typeof workspacesChangedReasonSchema>;

/** Invalidation-only payload for `workspaces-changed` events on the
 *  `WORKSPACES_SNAPSHOT_SUBJECT` subject. Receivers refetch
 *  `GET /api/workspaces/snapshot`; workspace/project detail never rides
 *  the wire. `workspaceId`/`projectId` are opaque hints only. */
export const workspacesChangedPayloadSchema = z.object({
  reason: workspacesChangedReasonSchema,
  workspaceId: workspaceIdSchema.optional(),
  projectId: workspaceIdSchema.optional(),
}).strict();
export type WorkspacesChangedPayload = z.infer<typeof workspacesChangedPayloadSchema>;
