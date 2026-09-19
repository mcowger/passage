/** Web Push client helpers (standards-based: iOS Home Screen PWA + Android/desktop). */

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** iOS authoritative standalone check; falls back to display-mode. */
export function isInstalledPwa(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (typeof nav.standalone === "boolean") return nav.standalone;
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
}

export function isIos(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(base64.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) throw new Error("Service workers are not supported");
  // Ensure the SW is registered (production registers on boot; subscribe
  // flows must not depend on that timing).
  let registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) {
    registration = await navigator.serviceWorker.register("/sw.js");
  }
  await navigator.serviceWorker.ready;
  return registration;
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await readyRegistration();
  return registration.pushManager.getSubscription();
}

export async function subscribePush(vapidPublicKey: string): Promise<PushSubscription> {
  const registration = await readyRegistration();
  // iOS ignores non-gesture permission prompts: callers must invoke this
  // from a tap/click handler with no intervening await before requestPermission.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(`Notification permission is ${permission}`);
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
  });
}

export async function unsubscribePush(): Promise<boolean> {
  const subscription = await getPushSubscription();
  if (!subscription) return true;
  const endpoint = subscription.endpoint;
  const ok = await subscription.unsubscribe();
  // Best-effort server prune; local unsubscribe already succeeded.
  try {
    await fetch("/api/push/subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch {}
  return ok;
}

export async function persistSubscription(subscription: PushSubscription, label?: string): Promise<void> {
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) throw new Error("Invalid push subscription");
  const response = await fetch("/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, ...(label ? { label } : {}) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: string; message?: string } | undefined;
    throw new Error(body?.message ?? body?.error ?? "Failed to save push subscription");
  }
}
