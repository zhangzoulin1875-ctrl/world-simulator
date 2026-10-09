// 靜態檔由 Cloudflare 直接送出(不吃 Render 頻寬);只有 /api/* 會進到這個 Worker,再轉給 Render。
// 重點:保留使用者實際看到的網域(X-Forwarded-Host / Proto),後端用它組 Discord OAuth 回調網址與 cookie。
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = new URL(env.ORIGIN);
    const target = new URL(url.pathname + url.search, origin);

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
    if (loc && loc.startsWith(origin.origin)) {
      res.headers.set("location", loc.replace(origin.origin, url.origin));
    }
    return res;
  },
};
