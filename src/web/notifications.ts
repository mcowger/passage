export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }
  if (Notification.permission === "granted") {
    return true;
  }
  if (Notification.permission !== "denied") {
    const permission = await Notification.requestPermission();
    return permission === "granted";
  }
  return false;
}

export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
  if (!isNotificationSupported()) return "unsupported";
  return Notification.permission;
}

export function showAgentNotification(
  title: string,
  body: string,
  options?: { tag?: string; onClick?: () => void }
): void {
  if (!isNotificationSupported() || Notification.permission !== "granted") {
    return;
  }
  // Only notify if document is hidden / in background
  if (typeof document !== "undefined" && document.visibilityState === "visible") {
    return;
  }

  try {
    const notification = new Notification(title, {
      body,
      icon: "/icon.svg",
      tag: options?.tag ?? "agent-activity",
      badge: "/icon.svg",
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
      options?.onClick?.();
    };
  } catch {}
}
