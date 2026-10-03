/**
 * Raw Discord OAuth2 helpers (scopes: identify + guilds). Reuses the existing
 * Discord application (same app as DISCORD_BOT_TOKEN). Requires the secrets
 * DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET. We never persist Discord access
 * tokens — we only use them transiently to read the user + their guilds, then
 * snapshot the manageable guild ids into our own session.
 */

const DISCORD_API = "https://discord.com/api/v10";
const OAUTH_AUTHORIZE = "https://discord.com/oauth2/authorize";
const OAUTH_TOKEN = "https://discord.com/api/oauth2/token";

export const DISCORD_OAUTH_SCOPES = ["identify", "guilds"] as const;

// Discord "Manage Guild" permission bit.
const MANAGE_GUILD = 0x20n;

export function getOAuthConfig(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isOAuthConfigured(): boolean {
  return getOAuthConfig() !== null;
}

export function buildAuthorizeUrl(opts: {
  redirectUri: string;
  state: string;
}): string | null {
  const cfg = getOAuthConfig();
  if (!cfg) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: DISCORD_OAUTH_SCOPES.join(" "),
    state: opts.state,
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<DiscordTokenResponse> {
  const cfg = getOAuthConfig();
  if (!cfg) throw new Error("Discord OAuth not configured");
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as DiscordTokenResponse;
}

export interface DiscordUser {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
}

export async function fetchUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Discord user (${res.status})`);
  }
  const j = (await res.json()) as Record<string, unknown>;
  return {
    id: String(j["id"] ?? ""),
    username: String(j["username"] ?? ""),
    globalName: (j["global_name"] as string | null) ?? null,
    avatar: (j["avatar"] as string | null) ?? null,
  };
}

export interface DiscordPartialGuild {
  id: string;
  name: string;
  owner: boolean;
  permissions: string;
}

export async function fetchUserGuilds(
  accessToken: string,
): Promise<DiscordPartialGuild[]> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Discord guilds (${res.status})`);
  }
  const arr = (await res.json()) as Array<Record<string, unknown>>;
  return arr.map((g) => ({
    id: String(g["id"] ?? ""),
    name: String(g["name"] ?? ""),
    owner: Boolean(g["owner"]),
    permissions: String(g["permissions"] ?? "0"),
  }));
}

/**
 * A user "manages" a guild when they are the owner or hold the Manage Guild
 * permission bit. Returns the ids of all such guilds.
 */
export function computeManageableGuildIds(
  guilds: DiscordPartialGuild[],
): string[] {
  const out: string[] = [];
  for (const g of guilds) {
    if (!g.id) continue;
    if (g.owner) {
      out.push(g.id);
      continue;
    }
    let perms: bigint;
    try {
      perms = BigInt(g.permissions);
    } catch {
      perms = 0n;
    }
    if ((perms & MANAGE_GUILD) === MANAGE_GUILD) {
      out.push(g.id);
    }
  }
  return out;
}
