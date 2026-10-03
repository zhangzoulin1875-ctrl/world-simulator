/// <reference types="vite/client" />

/**
 * 由 vite.config.ts 的 define 注入：正式建置時為該次建置的唯一 id，
 * 開發模式為 "dev"。在非 Vite 環境（如 tsx 測試）下不存在，
 * 使用端必須以 typeof 守門。
 */
declare const __BUILD_ID__: string | undefined;
