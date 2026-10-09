export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (r.format === "module" || r.format === "module-typescript" || (typeof url === "string" && /\.(tsx?|jsx?)$/.test(url))) {
    const src = typeof r.source === "string" ? r.source : r.source ? Buffer.from(r.source).toString("utf-8") : "";
    if (src.includes("import.meta.env")) {
      const patched = src.replace(/import\.meta\.env/g, "({BASE_URL:'/',MODE:'test',DEV:false,PROD:false,SSR:true})");
      return { ...r, source: patched };
    }
  }
  return r;
}
