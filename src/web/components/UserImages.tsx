import { useEffect, useState } from "react";
import type { UserFileRef, UserImageRef } from "../../shared/domain/agents.ts";
import type { WorkspaceApi } from "../api.ts";

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** File chips for one user message's uploaded files; links to the download route. */
export function UserFileStrip({ agentId, api, files }: { agentId: string; api: WorkspaceApi; files: UserFileRef[] }) {
  if (files.length === 0) return null;
  return (
    <div className="user-file-strip" aria-label={`${files.length} attached file${files.length > 1 ? "s" : ""}`}>
      {files.map((file) => (
        <a
          key={`${file.hash || file.name}:${file.size}`}
          className="user-file-chip"
          href={file.hash ? api.fileUrl(agentId, file.hash) : undefined}
          download={file.name}
          title={`${file.path} (${formatFileSize(file.size)}, ${file.mimeType})`}
        >
          <span className="user-file-icon" aria-hidden="true">📎</span>
          <code className="user-file-name">{file.name}</code>
          <span className="user-file-size">{formatFileSize(file.size)}</span>
        </a>
      ))}
    </div>
  );
}

export function userImageSrc(api: WorkspaceApi, agentId: string, image: UserImageRef): string {
  return image.previewUrl ?? api.imageUrl(agentId, image.hash);
}

export function UserImageThumb({ src, name, onOpen, expiredText }: { src: string; name: string; onOpen: () => void; expiredText?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="user-image-expired" title={expiredText ?? `${name} is no longer in the image cache`}>
        {expiredText ?? `${name} (expired)`}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="user-image-thumb"
      onClick={onOpen}
      title={`${name} — click to expand`}
      aria-label={`Expand ${name}`}
    >
      <img src={src} alt={name} loading="lazy" onError={() => setFailed(true)} />
    </button>
  );
}

function ImageLightbox({
  agentId,
  api,
  images,
  index,
  onClose,
  onSelect,
}: {
  agentId: string;
  api: WorkspaceApi;
  images: UserImageRef[];
  index: number;
  onClose: () => void;
  onSelect: (index: number) => void;
}) {
  const image = images[index]!;
  return (
    <GenericImageLightbox
      images={images.map((entry) => ({ name: entry.name, src: userImageSrc(api, agentId, entry) }))}
      index={index}
      onClose={onClose}
      onSelect={onSelect}
    />
  );
}

/** Presentation-only lightbox over pre-resolved image URLs. Shared by user
 *  uploads (cache URLs) and model-read workspace images (raw file URLs) so
 *  both get identical preview + keyboard/download behavior. */
export function GenericImageLightbox({
  images,
  index,
  onClose,
  onSelect,
  expiredLabel,
}: {
  images: Array<{ name: string; src: string }>;
  index: number;
  onClose: () => void;
  onSelect: (index: number) => void;
  expiredLabel?: (name: string) => string;
}) {
  const image = images[index]!;
  const src = image.src;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowRight") onSelect((index + 1) % images.length);
      else if (event.key === "ArrowLeft") onSelect((index - 1 + images.length) % images.length);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose, onSelect]);

  return (
    <div
      className="image-lightbox-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${image.name}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="image-lightbox">
        <div className="image-lightbox-bar">
          <span className="image-lightbox-name" title={image.name}>
            {image.name}
            {images.length > 1 ? ` (${index + 1} of ${images.length})` : ""}
          </span>
          <span className="image-lightbox-actions">
            {images.length > 1 && (
              <>
                <button type="button" onClick={() => onSelect((index - 1 + images.length) % images.length)} aria-label="Previous image">‹</button>
                <button type="button" onClick={() => onSelect((index + 1) % images.length)} aria-label="Next image">›</button>
              </>
            )}
            {!failed && (
              <a href={src} download={image.name} aria-label={`Download ${image.name}`}>
                ⤓
              </a>
            )}
            <button type="button" onClick={onClose} aria-label="Close preview">✕</button>
          </span>
        </div>
        {failed
          ? <p className="image-lightbox-expired">{expiredLabel ? expiredLabel(image.name) : `${image.name} is no longer in the image cache.`}</p>
          : <img src={src} alt={image.name} className="image-lightbox-img" onError={() => setFailed(true)} />}
      </div>
    </div>
  );
}

/** Thumbnail strip for one user message's uploaded images; click expands into a lightbox. */
export function UserImageStrip({ agentId, api, images }: { agentId: string; api: WorkspaceApi; images: UserImageRef[] }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  if (images.length === 0) return null;
  return (
    <>
      <div className="user-image-strip" aria-label={`${images.length} attached image${images.length > 1 ? "s" : ""}`}>
        {images.map((image, position) => (
          <UserImageThumb
            key={`${image.hash || "optimistic"}:${position}`}
            src={userImageSrc(api, agentId, image)}
            name={image.name}
            onOpen={() => setLightbox(position)}
          />
        ))}
      </div>
      {lightbox !== null && images[lightbox] && (
        <ImageLightbox
          agentId={agentId}
          api={api}
          images={images}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onSelect={setLightbox}
        />
      )}
    </>
  );
}
