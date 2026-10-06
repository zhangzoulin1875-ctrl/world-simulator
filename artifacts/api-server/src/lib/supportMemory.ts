/**
 * AI 客服的「個人上下文記憶」。
 *
 * 隔離原則（最重要）：記憶的 key 一律是「頻道 ID + 使用者 ID」，只存該使用者自己問過的問題與
 * 客服給他的回答。取用時只能用提問者自己的 key，不存在「列出全部」或「依內容搜尋」的介面，
 * 所以結構上就不可能把 A 的對話帶給 B。
 *
 * 只在「對話延續」時使用：距離上次互動超過 TTL 就視為新話題並清掉；每人最多保留 MAX_TURNS 輪，
 * 每輪內容截短；全體最多 MAX_USERS 位使用者（超過就淘汰最久沒互動的）。僅存記憶體，不寫資料庫。
 */

export interface MemoryTurn {
  q: string;
  a: string;
}

interface Entry {
  turns: MemoryTurn[];
  at: number;
}

export const MEMORY_TTL_MS = 15 * 60 * 1000;
export const MEMORY_MAX_TURNS = 3;
export const MEMORY_MAX_USERS = 500;
export const MEMORY_Q_CHARS = 300;
export const MEMORY_A_CHARS = 700;

const store = new Map<string, Entry>();

export function memoryKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 取該使用者「仍有效」的最近對話（過期則清掉並回空）。 */
export function getMemory(key: string, now = Date.now()): MemoryTurn[] {
  const e = store.get(key);
  if (!e) return [];
  if (now - e.at > MEMORY_TTL_MS) {
    store.delete(key);
    return [];
  }
  return e.turns.map((t) => ({ ...t }));
}

/** 記下一輪問答（只存這位使用者自己的 key）。 */
export function rememberTurn(key: string, turn: MemoryTurn, now = Date.now()): void {
  const prev = getMemory(key, now);
  const turns = [...prev, { q: clip(turn.q, MEMORY_Q_CHARS), a: clip(turn.a, MEMORY_A_CHARS) }].slice(-MEMORY_MAX_TURNS);
  store.delete(key); // 重新插入以維持「最近互動在最後」的順序，供淘汰使用
  store.set(key, { turns, at: now });
  while (store.size > MEMORY_MAX_USERS) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function clearMemory(key: string): void {
  store.delete(key);
}

/** 清掉所有過期項目（定時呼叫即可）。 */
export function pruneMemory(now = Date.now()): number {
  let n = 0;
  for (const [k, e] of store) {
    if (now - e.at > MEMORY_TTL_MS) {
      store.delete(k);
      n++;
    }
  }
  return n;
}

export function memorySize(): number {
  return store.size;
}

/** 測試用。 */
export function __resetMemoryForTest(): void {
  store.clear();
}

/** 把記憶轉成給 AI 的對話前情（空陣列＝沒有可用記憶）。 */
export function memoryToMessages(turns: MemoryTurn[]): Array<{ role: "user" | "assistant"; content: string }> {
  return turns.flatMap((t) => [
    { role: "user" as const, content: t.q },
    { role: "assistant" as const, content: t.a },
  ]);
}
