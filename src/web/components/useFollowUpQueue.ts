import { useEffect, useRef, useState } from "react";
import type { UserFileRef, UserImageRef } from "../../shared/domain/agents.ts";
import type { AgentFile, AgentImage } from "../../shared/protocol/agents.ts";
import { WorkspaceApiError, friendlyApiError, type WorkspaceApi } from "../api.ts";
import {
  createQueuedFollowUp,
  removeQueuedFollowUp,
  type QueuedFollowUp,
} from "./agentPanelState.ts";
import {
  toOptimisticFiles,
  toOptimisticImages,
  toPayloadFiles,
  toPayloadImages,
} from "./composerAttachments.ts";

type NamedImage = AgentImage & { name: string };

export type FollowUpQueueDeps = {
  agentId: string;
  /** True only when the agent status is exactly `idle`: the settle signal that drains the queue. */
  idle: boolean;
  stopping: boolean;
  busy: boolean;
  setBusy: (b: boolean) => void;
  api: WorkspaceApi;
  onOptimisticMessage?: (message: string, images?: UserImageRef[], files?: UserFileRef[]) => void;
  onRefresh: () => Promise<void>;
  onError: (message: string) => void;
};

/**
 * Attached follow-ups enter the chat only once the run settles: while the
 * agent is idle the queue drains in order, starting a new turn with
 * `prompt` and queueing any remainder behind it with `follow_up` (a bare
 * `follow_up` on an idle agent only queues in Pi and never starts a run).
 * A failed send stops the drain, restores the unsent remainder to the
 * front, and surfaces the error -- nothing silently disappears from
 * the queue. The queue is ephemeral and browser-local: switching agents
 * drops it.
 */
export function useFollowUpQueue({
  agentId,
  idle,
  stopping,
  busy,
  setBusy,
  api,
  onOptimisticMessage,
  onRefresh,
  onError,
}: FollowUpQueueDeps) {
  const [queue, setQueue] = useState<QueuedFollowUp[]>([]);
  const dispatchingRef = useRef(false);

  useEffect(() => {
    setQueue([]);
    dispatchingRef.current = false;
  }, [agentId]);

  const enqueueFollowUp = (text: string, images: NamedImage[], files: AgentFile[]) => {
    setQueue((current) => [...current, createQueuedFollowUp(text, images, files)]);
  };

  const retractQueued = (id: string) => {
    if (dispatchingRef.current) return;
    setQueue((current) => removeQueuedFollowUp(current, id));
  };

  const clearQueued = () => {
    if (dispatchingRef.current) return;
    setQueue([]);
  };

  useEffect(() => {
    if (!idle || stopping || busy || dispatchingRef.current || queue.length === 0) return;
    dispatchingRef.current = true;
    setBusy(true);
    onError("");
    void (async () => {
      const pending = [...queue];
      setQueue([]);
      for (const [index, item] of pending.entries()) {
        const imagesArg = toPayloadImages(item.images);
        const filesArg = toPayloadFiles(item.files);
        onOptimisticMessage?.(item.text, toOptimisticImages(item.images), toOptimisticFiles(item.files));
        try {
          // The agent is idle at drain start, so the first item must start a
          // new turn via `prompt`. Anything after it rides behind the now
          // active run via `follow_up` (a sequential `prompt` would 409 as
          // "agent is active").
          if (index === 0) {
            await api.prompt(agentId, item.text, imagesArg, filesArg);
          } else {
            await api.followUp(agentId, item.text, imagesArg, filesArg);
          }
        } catch (cause) {
          const failedIndex = pending.indexOf(item);
          setQueue((current) => [...pending.slice(failedIndex), ...current]);
          onError(friendlyApiError(cause, "Agent command failed"));
          if (cause instanceof WorkspaceApiError && cause.code === "invalid-input") void onRefresh();
          break;
        }
      }
      setBusy(false);
      dispatchingRef.current = false;
    })();
  }, [idle, stopping, busy, queue, agentId, api, onOptimisticMessage, onRefresh, setBusy, onError]);

  return { queue, enqueueFollowUp, retractQueued, clearQueued };
}
