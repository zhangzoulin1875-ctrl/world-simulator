import { logger } from "./logger";
import { buildIndex, parseTarGz, type CodeIndex } from "./supportCodeIndex";

/**
 * 客服程式碼索引的來源與快取：
 *  - 預設讀公開 repo（SUPPORT_GITHUB_REPO，格式 owner/name；SUPPORT_GITHUB_REF 預設 main）。
 *  - 私有 repo 設 SUPPORT_GITHUB_TOKEN（只需唯讀 Contents 權限）。
 *  - 啟動後背景載入；之後每 30 分鐘問一次最新 commit sha，沒變就不重抓。
 *  - 抓取失敗沿用舊索引（不會因為 GitHub 暫時掛了讓客服失明）。
 */
const DEFAULT_REPO = "zhangzoulin1875-ctrl/world-simulator";
const REFRESH_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;

let current: CodeIndex | null = null;
let loading: Promise<CodeIndex | null> | null = null;
let timer: NodeJS.Timeout | null = null;

function repoCfg() {
  return {
    repo: process.env.SUPPORT_GITHUB_REPO?.trim() || DEFAULT_REPO,
    ref: process.env.SUPPORT_GITHUB_REF?.trim() || "main",
    token: process.env.SUPPORT_GITHUB_TOKEN?.trim() || null,
  };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const { token } = repoCfg();
  return {
    "User-Agent": "world-simulator-support-bot",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function fetchLatestSha(): Promise<string> {
  const { repo, ref } = repoCfg();
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: headers({ Accept: "application/vnd.github.sha" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub commit 查詢失敗 HTTP ${res.status}`);
  return (await res.text()).trim();
}

async function fetchTarball(): Promise<Buffer> {
  const { repo, ref } = repoCfg();
  const res = await fetch(`https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(ref)}`, {
    headers: headers({ Accept: "application/vnd.github+json" }),
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub tarball 下載失敗 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 重新整理索引（commit 沒變就跳過）。永不丟錯：失敗回傳現有索引。 */
export async function refreshCodeIndex(force = false): Promise<CodeIndex | null> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const sha = await fetchLatestSha();
      if (!force && current && current.commit === sha) return current;
      const files = parseTarGz(await fetchTarball());
      if (files.size === 0) throw new Error("tarball 內沒有可索引的檔案");
      current = buildIndex(files, sha);
      logger.info({ files: current.fileCount, chunks: current.chunks.length, commit: sha.slice(0, 7) }, "support code index built");
    } catch (err) {
      logger.warn({ err }, "support code index refresh failed (keeping previous index)");
    }
    return current;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** 取目前索引；還沒載入過就等第一次載入（有逾時，不會卡住客服）。 */
export async function getCodeIndex(): Promise<CodeIndex | null> {
  if (current) return current;
  return refreshCodeIndex();
}

export function startCodeIndexRefresh(): void {
  if (timer) return;
  void refreshCodeIndex();
  timer = setInterval(() => void refreshCodeIndex(), REFRESH_MS);
  timer.unref();
}

export function getCodeIndexInfo(): { ready: boolean; files: number; chunks: number; commit: string | null; ageMin: number | null } {
  return {
    ready: !!current,
    files: current?.fileCount ?? 0,
    chunks: current?.chunks.length ?? 0,
    commit: current?.commit.slice(0, 7) ?? null,
    ageMin: current ? Math.round((Date.now() - current.builtAt) / 60000) : null,
  };
}

/** 測試用。 */
export function __setCodeIndexForTest(idx: CodeIndex | null): void {
  current = idx;
}
