import { z } from "zod";
import { opaqueDomainIdSchema, MAX_DOMAIN_LABEL_LENGTH, MAX_DOMAIN_PATH_LENGTH } from "./workspaces.ts";

export const terminalIdSchema = opaqueDomainIdSchema;

export const terminalStatusSchema = z.enum(["running", "exited"]);
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

export const terminalDimensionsSchema = z.object({
  columns: z.number().int().min(10).max(500),
  rows: z.number().int().min(3).max(200),
}).strict();
export type TerminalDimensions = z.infer<typeof terminalDimensionsSchema>;

export const terminalSummarySchema = z.object({
  id: terminalIdSchema,
  workspaceId: opaqueDomainIdSchema,
  title: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH),
  cwd: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH),
  columns: z.number().int().min(10).max(500),
  rows: z.number().int().min(3).max(200),
  status: terminalStatusSchema,
  exitCode: z.number().int().nullable(),
  hasSizeLease: z.boolean(),
  createdAt: z.string().datetime(),
}).strict();
export type TerminalSummary = z.infer<typeof terminalSummarySchema>;

export const createTerminalInputSchema = z.object({
  title: z.string().trim().min(1).max(MAX_DOMAIN_LABEL_LENGTH).optional(),
  columns: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(3).max(200).optional(),
  cwd: z.string().min(1).max(MAX_DOMAIN_PATH_LENGTH).optional(),
}).strict();
export type CreateTerminalInput = z.infer<typeof createTerminalInputSchema>;
