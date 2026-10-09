// Cloudflare Pages Function:/api/* 全部轉給 Render;靜態檔與前端路由仍由 Pages 直送(不吃 Render 頻寬)。
// 保留使用者實際網域(X-Forwarded-Host / Proto),後端用它組 Discord OAuth 回調網址與 CSRF 同源比對。
const ORIGIN = "https://world-simulator-z5qu.onrender.com";

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, ORIGIN);

  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", "https");

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });

  // 後端若 302 到 Render 自己的網域,改寫回目前網域,避免使用者被帶離。
  const res = new Response(upstream.body, upstream);
  const loc = res.headers.get("location");
  if (loc && loc.startsWith(ORIGIN)) {
    res.headers.set("location", loc.replace(ORIGIN, url.origin));
  }
  return res;
}
