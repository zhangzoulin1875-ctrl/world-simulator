import { Router, type IRouter, type Request } from "express";
import { randomBytes } from "node:crypto";
import { logger } from "../lib/logger";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUser,
  fetchUserGuilds,
  computeManageableGuildIds,
  isOAuthConfigured,
} from "../lib/discordOAuth";
import {
  createSession,
  deleteSession,
  getSession,
  readSessionToken,
  setSessionCookie,
  clearSessionCookie,
  OAUTH_STATE_COOKIE_NAME,
} from "../lib/sessions";
import { isAccountBanned } from "../lib/accountBans";

const router: IRouter = Router();

function buildRedirectUri(req: Request): string {
  // `req.protocol` honors X-Forwarded-Proto when trust proxy is enabled, and
  // `req.get("host")` returns the proxied app domain — so this naturally
  // matches whichever domain (dev or prod) the user is on. The matching URI
  // must be registered in the Discord Developer Portal.
  const proto = req.protocol;
  const host = req.get("host");
  return `${proto}://${host}/api/auth/discord/callback`;
}

/** Minimal HTML page shown to the new tab after the OAuth dance completes. */
function renderCallbackPage(opts: { ok: boolean; message: string }): string {
  const payload = JSON.stringify({ type: "discord-auth", ok: opts.ok });
  return `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discord 登入</title>
<style>
  body { font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif; background:#0b0b0f; color:#e7e7ea; display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
  .card { text-align:center; padding:32px 40px; }
  .ok { color:#8ef5b5; } .err { color:#f59e9e; }
  button { margin-top:16px; padding:8px 18px; border-radius:8px; border:0; background:#5865f2; color:#fff; font-size:14px; cursor:pointer; }
</style>
</head>
<body>
  <div class="card">
    <h2 class="${opts.ok ? "ok" : "err"}">${opts.ok ? "登入成功" : "登入失敗"}</h2>
    <p>${opts.message}</p>
    <button onclick="window.close()">關閉視窗</button>
  </div>
  <script>
    try { if (window.opener) window.opener.postMessage(${payload}, "*"); } catch (e) {}
    setTimeout(function(){ try { window.close(); } catch (e) {} }, 1200);
  </script>
</body>
</html>`;
}

router.get("/auth/discord/login", (req, res) => {
  if (!isOAuthConfigured()) {
    res.status(503).json({ error: "Discord 登入尚未設定（缺少 OAuth 憑證）" });
    return;
  }
  const state = randomBytes(16).toString("hex");
  const url = buildAuthorizeUrl({ redirectUri: buildRedirectUri(req), state });
  if (!url) {
    res.status(503).json({ error: "Discord 登入尚未設定" });
    return;
  }
  // State cookie is only needed during the top-level OAuth dance; Lax lets it
  // ride along the cross-site redirect back from discord.com.
  res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });
  res.redirect(url);
});

router.get("/auth/discord/callback", async (req, res) => {
  const sendPage = (status: number, ok: boolean, message: string) => {
    res
      .status(status)
      .set("content-type", "text/html; charset=utf-8")
      .send(renderCallbackPage({ ok, message }));
  };

  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const cookies = (req as Request & { cookies?: Record<string, unknown> })
      .cookies;
    const expectedState = cookies?.[OAUTH_STATE_COOKIE_NAME];
    res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });

    if (req.query.error) {
      sendPage(400, false, "已取消授權或發生錯誤。");
      return;
    }
    if (!code || !state || !expectedState || state !== expectedState) {
      sendPage(400, false, "驗證失敗（state 不符），請重新登入。");
      return;
    }

    const token = await exchangeCode({
      code,
      redirectUri: buildRedirectUri(req),
    });
    const [user, guilds] = await Promise.all([
      fetchUser(token.access_token),
      fetchUserGuilds(token.access_token),
    ]);
    const manageableGuildIds = computeManageableGuildIds(guilds);

    if (await isAccountBanned(user.id)) {
      sendPage(403, false, "此帳號已被封禁，無法登入。");
      return;
    }

    const sessionToken = await createSession({
      discordUserId: user.id,
      username: user.username,
      globalName: user.globalName,
      avatar: user.avatar,
      manageableGuildIds,
    });
    setSessionCookie(res, sessionToken);
    sendPage(200, true, "您已成功以 Discord 登入，可以關閉此視窗。");
  } catch (err) {
    logger.error({ err }, "Discord OAuth callback failed");
    sendPage(500, false, "登入過程發生錯誤，請稍後再試。");
  }
});

router.post("/auth/logout", async (req, res) => {
  const token = readSessionToken(req);
  await deleteSession(token).catch(() => {});
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/auth/me", async (req, res) => {
  const session = await getSession(readSessionToken(req));
  if (!session) {
    res.json({ authenticated: false, user: null });
    return;
  }
  res.json({
    authenticated: true,
    user: {
      discordUserId: session.discordUserId,
      username: session.username,
      globalName: session.globalName,
      avatar: session.avatar,
    },
  });
});

export default router;
