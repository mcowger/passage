import type { UserFileRef, UserImageRef } from "../../shared/domain/agents.ts";
import { type AgentFile, type AgentImage } from "../../shared/protocol/agents.ts";

type NamedImage = AgentImage & { name: string };

/** Placeholder message when the draft is empty but attachments are present. */
export function attachmentLabel(value: string, images: NamedImage[], files: AgentFile[]): string {
  if (value) return value;
  if (images.length > 0) return "Attached image";
  if (files.length > 0) return `Attached file: ${files.map((file) => file.name).join(", ")}`;
  return "";
}

/** Strip the composer-local name field for the wire payload; undefined when empty. */
export function toPayloadImages(images: NamedImage[]): AgentImage[] | undefined {
  if (images.length === 0) return undefined;
  return images.map(({ type, data, mimeType, name }) => ({ type, data, mimeType, name }));
}

export function toPayloadFiles(files: AgentFile[]): AgentFile[] | undefined {
  if (files.length === 0) return undefined;
  return files.map(({ type, data, mimeType, name }) => ({ type, data, mimeType, name }));
}

/**
 * Instant pre-echo refs: the daemon hasn't hashed/cached these yet, so the
 * optimistic row carries data URLs and no hashes; the real row_upsert (with
 * cache refs) replaces this row when it arrives. File paths are unknown
 * until the daemon writes them, so the pre-echo uses the plain filename as
 * a placeholder path.
 */
export function toOptimisticImages(images: NamedImage[]): UserImageRef[] | undefined {
  if (images.length === 0) return undefined;
  return images.map(({ mimeType, name, data }) => ({
    hash: "",
    mimeType,
    name,
    previewUrl: `data:${mimeType};base64,${data}`,
  }));
}

export function toOptimisticFiles(files: AgentFile[]): UserFileRef[] | undefined {
  if (files.length === 0) return undefined;
  return files.map(({ name, mimeType, data }) => ({
    hash: "",
    name,
    path: name,
    size: Math.floor((data.length * 3) / 4),
    mimeType,
  }));
}

export function readAsBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function isSupportedImage(mimeType: string): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(mimeType);
}

/** Extension fallback for a pasted clipboard file that carries no name
 *  (screenshots and copied web images routinely arrive nameless). Matches
 *  the image/file split in `useComposerAttachments.addAttachments` so the
 *  payload name always satisfies the wire schema. */
function pastedFallbackName(mimeType: string, index: number): string {
  const normalized = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
  if (isSupportedImage(normalized)) {
    const extension = normalized === "image/jpeg" ? "jpg" : normalized.slice("image/".length);
    return `pasted-image-${index + 1}.${extension}`;
  }
  if (mimeType) {
    const subtype = mimeType.split("/").at(-1)?.split(";")[0]?.trim();
    if (subtype) return `pasted-file-${index + 1}.${subtype}`;
  }
  return `pasted-file-${index + 1}`;
}

/** Clipboard `File`s may carry an empty name; give each nameless file a
 *  stable fallback so attachment chips, optimistic rows, and the wire
 *  payload never see an empty name. Named files pass through untouched. */
export function withPastedFileNames(files: File[]): File[] {
  return files.map((file, index) => {
    if (file.name?.trim()) return file;
    try {
      return new File([file], pastedFallbackName(file.type, index), {
        type: file.type,
        lastModified: file.lastModified,
      });
    } catch {
      return file;
    }
  });
}

type ClipboardItemLike = { kind: string; getAsFile: () => File | null };
type ClipboardDataLike = {
  files?: FileList | File[] | null;
  items?: ArrayLike<ClipboardItemLike> | null;
};

/** Files carried by a paste event. Prefers `clipboardData.files` (populated
 *  for copied files/screenshots); falls back to `clipboardData.items` for
 *  browsers that only expose the image as an item. Returns [] for text-only
 *  pastes. */
export function extractPastedFiles(clipboard: ClipboardDataLike | null | undefined): File[] {
  if (!clipboard) return [];
  const fromFiles = clipboard.files ? Array.from(clipboard.files) : [];
  if (fromFiles.length > 0) return withPastedFileNames(fromFiles);
  if (!clipboard.items) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(clipboard.items)) {
    if (item?.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return withPastedFileNames(fromItems);
}
