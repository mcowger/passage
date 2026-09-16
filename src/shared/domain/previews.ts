import { z } from "zod";

export const MAX_PREVIEW_ID_LENGTH = 128;
export const MAX_PREVIEW_LABEL_LENGTH = 256;
export const MAX_PREVIEW_URL_LENGTH = 2048;

export const previewIdSchema = z.string().min(1).max(MAX_PREVIEW_ID_LENGTH);
export const previewLabelSchema = z.string().trim().min(1).max(MAX_PREVIEW_LABEL_LENGTH);

export const previewViewportSchema = z.object({
  width: z.number().int().min(320).max(4096),
  height: z.number().int().min(240).max(4096),
  deviceScaleFactor: z.number().min(0.5).max(4),
}).strict();
export type PreviewViewport = z.infer<typeof previewViewportSchema>;

export const previewStatusSchema = z.enum([
  "stopped",
  "starting",
  "ready",
  "disconnected",
  "error",
  "stopping",
]);
export type PreviewStatus = z.infer<typeof previewStatusSchema>;

export const webPreviewSchema = z.object({
  id: previewIdSchema,
  workspaceId: z.string().min(1).max(MAX_PREVIEW_ID_LENGTH),
  label: previewLabelSchema,
  targetUrl: z.string().min(1).max(MAX_PREVIEW_URL_LENGTH),
  viewport: previewViewportSchema,
  status: previewStatusSchema,
  currentUrl: z.string().max(MAX_PREVIEW_URL_LENGTH).nullable(),
  hasInputLease: z.boolean().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();
export type WebPreview = z.infer<typeof webPreviewSchema>;

export const createPreviewInputSchema = z.object({
  label: previewLabelSchema.optional(),
  targetUrl: z.string().min(1).max(MAX_PREVIEW_URL_LENGTH),
  viewport: previewViewportSchema.partial().optional(),
}).strict();
export type CreatePreviewInput = z.infer<typeof createPreviewInputSchema>;

export const updatePreviewInputSchema = z.object({
  label: previewLabelSchema.optional(),
  targetUrl: z.string().min(1).max(MAX_PREVIEW_URL_LENGTH).optional(),
  viewport: previewViewportSchema.partial().optional(),
}).strict();
export type UpdatePreviewInput = z.infer<typeof updatePreviewInputSchema>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Normalize bare-port input ("5173") to a loopback URL, then validate that
 *  the result is an http(s) loopback URL with an explicit valid port. */
export function normalizePreviewUrl(input: string): string {
  const trimmed = input.trim();
  if (/^\d{1,5}$/.test(trimmed)) {
    return normalizePreviewUrl(`http://localhost:${trimmed}`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Preview URL must be an http(s) loopback URL with an explicit port");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Preview URL must use http or https");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Preview URL host must be localhost, 127.0.0.1, or [::1]");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Preview URL must include an explicit valid port");
  }
  if (url.username || url.password) {
    throw new Error("Preview URL must not include credentials");
  }
  return url.toString();
}

export const previewElementBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
}).strict();

export const previewElementContextSchema = z.object({
  previewId: previewIdSchema,
  url: z.string().max(MAX_PREVIEW_URL_LENGTH),
  title: z.string().max(512).optional(),
  ref: z.string().max(64).optional(),
  selector: z.string().max(1024).optional(),
  tagName: z.string().min(1).max(64),
  role: z.string().max(128).optional(),
  accessibleName: z.string().max(512).optional(),
  text: z.string().max(2048).optional(),
  attributes: z.record(z.string().max(128), z.string().max(1024)).refine(
    (value) => Object.keys(value).length <= 32,
    "Too many attributes",
  ),
  bounds: previewElementBoundsSchema,
  outerHtml: z.string().max(8192).optional(),
  screenshotId: z.string().max(128).optional(),
  capturedAt: z.string().min(1),
}).strict();
export type PreviewElementContext = z.infer<typeof previewElementContextSchema>;

/** Format element context as readable composer text (no secrets; form values omitted upstream). */
export function formatPreviewElementContext(context: PreviewElementContext): string {
  const lines = [
    "Web preview element",
    `URL: ${context.url}`,
    `Element: ${context.tagName}${context.accessibleName ? ` "${context.accessibleName}"` : ""}${context.ref ? ` (${context.ref})` : ""}`,
  ];
  if (context.selector) lines.push(`Selector: ${context.selector}`);
  const bounds = context.bounds;
  lines.push(`Bounds: x=${Math.round(bounds.x)} y=${Math.round(bounds.y)} width=${Math.round(bounds.width)} height=${Math.round(bounds.height)}`);
  if (context.outerHtml) lines.push(`HTML: ${context.outerHtml}`);
  return lines.join("\n");
}
