import { z } from "zod";
import { protocolPayloadSchema, type JsonValue } from "../protocol/index.ts";

export const agentStatusSchema = z.enum(["initializing", "idle", "running", "stopping", "needs-attention", "error", "archived"]);
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
  pendingUiRequest: z.record(z.string(), z.unknown()).optional(),
  /** Epoch ms when Passage observed the current run start; absent when no run is active. */
  runStartedAt: z.number().int().nonnegative().safe().optional(),
}).strict();
export type AgentSummary = z.infer<typeof agentSummarySchema>;

export const slashCommandSchema = z.object({
  // Plain built-ins (`compact`) plus pi skill commands (`skill:name`).
  name: z.string().min(1).max(64).regex(/^[A-Za-z0-9_:.-]+$/),
  description: z.string().min(1).max(256),
  hint: z.string().min(1).max(128),
  kind: z.enum(["prompt-text", "action"]),
}).strict();
export type SlashCommand = z.infer<typeof slashCommandSchema>;

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
  /** Live Pi defaults from `get_state`: the fallback shown before any
   *  persisted preference or journaled model exists (brand-new sessions).
   *  Without these, a fresh agent renders "model unavailable" until the
   *  first background reconcile + summary refetch lands. */
  currentModel: z.object({ provider: z.string(), modelId: z.string() }).strict().optional(),
  currentThinkingLevel: z.string().min(1).max(64).optional(),
  slashCommands: z.array(slashCommandSchema).max(50).default([]),
  skillsAvailable: z.boolean().default(false),
  /** True when the live Pi process answered `get_commands`. False means
   *  skills state is unknown (disabled or unsupported Pi), as opposed to
   *  `skillsAvailable: false` with support, which means none installed. */
  skillsSupported: z.boolean().default(false),
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
  error?: string;
};

export type UserImageRef = {
  /** SHA-256 hex of the raw image bytes; addresses the daemon sidecar cache. */
  hash: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  name: string;
  /** Client-only object/data URL for the optimistic pre-echo. Never persisted or sent by the daemon. */
  previewUrl?: string;
};

const userImageRefSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  name: z.string().min(1).max(256),
  previewUrl: z.string().min(1).max(8 * 1024 * 1024).optional(),
}).strict();

export type UserFileRef = {
  /** SHA-256 hex of the file bytes; addresses the daemon attachment cache. */
  hash: string;
  /** Original filename for display and download. */
  name: string;
  /** Absolute filesystem path so the agent's tools can read the file. */
  path: string;
  size: number;
  mimeType: string;
};

const userFileRefSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(4096),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(256),
}).strict();

export type TimelineItem =
  | { kind: "user"; id: string; text: string; images?: UserImageRef[]; files?: UserFileRef[]; lazy?: boolean; error?: string }
  | { kind: "assistant" | "thinking"; id: string; text: string; lazy?: boolean; error?: string }
  | ToolActivity
  | { kind: "summary"; id: string; summaryType: "compaction" | "branch"; text: string; tokensBefore?: number; compactionReason?: "manual" | "auto" }
  /** Daemon/process-level failure (crash, RPC error, permission denial). Not
   *  journaled -- positioned chronologically in the live transcript so it
   *  survives a browser reconnect but not a daemon restart. */
  | { kind: "error"; id: string; text: string }
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
  /** Bumped by the daemon whenever the in-memory transcript backing `timeline`
   *  is rebuilt from scratch (cold seed, daemon restart, or a compaction that
   *  invalidates row identity). The client replaces its local timeline when
   *  this changes and otherwise only merges the non-timeline fields below,
   *  since live `row_upsert` events are the sole, authoritative source of
   *  timeline mutations while the epoch is unchanged. */
  transcriptEpoch: number;
  branches: AgentBranchEntry[];
  usage: AgentUsage;
  /** Current context-window occupancy from the latest assistant turn, not the session cumulative total. */
  contextUsage?: { tokens: number | null };
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
  error: z.string().optional(),
}).strict();

const timelineItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), text: z.string(), images: z.array(userImageRefSchema).max(2).optional(), files: z.array(userFileRefSchema).max(5).optional(), lazy: z.boolean().optional(), error: z.string().optional() }).strict(),
  z.object({ kind: z.enum(["assistant", "thinking"]), id: z.string(), text: z.string(), lazy: z.boolean().optional(), error: z.string().optional() }).strict(),
  toolActivitySchema,
  z.object({ kind: z.literal("summary"), id: z.string(), summaryType: z.enum(["compaction", "branch"]), text: z.string(), tokensBefore: z.number().int().nonnegative().optional(), compactionReason: z.enum(["manual", "auto"]).optional() }).strict(),
  z.object({ kind: z.literal("error"), id: z.string(), text: z.string() }).strict(),
  z.object({ kind: z.literal("unknown"), id: z.string(), entryType: z.string() }).strict(),
]);
export const timelineItemPayloadSchema = timelineItemSchema;

/** Result of `POST /api/agents/:agentId/compact`. A successful compaction
 *  carries the pre-compaction token count for the success notice; a
 *  refused one (session too short or already compacted) is not an error
 *  from the user's perspective, so it stays a 202 with `compacted: false`
 *  instead of a failure status. */
export const compactResponseSchema = z.object({
  accepted: z.literal(true),
  compacted: z.boolean(),
  reason: z.enum(["session-too-short", "already-compacted"]).optional(),
  tokensBefore: z.number().int().nonnegative().optional(),
}).strict();
export type CompactResponse = z.infer<typeof compactResponseSchema>;

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
  transcriptEpoch: z.number().int().nonnegative(),
  branches: z.array(z.object({ id: z.string(), parentId: z.string().nullable(), type: z.string(), timestamp: z.string().optional(), fromId: z.string().optional(), active: z.boolean() }).strict()).max(20_000),
  usage: z.object({
    input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), totalTokens: z.number(), cost: z.number(),
  }).strict(),
  contextUsage: z.object({ tokens: z.number().nullable() }).strict().optional(),
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
