import { defineConfig, type PluginOption, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig(async ({ command }): Promise<UserConfig> => {
  const isServe = command === "serve";

  const rawPort = process.env.PORT;

  // PORT / BASE_PATH are only required when actually serving (dev / preview).
  // A plain `vite build` (e.g. during deployment) has no PORT assigned, so
  // fall back instead of throwing, which would otherwise break the build.
  if (isServe && !rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = rawPort ? Number(rawPort) : 5173;

  if (isServe && (Number.isNaN(port) || port <= 0)) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const basePath = process.env.BASE_PATH;

  if (isServe && !basePath) {
    throw new Error(
      "BASE_PATH environment variable is required but was not provided.",
    );
  }

  const plugins: PluginOption[] = [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
  ];

  if (process.env.NODE_ENV !== "production" && process.env.REPL_ID !== undefined) {
    const { cartographer } = await import("@replit/vite-plugin-cartographer");
    plugins.push(cartographer({ root: path.resolve(import.meta.dirname, "..") }));
    const { devBanner } = await import("@replit/vite-plugin-dev-banner");
    plugins.push(devBanner());
  }

  return {
  base: basePath ?? "/",
  // 每次正式建置產生新的 build id，讓持久化查詢快取在部署後自動作廢，
  // 避免舊版格式的快取被新版程式還原而導致頁面崩潰。開發模式固定為 "dev"。
  define: {
    __BUILD_ID__: JSON.stringify(isServe ? "dev" : Date.now().toString(36)),
  },
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
  };
});
