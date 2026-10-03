const ACCEPTED_IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|avif)$/;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 與後端 player-image 端點一致

/**
 * 玩家本人權限的圖片上傳（國旗／國徽／背景／看板娘）。
 * 上傳到 DB 儲存端點並回傳站內可用的圖片網址。
 */
export async function uploadPlayerImage(file: File): Promise<string> {
  if (!ACCEPTED_IMAGE_TYPES.test(file.type)) {
    throw new Error("只接受 PNG/JPEG/WebP/GIF/AVIF 圖片");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("圖片大小不可超過 5 MB");
  }
  const res = await fetch("/api/storage/uploads/player-image", {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as {
    url?: string;
    error?: string;
  };
  if (!res.ok || !data.url) {
    throw new Error(data.error || `上傳失敗（HTTP ${res.status}）`);
  }
  return data.url;
}
