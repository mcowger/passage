import { useEffect, useRef, useState } from "react";
import {
  MAX_AGENT_FILES,
  MAX_AGENT_FILE_DATA_BYTES,
  MAX_AGENT_IMAGES,
  MAX_AGENT_IMAGE_DATA_BYTES,
  type AgentFile,
  type AgentImage,
} from "../../shared/protocol/agents.ts";
import { isSupportedImage, readAsBase64, withPastedFileNames } from "./composerAttachments.ts";

type NamedImage = AgentImage & { name: string };

/**
 * Composer attachment state: staged images/files plus the reservation
 * counters that guard the caps across concurrent attach calls. Resets when
 * the agent switches. Failures report through the injected error sink.
 */
export function useComposerAttachments(agentId: string, onError: (message: string) => void) {
  const [images, setImages] = useState<NamedImage[]>([]);
  const [uploadFiles, setUploadFiles] = useState<AgentFile[]>([]);
  const reservedImageCount = useRef(0);
  const reservedFileCount = useRef(0);

  const resetAttachments = () => {
    setImages([]);
    setUploadFiles([]);
    reservedImageCount.current = 0;
    reservedFileCount.current = 0;
  };

  useEffect(() => {
    resetAttachments();
  }, [agentId]);

  const removeImage = (image: NamedImage) => {
    setImages((current) => current.filter((item) => item !== image));
    reservedImageCount.current -= 1;
  };

  const removeFile = (file: AgentFile) => {
    setUploadFiles((current) => current.filter((item) => item !== file));
    reservedFileCount.current -= 1;
  };

  /** One attach path for everything (button + drag-drop): supported images
   *  ride as model API blocks, all other files land in the shared
   *  attachment cache and are referenced by path in the same message. */
  const addAttachments = async (files: FileList | File[] | null) => {
    if (!files) return;
    // Pasted screenshots/copied images often arrive nameless; give them a
    // stable fallback before the image/file split so both paths satisfy
    // the wire schema and the chips have something to display.
    const selected = withPastedFileNames(Array.from(files));
    const imageCandidates = selected.filter((file) => {
      const normalized = file.type === "image/jpg" ? "image/jpeg" : file.type;
      return isSupportedImage(normalized) && file.size <= MAX_AGENT_IMAGE_DATA_BYTES;
    });
    const fileCandidates = selected.filter((file) => !imageCandidates.includes(file));
    let reservedImages = 0;
    let reservedFiles = 0;
    try {
      if (imageCandidates.length + reservedImageCount.current > MAX_AGENT_IMAGES)
        throw new Error(`Attach at most ${MAX_AGENT_IMAGES} images`);
      if (fileCandidates.length + reservedFileCount.current + uploadFiles.length > MAX_AGENT_FILES)
        throw new Error(`Attach at most ${MAX_AGENT_FILES} files`);
      reservedImageCount.current += imageCandidates.length;
      reservedFileCount.current += fileCandidates.length;
      reservedImages = imageCandidates.length;
      reservedFiles = fileCandidates.length;
      const imageAttachments = await Promise.all(
        imageCandidates.map(async (file) => {
          const mimeType = file.type === "image/jpg" ? "image/jpeg" : file.type;
          const base64 = await readAsBase64(file);
          return {
            type: "image" as const,
            data: base64,
            mimeType: mimeType as AgentImage["mimeType"],
            name: file.name,
          };
        })
      );
      const fileAttachments: AgentFile[] = await Promise.all(
        fileCandidates.map(async (file) => {
          if (file.size > MAX_AGENT_FILE_DATA_BYTES) throw new Error(`${file.name} is too large`);
          if (!file.name.trim()) throw new Error("File is missing a name");
          const base64 = await readAsBase64(file);
          return {
            type: "file" as const,
            data: base64,
            mimeType: file.type || "application/octet-stream",
            name: file.name,
          };
        })
      );
      setImages((current) => {
        const available = MAX_AGENT_IMAGES - current.length;
        if (imageAttachments.length > available) {
          reservedImageCount.current -= imageAttachments.length;
          return current;
        }
        return [...current, ...imageAttachments];
      });
      setUploadFiles((current) => {
        const available = MAX_AGENT_FILES - current.length;
        if (fileAttachments.length > available) {
          reservedFileCount.current -= fileAttachments.length;
          return current;
        }
        return [...current, ...fileAttachments];
      });
      onError("");
    } catch (cause) {
      reservedImageCount.current -= reservedImages;
      reservedFileCount.current -= reservedFiles;
      onError(cause instanceof Error ? cause.message : "Unable to attach file");
    }
  };

  return { images, uploadFiles, addAttachments, removeImage, removeFile, resetAttachments };
}
