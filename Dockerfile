# ── 建置階段 ─────────────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN corepack enable

# 先複製 lockfile 相關檔案以利用 Docker 快取
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY artifacts ./artifacts
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile
# 完整建置（含 typecheck + 前後端 build）
RUN pnpm run build

# ── 執行階段 ─────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    STATIC_DIR=/app/public

# server 是自帶依賴的 esbuild bundle，只需複製 dist
COPY --from=build /app/artifacts/api-server/dist ./dist
# 前端靜態檔（SPA）
COPY --from=build /app/artifacts/discord-news/dist/public ./public

EXPOSE 10000
CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
