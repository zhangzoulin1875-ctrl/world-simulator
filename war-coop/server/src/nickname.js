// 遊戲暱稱規則(純函式)。
// 目的:唯一、好辨認、不能冒充(全形半形、前後空白、隱形字元都算同一個)。
const MIN = 2, MAX = 16;

/** 正規化:NFKC(全形→半形、相容字統一)、去前後空白、中間連續空白合併為一個 */
export function normalizeNickname(raw) {
  return String(raw ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** 回傳 { ok:true, nickname } 或 { ok:false, error } */
export function validateNickname(raw) {
  const n = normalizeNickname(raw);
  // 控制字元、零寬字元、方向控制字元(可用來偽造外觀)
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(n)) return { ok: false, error: '暱稱含有不可見或控制字元' };
  const len = [...n].length;   // 以字元計,不以 UTF-16 單元計
  if (len < MIN) return { ok: false, error: `暱稱至少 ${MIN} 個字` };
  if (len > MAX) return { ok: false, error: `暱稱最多 ${MAX} 個字` };
  // 只允許:中日韓文字、英數、底線、連字號、點、單一空白
  if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9_.\- ]+$/u.test(n))
    return { ok: false, error: '暱稱只能用中日韓文字、英數、底線、連字號、點與空白' };
  if (/^[\s._-]+$/.test(n)) return { ok: false, error: '暱稱必須包含文字或數字' };
  // 保留字:避免冒充系統或管理者
  if (/^(admin|system|server|gm|管理員|系統|客服|官方)$/i.test(n)) return { ok: false, error: '此暱稱為保留字' };
  return { ok: true, nickname: n };
}

/** 暱稱比對用鍵(與資料庫的 lower(name) 唯一索引一致) */
export const nicknameKey = (n) => normalizeNickname(n).toLowerCase();
