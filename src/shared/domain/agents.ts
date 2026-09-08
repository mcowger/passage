import { z } from "zod";
import { protocolPayloadSchema, type JsonValue } from "../protocol/index.ts";

export const agentStatusSchema = z.enum(["initializing", "idle", "running", "needs-attention", "error", "archived"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentSummarySchema = z.object({
  id: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  status: agentStatusSchema,
  modelPreference: z.string().nullable(),
  thinkingPreference: z.string().nullable(),
  live: z.boolean(),
  persisted: z.boolean(),
  generation: z.number().int().positive().safe().optional(),
}).strict();
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const agentCapabilitiesSchema = z.object({
  models: z.array(z.object({
    provider: z.string().min(1).max(256),
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    api: z.string().min(1).max(256),
    input: z.array(z.string().min(1).max(64)).max(8),
    authenticated: z.boolean(),
    supportedThinkingLevels: z.array(z.string().min(1).max(64)).max(16),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  }).strict()).max(100),
  thinkingLevels: z.array(z.string().min(1).max(64)).max(16),
}).strict();
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

export type PassageAgent = {
  id: string;
  workspaceId: string;
  status: AgentStatus;
  piSessionId: string;
  sessionPath: string | null;
};

export type AgentHistoryRevision = {
  mtimeMs: number;
  size: number;
  contentHash: string;
};

export type AgentUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
};

export type ToolActivity = {
  kind: "tool";
  id: string;
  name: string;
  input: JsonValue;
  result?: string;
  status: "running" | "complete" | "error";
  significant: boolean;
  error?: string;
};

export type TimelineItem =
  | { kind: "user" | "assistant" | "thinking"; id: string; text: string; lazy?: boolean; error?: string }
  | ToolActivity
  | { kind: "process"; id: string; activities: ToolActivity[] }
  | { kind: "summary"; id: string; summaryType: "compaction" | "branch"; text: string }
  | { kind: "unknown"; id: string; entryType: string };

export type AgentBranchEntry = {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string;
  fromId?: string;
  active: boolean;
};

export type AgentHistory = {
  sessionId: string;
  leafId?: string;
  leafInferred?: boolean;
  parentSession?: string;
  sessionName?: string;
  currentModel?: { provider: string; modelId: string };
  currentThinkingLevel?: string;
  revision: AgentHistoryRevision;
  timeline: TimelineItem[];
  branches: AgentBranchEntry[];
  usage: AgentUsage;
  unknownRecordCount: number;
  agentErrorCount: number;
  malformedRecordCount: number;
  partialTail: boolean;
  invalidUtf8Count: number;
  rewritten: boolean;
};

const toolActivitySchema = z.object({
  kind: z.literal("tool"),
  id: z.string(),
  name: z.string(),
  input: protocolPayloadSchema,
  result: z.string().optional(),
  status: z.enum(["running", "complete", "error"]),
  significant: z.boolean(),
  error: z.string().optional(),
}).strict();

const timelineItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["user", "assistant", "thinking"]), id: z.string(), text: z.string(), lazy: z.boolean().optional(), error: z.string().optional() }).strict(),
  toolActivitySchema,
  z.object({ kind: z.literal("process"), id: z.string(), activities: z.array(toolActivitySchema).max(500) }).strict(),
  z.object({ kind: z.literal("summary"), id: z.string(), summaryType: z.enum(["compaction", "branch"]), text: z.string() }).strict(),
  z.object({ kind: z.literal("unknown"), id: z.string(), entryType: z.string() }).strict(),
]);

export const agentHistorySchema: z.ZodType<AgentHistory> = z.object({
  sessionId: z.string(),
  leafId: z.string().optional(),
  leafInferred: z.boolean().optional(),
  parentSession: z.string().optional(),
  sessionName: z.string().optional(),
  currentModel: z.object({ provider: z.string(), modelId: z.string() }).strict().optional(),
  currentThinkingLevel: z.string().optional(),
  revision: z.object({ mtimeMs: z.number(), size: z.number().int().nonnegative(), contentHash: z.string() }).strict(),
  timeline: z.array(timelineItemSchema).max(500),
  branches: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), type: z.string(), timestamp: z.string().optional(), fromId: z.string().optional(), active: z.boolean() }).strict()).max(20_000),
  usage: z.object({
    input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), totalTokens: z.number(), cost: z.number(),
  }).strict(),
  unknownRecordCount: z.number().int().nonnegative(),
  agentErrorCount: z.number().int().nonnegative(),
  malformedRecordCount: z.number().int().nonnegative(),
  partialTail: z.boolean(),
  invalidUtf8Count: z.number().int().nonnegative(),
  rewritten: z.boolean(),
}).strict();

export const agentHistoryResponseSchema = z.union([
  z.object({ history: agentHistorySchema, nextBefore: z.number().int().nonnegative().optional() }).strict(),
  z.object({ unpersisted: z.literal(true), history: z.null() }).strict(),
]);
export type AgentHistoryResponse = z.infer<typeof agentHistoryResponseSchema>;
