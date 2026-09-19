import { useEffect, useRef, useState } from "react";

/**
 * Per-agent composer draft backed by localStorage. Drafts are keyed by
 * agent, restored on mount, reset on agent switch, persisted on a debounce,
 * and cleared explicitly after send/queue.
 */
export function useComposerDraft(agentId: string) {
  const draftKey = `passage:agent:${agentId}:draft`;
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey) ?? "");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(localStorage.getItem(draftKey) ?? "");
  }, [draftKey]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  const updateDraft = (value: string) => {
    setDraft(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      localStorage.setItem(draftKey, value);
    }, 250);
  };

  const clearDraft = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setDraft("");
    localStorage.removeItem(draftKey);
  };

  return { draftKey, draft, updateDraft, clearDraft };
}
