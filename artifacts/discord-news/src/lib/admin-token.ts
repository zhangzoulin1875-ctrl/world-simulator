import { useSyncExternalStore } from "react";
import { setAuthTokenGetter } from "@workspace/api-client-react";

const STORAGE_KEY = "discord-news.adminToken";

export function getAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token && token.trim().length > 0) {
      window.localStorage.setItem(STORAGE_KEY, token.trim());
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  notify();
}

const listeners = new Set<() => void>();

export function subscribeAdminToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const l of Array.from(listeners)) l();
}

export function initAdminTokenAuth(): void {
  setAuthTokenGetter(() => getAdminToken());
}

/**
 * React hook returning whether the user currently has an admin token configured.
 * Re-renders when the token is set or cleared. Note: this is a UX gate only; the
 * real authorization boundary is `requireAdmin` on the API.
 */
export function useIsAdmin(): boolean {
  const token = useSyncExternalStore(
    subscribeAdminToken,
    getAdminToken,
    () => null,
  );
  return !!token;
}
