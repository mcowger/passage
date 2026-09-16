import { useCallback, useEffect, useRef, useState } from "react";
import type { WebPreview } from "../../shared/domain/previews.ts";
import type { PreviewFrameMessage, PreviewUpstreamMessage } from "../../shared/protocol/previews.ts";
import { friendlyApiError, type WorkspaceApi } from "../api.ts";
import { connectPreviewSocket, type PreviewSocket } from "../previewSocket.ts";
import { Button } from "./ui/button.tsx";

type PreviewPanelProps = {
  preview: WebPreview;
  api: WorkspaceApi;
  onPreviewChanged: (preview: WebPreview) => void;
  onClose: () => void;
};

type StreamState =
  | "starting"
  | "connecting"
  | "ready"
  | "view-only"
  | "stopped"
  | "target-unavailable"
  | "browser-crashed"
  | "reconnecting";

const RECONNECT_DELAY_MS = 800;

export function PreviewPanel({ preview, api, onPreviewChanged, onClose }: PreviewPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<PreviewSocket | null>(null);
  const frameRef = useRef<PreviewFrameMessage | null>(null);
  const lastAckRef = useRef<number>(-1);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);

  const [streamState, setStreamState] = useState<StreamState>(
    preview.status === "ready" ? "connecting" : preview.status === "error" ? "browser-crashed" : "stopped",
  );
  const [hasLease, setHasLease] = useState(preview.hasInputLease ?? false);
  const [address, setAddress] = useState(preview.currentUrl ?? preview.targetUrl);
  const [notice, setNotice] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);

  const drawFrame = useCallback((frame: PreviewFrameMessage) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const image = new Image();
    image.onload = () => {
      if (unmounted.current) return;
      // Preserve the remote viewport's aspect ratio; never stretch coordinates.
      canvas.width = frame.metadata.deviceWidth;
      canvas.height = frame.metadata.deviceHeight;
      const context = canvas.getContext("2d");
      context?.drawImage(image, 0, 0);
      setFrameSize({ width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight });
      URL.revokeObjectURL(image.src);
      // Forward the ack only after decode+draw, preserving latest-frame-wins
      // across both hops.
      if (frame.seq !== lastAckRef.current) {
        lastAckRef.current = frame.seq;
        socketRef.current?.ack(frame.seq);
      }
    };
    image.onerror = () => URL.revokeObjectURL(image.src);
    try {
      const bytes = Uint8Array.from(atob(frame.data), (c) => c.charCodeAt(0));
      image.src = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "image/jpeg" }));
    } catch {}
  }, []);

  const reconcile = useCallback(async (): Promise<WebPreview | null> => {
    try {
      const snapshot = await api.getPreview(preview.id);
      if (unmounted.current) return null;
      onPreviewChanged(snapshot);
      setAddress(snapshot.currentUrl ?? snapshot.targetUrl);
      if (snapshot.status === "ready") {
        setStreamState((current) => (current === "ready" || current === "view-only" ? current : "connecting"));
      } else if (snapshot.status === "error") {
        setStreamState("browser-crashed");
      } else if (snapshot.status === "stopped") {
        setStreamState("stopped");
      }
      return snapshot;
    } catch {
      return null;
    }
  }, [api, preview.id, onPreviewChanged]);

  const connect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    setStreamState((current) => (current === "starting" ? current : "connecting"));
    const socket = connectPreviewSocket(preview.id, {
      onMessage: (message: PreviewUpstreamMessage) => {
        if (message.type === "frame") {
          // Latest-frame-wins: render only the newest frame.
          const previous = frameRef.current;
          if (previous && previous.seq > message.seq) {
            socket.ack(message.seq);
            return;
          }
          frameRef.current = message;
          drawFrame(message);
          setStreamState((current) => (current === "view-only" ? "view-only" : "ready"));
        } else if (message.type === "url") {
          void reconcile();
        }
      },
      onErrorMessage: (text) => {
        setNotice(text);
        if (/not running/i.test(text)) setStreamState("stopped");
      },
      onOpen: () => setStreamState((current) => (current === "reconnecting" ? "connecting" : current)),
      onClose: (reconnect) => {
        if (unmounted.current || !reconnect) return;
        setStreamState("reconnecting");
        // Reconcile navigation state through HTTP, then resume at newest frame.
        void reconcile();
        if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
        reconnectTimer.current = setTimeout(() => {
          if (!unmounted.current) connect();
        }, RECONNECT_DELAY_MS);
      },
    });
    socketRef.current = socket;
  }, [preview.id, drawFrame, reconcile]);

  useEffect(() => {
    unmounted.current = false;
    // Reconcile on mount: the preview may have started (or stopped) elsewhere
    // while this pane was open. If it is ready, attach the live stream.
    void reconcile().then((snapshot) => {
      if (!unmounted.current && snapshot?.status === "ready") connect();
    });
    if (preview.status === "error") {
      setStreamState("browser-crashed");
    }
    const handleOnline = () => {
      void reconcile();
      if (preview.status === "ready") connect();
    };
    const handleVisible = () => {
      if (document.visibilityState === "visible") void reconcile();
    };
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      unmounted.current = true;
      window.removeEventListener("online", handleOnline);
      document.removeEventListener("visibilitychange", handleVisible);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.id]);

  const mutate = useCallback(async (work: () => Promise<WebPreview>, failure: string) => {
    try {
      setNotice(null);
      const updated = await work();
      onPreviewChanged(updated);
      setAddress(updated.currentUrl ?? updated.targetUrl);
      return updated;
    } catch (cause) {
      setNotice(friendlyApiError(cause, failure));
      return null;
    }
  }, [onPreviewChanged]);

  const handleOpen = useCallback(async () => {
    setStreamState("starting");
    const updated = await mutate(() => api.openPreview(preview.id), "Failed to start preview");
    if (updated?.status === "ready") connect();
    else if (updated) setStreamState(updated.status === "error" ? "browser-crashed" : "target-unavailable");
    else setStreamState("target-unavailable");
  }, [api, preview.id, mutate, connect]);

  const handleStop = useCallback(async () => {
    socketRef.current?.close();
    socketRef.current = null;
    frameRef.current = null;
    await mutate(() => api.stopPreview(preview.id), "Failed to stop preview");
    setStreamState("stopped");
    setHasLease(false);
  }, [api, preview.id, mutate]);

  const handleNavigate = useCallback(async () => {
    const updated = await mutate(() => api.navigatePreview(preview.id, address), "Navigation failed");
    if (updated?.status === "error") setStreamState("target-unavailable");
  }, [api, preview.id, address, mutate]);

  const handleTakeControl = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;
    try {
      const updated = await api.takePreviewLease(preview.id, socket.clientId);
      onPreviewChanged(updated);
      setHasLease(updated.hasInputLease ?? true);
      setStreamState("ready");
    } catch (cause) {
      setNotice(friendlyApiError(cause, "Could not take control"));
    }
  }, [api, preview.id, onPreviewChanged]);

  const toPageCoordinates = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    // Map through the displayed size back to remote CSS pixels.
    const x = ((event.clientX - rect.left) / rect.width) * frame.metadata.deviceWidth;
    const y = ((event.clientY - rect.top) / rect.height) * frame.metadata.deviceHeight;
    return { x: Math.round(x), y: Math.round(y) };
  }, []);

  const canInteract = streamState === "ready" && hasLease;

  const sendMouse = (eventType: string, event: React.PointerEvent<HTMLCanvasElement>, extra?: { button?: string; clickCount?: number }) => {
    if (!canInteract) return;
    const point = toPageCoordinates(event);
    if (!point) return;
    socketRef.current?.send({ type: "input_mouse", eventType, x: point.x, y: point.y, ...extra });
  };

  const overlay = streamState !== "ready" && streamState !== "view-only";

  return (
    <div className="flex h-full flex-col" data-testid="preview-panel">
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1" role="toolbar" aria-label="Preview controls">
        <Button size="xs" variant="ghost" title="Back" onClick={() => void mutate(() => api.previewBack(preview.id), "Back failed")} disabled={preview.status !== "ready"}>←</Button>
        <Button size="xs" variant="ghost" title="Forward" onClick={() => void mutate(() => api.previewForward(preview.id), "Forward failed")} disabled={preview.status !== "ready"}>→</Button>
        <Button size="xs" variant="ghost" title="Reload" onClick={() => void mutate(() => api.previewReload(preview.id), "Reload failed")} disabled={preview.status !== "ready"}>⟳</Button>
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            void handleNavigate();
          }}
        >
          <input
            className="min-w-0 flex-1 rounded border px-2 py-1 font-mono text-xs"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            aria-label="Preview address"
            spellCheck={false}
          />
        </form>
        <select
          className="rounded border px-1 py-1 text-xs"
          value={`${preview.viewport.width}x${preview.viewport.height}`}
          onChange={(event) => {
            const [width, height] = event.target.value.split("x").map(Number);
            void mutate(() => api.setPreviewViewport(preview.id, { width, height }), "Viewport change failed");
          }}
          title="Viewport size"
          aria-label="Viewport size"
        >
          {["1280x800", "1440x900", "390x844", "360x740"].map((preset) => (
            <option key={preset} value={preset}>{preset}</option>
          ))}
          {!(["1280x800", "1440x900", "390x844", "360x740"].includes(`${preview.viewport.width}x${preview.viewport.height}`)) && (
            <option value={`${preview.viewport.width}x${preview.viewport.height}`}>{`${preview.viewport.width}x${preview.viewport.height}`}</option>
          )}
        </select>
        {hasLease ? (
          <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700" title="This client holds the input lease">In control</span>
        ) : (
          <Button size="xs" variant="secondary" onClick={() => void handleTakeControl()} disabled={preview.status !== "ready"} title="Take the input and viewport lease">Take control</Button>
        )}
        {preview.status === "ready" ? (
          <Button size="xs" variant="ghost" onClick={() => void handleStop()} title="Stop this preview">Stop</Button>
        ) : (
          <Button size="xs" onClick={() => void handleOpen()} title="Start this preview">Start</Button>
        )}
        <Button size="xs" variant="ghost" onClick={onClose} title="Close preview pane (preview keeps running)">✕</Button>
      </div>

      {notice && (
        <div className="border-b bg-amber-500/10 px-3 py-1 text-xs text-amber-800" role="status">{notice}</div>
      )}

      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black/90">
        <canvas
          ref={canvasRef}
          className="max-h-full max-w-full touch-none select-none"
          style={{ aspectRatio: frameSize ? `${frameSize.width} / ${frameSize.height}` : undefined }}
          onPointerMove={(event) => {
            if (event.buttons === 0) return;
            sendMouse("mouseMoved", event);
          }}
          onPointerDown={(event) => {
            (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
            sendMouse("mousePressed", event, { button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left", clickCount: 1 });
          }}
          onPointerUp={(event) => sendMouse("mouseReleased", event, { button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left", clickCount: 1 })}
          onWheel={(event) => {
            if (!canInteract) return;
            const point = toPageCoordinates(event as unknown as React.PointerEvent<HTMLCanvasElement>);
            if (!point) return;
            socketRef.current?.send({ type: "input_mouse", eventType: "mouseWheel", x: point.x, y: point.y, deltaY: Math.round(event.deltaY) });
          }}
          onKeyDown={(event) => {
            if (!canInteract) return;
            socketRef.current?.send({ type: "input_keyboard", eventType: "keyDown", key: event.key, text: event.key.length === 1 ? event.key : undefined });
            if (event.key.length === 1) event.preventDefault();
          }}
          onKeyUp={(event) => {
            if (!canInteract) return;
            socketRef.current?.send({ type: "input_keyboard", eventType: "keyUp", key: event.key });
          }}
          tabIndex={0}
          role="application"
          aria-label={`Web preview of ${preview.targetUrl}`}
        />
        {overlay && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 p-4 text-center" role="status">
            <span className="text-sm font-medium text-white">
              {streamState === "starting" && "Starting preview…"}
              {streamState === "connecting" && "Connecting to preview…"}
              {streamState === "reconnecting" && "Reconnecting…"}
              {streamState === "stopped" && "Preview is stopped"}
              {streamState === "target-unavailable" && "Target unavailable"}
              {streamState === "browser-crashed" && "Browser is unavailable"}
            </span>
            <span className="max-w-md font-mono text-xs text-white/70">{preview.targetUrl}</span>
            {(streamState === "stopped" || streamState === "target-unavailable" || streamState === "browser-crashed") && (
              <Button size="xs" onClick={() => void handleOpen()}>Start preview</Button>
            )}
          </div>
        )}
        {!overlay && !hasLease && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/70 px-3 py-1 text-xs text-white" role="status">
            View only — Take control to interact
          </div>
        )}
      </div>
    </div>
  );
}
