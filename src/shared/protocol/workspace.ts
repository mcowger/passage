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

export const gitStatusChangedReasonSchema = z.enum([
  "stage", "unstage", "stage-all", "unstage-all", "discard", "commit", "pull", "fetch",
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
