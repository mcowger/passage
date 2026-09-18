import { z } from "zod";

export const MAX_AGENT_MESSAGE_BYTES = 64 * 1024;
export const MAX_AGENT_SETTING_LENGTH = 256;
export const MAX_AGENT_IMAGES = 10;
export const MAX_AGENT_IMAGE_DATA_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_IMAGE_DATA_CHARACTERS = Math.ceil(MAX_AGENT_IMAGE_DATA_BYTES * 4 / 3);
export const MAX_AGENT_FILES = 5;
export const MAX_AGENT_FILE_DATA_BYTES = 10 * 1024 * 1024;
export const MAX_AGENT_FILE_DATA_CHARACTERS = Math.ceil(MAX_AGENT_FILE_DATA_BYTES * 4 / 3);
const agentIdSchema = z.string().min(1).max(256);

export const agentImageSchema = z.object({
  type: z.literal("image"),
  name: z.string().min(1).max(256).optional(),
  data: z.string().min(1).max(MAX_AGENT_IMAGE_DATA_CHARACTERS).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine((data) => {
    try {
      return atob(data).length <= MAX_AGENT_IMAGE_DATA_BYTES;
    } catch {
      return false;
    }
  }, "Image data exceeds byte limit"),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
}).strict();
export type AgentImage = z.infer<typeof agentImageSchema>;

export const agentFileSchema = z.object({
  type: z.literal("file"),
  name: z.string().min(1).max(256),
  data: z.string().min(1).max(MAX_AGENT_FILE_DATA_CHARACTERS).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine((data) => {
    try {
      return atob(data).length <= MAX_AGENT_FILE_DATA_BYTES;
    } catch {
      return false;
    }
  }, "File data exceeds byte limit"),
  mimeType: z.string().min(1).max(256),
}).strict();
export type AgentFile = z.infer<typeof agentFileSchema>;

export const agentSubscriptionPayloadSchema = z.object({
  agentId: agentIdSchema,
  afterSequence: z.number().int().nonnegative().safe().default(0),
}).strict();

export const agentTargetPayloadSchema = z.object({ agentId: agentIdSchema }).strict();

export const agentMessagePayloadSchema = z.object({
  agentId: agentIdSchema,
  message: z.string().min(1).max(MAX_AGENT_MESSAGE_BYTES),
  images: z.array(agentImageSchema).max(MAX_AGENT_IMAGES).optional(),
  files: z.array(agentFileSchema).max(MAX_AGENT_FILES).optional(),
}).strict();

export const agentModelPayloadSchema = z.object({
  agentId: agentIdSchema,
  provider: z.string().trim().min(1).max(MAX_AGENT_SETTING_LENGTH),
  modelId: z.string().trim().min(1).max(MAX_AGENT_SETTING_LENGTH),
}).strict();

export const agentThinkingPayloadSchema = z.object({
  agentId: agentIdSchema,
  level: z.string().trim().min(1).max(MAX_AGENT_SETTING_LENGTH),
}).strict();

export const agentUiResponsePayloadSchema = z.object({
  agentId: agentIdSchema,
  id: z.string().min(1).max(256),
  value: z.string().max(MAX_AGENT_MESSAGE_BYTES).optional(),
  confirmed: z.boolean().optional(),
  cancelled: z.literal(true).optional(),
}).refine(
  (data) => data.cancelled !== undefined || data.confirmed !== undefined || data.value !== undefined,
  "Either value, confirmed, or cancelled must be provided"
);
export type AgentUiResponsePayload = z.infer<typeof agentUiResponsePayloadSchema>;
