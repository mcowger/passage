import { z } from "zod";

export const MAX_DOMAIN_ID_LENGTH = 128;
export const MAX_DOMAIN_LABEL_LENGTH = 256;
export const MAX_DOMAIN_PATH_LENGTH = 4096;
export const opaqueDomainIdSchema = z.string().min(1).max(MAX_DOMAIN_ID_LENGTH);
const pathSchema = z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH);
const labelSchema = z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH);
export const workspaceKindSchema = z.enum(["directory", "main-checkout", "worktree"]);
export const workspaceSchema = z.object({
  id: opaqueDomainIdSchema, projectId: opaqueDomainIdSchema, kind: workspaceKindSchema,
  cwd: pathSchema, checkoutRoot: pathSchema.nullable(), mainRepositoryRoot: pathSchema.nullable(),
  branchRef: z.string().max(MAX_DOMAIN_PATH_LENGTH).nullable(), displayLabel: labelSchema, locationId: opaqueDomainIdSchema.nullable(),
  ownershipState: z.string().min(1), markerId: opaqueDomainIdSchema.nullable().default(null), markerPath: pathSchema.nullable().default(null), repairDetail: z.string().nullable().default(null), archivedAt: z.string().nullable(),
}).strict();
export const projectSchema = z.object({ id: opaqueDomainIdSchema, configuredRootPath: pathSchema, canonicalRootPath: pathSchema, displayLabel: labelSchema, archivedAt: z.string().nullable() }).strict();
export const locationSchema = z.object({ id: opaqueDomainIdSchema, projectId: opaqueDomainIdSchema.nullable(), scope: z.enum(["global", "project"]), displayLabel: labelSchema, configuredRootPath: pathSchema, canonicalRootPath: pathSchema, enabled: z.boolean() }).strict();
export const workspaceSnapshotSchema = z.object({
  projects: z.array(projectSchema).max(100),
  workspaces: z.array(workspaceSchema).max(100),
  locations: z.array(locationSchema).max(100),
}).strict();
export type Workspace = z.infer<typeof workspaceSchema>;
export type Project = z.infer<typeof projectSchema>;
export type WorktreeLocation = z.infer<typeof locationSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
