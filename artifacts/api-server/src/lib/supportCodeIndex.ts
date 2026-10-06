import { gunzipSync } from "node:zlib";

/**
 * AI 客服的程式碼檢索（純邏輯＋一個下載函式）。
 *
 * 流程：從 GitHub 下載整個 repo 的 tarball（1 次請求）→ 只留文字原始碼 → 切成
 * 片段建索引（記憶體內）→ 依關鍵字計分取最相關的片段給 AI 當回答依據。
 * 不新增任何依賴：tar 格式用 Node 內建 zlib 自行解析。
 */

export interface CodeChunk {
  path: string;
  /** 1-based 起訖行。 */
  start: number;
  end: number;
  text: string;
  /** 小寫全文（檢索用）。 */
  lower: string;
}

export interface CodeIndex {
  chunks: CodeChunk[];
  fileCount: number;
  commit: string;
  builtAt: number;
}

const INCLUDE_EXT = /\.(ts|tsx|md)$/i;
const EXCLUDE_PATH = /(^|\/)(node_modules|dist|build|\.git|\.local|\.agents|attached_assets|coverage)(\/|$)|(^|\/)\.env|lock\.|\.min\./i;
/** 排除資料量大且對客服無用的檔案（地圖幾何、種子資料）。 */
const EXCLUDE_NOISE = /(geojson|topology|geometry|mapData|regionPaths|seed.*data|\.d\.ts$|\/generated\/|support(Knowledge|Bot|CodeIndex|CodeSource)\.)/i;
export const MAX_FILE_BYTES = 200_000;
export const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;

// ── tar 解析（ustar；支援 GitHub 的 pax 標頭與長路徑）────────────────────
export function parseTarGz(buf: Buffer): Map<string, string> {
  const tar = gunzipSync(buf);
  const files = new Map<string, string>();
  let off = 0;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = readStr(header, 0, 100);
    const sizeOct = readStr(header, 124, 12).trim();
    const size = parseInt(sizeOct || "0", 8) || 0;
    const type = String.fromCharCode(header[156] ?? 48);
    const prefix = readStr(header, 345, 155);
    off += 512;
    const body = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString("utf8"));
      if (m) paxPath = m[1]!;
      continue;
    }
    if (type !== "0" && type !== "\0") continue; // 只要一般檔案
    const full = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    // 去掉第一層「repo-branch/」
    const rel = full.split("/").slice(1).join("/");
    if (!rel || !shouldIndex(rel, size)) continue;
    files.set(rel, body.toString("utf8"));
  }
  return files;
}

function readStr(b: Buffer, from: number, len: number): string {
  const s = b.subarray(from, from + len);
  const z = s.indexOf(0);
  return s.subarray(0, z === -1 ? s.length : z).toString("utf8");
}

export function shouldIndex(path: string, size: number): boolean {
  if (size > MAX_FILE_BYTES || size === 0) return false;
  if (!INCLUDE_EXT.test(path)) return false;
  if (EXCLUDE_PATH.test(path) || EXCLUDE_NOISE.test(path)) return false;
  return true;
}

// ── 機密遮蔽 ─────────────────────────────────────────────────────────────
const SECRET_LINE = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|authorization|nvapi-|sk-[a-z0-9]{10,})/i;
const LONG_TOKEN = /\b[A-Za-z0-9_\-]{32,}\b/g;

/** 含疑似機密的「賦值／字面值」行整行遮蔽；一般讀 env 的程式碼（process.env.X）保留。 */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/process\.env\.[A-Z_]+/.test(line) && !/=\s*["'`][^"'`]{12,}["'`]/.test(line)) return line;
      if (SECRET_LINE.test(line) && /[:=]\s*["'`][^"'`\s]{8,}["'`]/.test(line)) return "[已遮蔽疑似機密的行]";
      return line.replace(LONG_TOKEN, (m) => (/^[a-z]+$/i.test(m) ? m : "[已遮蔽]"));
    })
    .join("\n");
}

