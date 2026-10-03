import { defineConfig, type PluginOption, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

export default defineConfig(async ({ command }): Promise<UserConfig> => {
  const isServe = command === "serve";

  const rawPort = process.env.PORT;

  // PORT / BASE_PATH are only required when actually serving (dev / preview).
  // A plain `vite build` (e.g. during deployment, which builds every workspace
  // package) has no PORT assigned, so fall back instead of throwing.
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
    mockupPreviewPlugin(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
  ];

  if (process.env.NODE_ENV !== "production" && process.env.REPL_ID !== undefined) {
    const { cartographer } = await import("@replit/vite-plugin-cartographer");
    plugins.push(cartographer({ root: path.resolve(import.meta.dirname, "..") }));
  }

  return {
  base: basePath ?? "/",
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist"),
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
