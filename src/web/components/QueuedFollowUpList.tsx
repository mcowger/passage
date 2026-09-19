import { Clock, X } from "lucide-react";
import type { QueuedFollowUp } from "./agentPanelState.ts";

/** Attached queue strip rendered directly above the composer input. */
export function QueuedFollowUpList({
  queue,
  disabled,
  onRetract,
  onClear,
}: {
  queue: QueuedFollowUp[];
  disabled?: boolean;
  onRetract: (id: string) => void;
  onClear: () => void;
}) {
  if (queue.length === 0) return null;
  return (
    <div
      className="composer-queue"
      role="group"
      aria-label={`${queue.length} queued follow-up${queue.length === 1 ? "" : "s"}, attached to the composer`}
    >
      <div className="composer-queue-header">
        <span className="composer-queue-title">
          <Clock size={12} aria-hidden="true" />
          Queued · sends when this run settles
        </span>
        {queue.length > 1 && (
          <button type="button" className="composer-queue-clear" onClick={onClear} disabled={disabled}>
            Clear all
          </button>
        )}
      </div>
      <ul className="composer-queue-list">
        {queue.map((item, index) => (
          <li key={item.id} className="composer-queue-item">
            <span className="composer-queue-index" aria-hidden="true">{index + 1}</span>
            <span className="composer-queue-text" title={item.text}>{item.text}</span>
            {item.images.length > 0 && (
              <span
                className="composer-queue-images"
                title={item.images.map((image) => image.name).join(", ")}
              >
                {item.images.length} image{item.images.length === 1 ? "" : "s"}
              </span>
            )}
            {item.files.length > 0 && (
              <span
                className="composer-queue-images"
                title={item.files.map((file) => file.name).join(", ")}
              >
                {item.files.length} file{item.files.length === 1 ? "" : "s"}
              </span>
            )}
            <button
              type="button"
              className="composer-queue-retract"
              onClick={() => onRetract(item.id)}
              disabled={disabled}
              title="Retract this follow-up"
              aria-label={`Retract queued follow-up ${index + 1}`}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