// ── 建索引 ───────────────────────────────────────────────────────────────
export function buildIndex(files: Map<string, string>, commit: string, now = Date.now()): CodeIndex {
  const chunks: CodeChunk[] = [];
  for (const [path, content] of files) {
    const lines = content.split("\n");
    if (lines.length <= CHUNK_LINES) {
      pushChunk(chunks, path, lines, 1);
      continue;
    }
    for (let s = 0; s < lines.length; s += CHUNK_LINES - CHUNK_OVERLAP) {
      pushChunk(chunks, path, lines.slice(s, s + CHUNK_LINES), s + 1);
      if (s + CHUNK_LINES >= lines.length) break;
    }
  }
  return { chunks, fileCount: files.size, commit, builtAt: now };
}

function pushChunk(out: CodeChunk[], path: string, lines: string[], start: number): void {
  const text = lines.join("\n");
  if (text.trim().length < 20) return;
  out.push({ path, start, end: start + lines.length - 1, text, lower: text.toLowerCase() });
}

// ── 檢索 ─────────────────────────────────────────────────────────────────
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "how", "what", "why", "does", "not", "can",
  "我", "你", "的", "了", "是", "嗎", "怎麼", "為什麼", "什麼", "可以", "一個", "請問", "遊戲", "為何",
]);

/** 把關鍵字字串拆成檢索詞：英文識別字（含 camelCase 拆詞）＋中文二字詞。 */
export function tokenize(q: string): string[] {
  const out = new Set<string>();
  for (const w of q.match(/[A-Za-z][A-Za-z0-9_]{2,}/g) ?? []) {
    const lw = w.toLowerCase();
    if (!STOP.has(lw)) out.add(lw);
    for (const part of w.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[_\s]+/)) {
      const lp = part.toLowerCase();
      if (lp.length >= 3 && !STOP.has(lp)) out.add(lp);
    }
  }
  for (const run of q.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) continue;
    if (run.length <= 4 && !STOP.has(run)) out.add(run);
    for (let i = 0; i + 2 <= run.length; i++) {
      const bi = run.slice(i, i + 2);
      if (!STOP.has(bi)) out.add(bi);
    }
  }
  return [...out].slice(0, 40);
}

export interface SearchHit {
  chunk: CodeChunk;
  score: number;
}

export function searchIndex(index: CodeIndex, query: string, limit = 6): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const chunk of index.chunks) {
    const pathLower = chunk.path.toLowerCase();
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const inPath = pathLower.includes(t);
      let count = 0;
      let at = chunk.lower.indexOf(t);
      while (at !== -1 && count < 5) {
        count++;
        at = chunk.lower.indexOf(t, at + t.length);
      }
      if (inPath || count > 0) matched++;
      // 長詞比短詞更有鑑別力
      const weight = Math.min(3, 1 + t.length / 6);
      score += count * weight + (inPath ? 4 * weight : 0);
    }
    if (matched === 0) continue;
    score *= 1 + matched / terms.length; // 命中越多不同詞，加成越高
    if (/\.test\.tsx?$/.test(chunk.path)) score *= 0.85; // 測試很有用，但實作優先
    if (/\.md$/.test(chunk.path)) score *= 0.9;
    hits.push({ chunk, score });
  }
  hits.sort((a, b) => b.score - a.score);
  // 同一檔最多 2 片，避免單一大檔占滿
  const perFile = new Map<string, number>();
  const picked: SearchHit[] = [];
  for (const h of hits) {
    const n = perFile.get(h.chunk.path) ?? 0;
    if (n >= 2) continue;
    perFile.set(h.chunk.path, n + 1);
    picked.push(h);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** 把命中片段組成給 AI 的「程式碼依據」文字，總長有上限。 */
export function formatHits(hits: SearchHit[], maxChars = 9000): string {
  let out = "";
  for (const h of hits) {
    const block = `--- ${h.chunk.path} (第 ${h.chunk.start}-${h.chunk.end} 行) ---\n${redactSecrets(h.chunk.text)}\n`;
    if (out.length + block.length > maxChars) {
      const room = maxChars - out.length;
      if (room > 400) out += block.slice(0, room) + "\n…(截斷)\n";
      break;
    }
    out += block;
  }
  return out;
}
