import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";

/**
 * Current Discord login session. Backed by the DB-session cookie (sent
 * automatically). Refetches on window focus so returning from the OAuth
 * popup picks up the new session even without the postMessage signal.
 */
export function useCurrentUser() {
  return useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      staleTime: 1000 * 30,
      refetchOnWindowFocus: true,
    },
  });
}

/** Open the Discord OAuth flow in a top-level popup (Discord refuses iframes). */
export function startDiscordLogin(): void {
  if (typeof window === "undefined") return;
  const url = `${window.location.origin}/api/auth/discord/login`;
  window.open(url, "discord-login", "width=520,height=760");
}

export function discordAvatarUrl(
  userId: string,
  avatar: string | null,
): string | null {
  if (!avatar) return null;
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=64`;
}
