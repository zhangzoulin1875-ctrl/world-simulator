import { useEffect, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import {
  Loader2,
  ImageIcon,
  ShieldAlert,
  Sparkles,
  Upload,
  X,
  Music,
  ArrowUp,
  ArrowDown,
  Trash2,
  Pencil,
  Check,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL;
const DEFAULT_BG = `${BASE}game/home-bg-default.webp`;
const DEFAULT_KANBAN = `${BASE}game/kanban-default.webp`;

interface EraOption {
  slug: string;
  label: string;
}

interface AppearanceDefaults {
  kanbanUrl: string | null;
  backgroundUrl: string | null;
  eraBackgrounds: Record<string, string>;
  eras: EraOption[];
  updatedAt: string | null;
}

async function authedFetch(url: string, init?: RequestInit) {
  const token = getAdminToken();
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ACCEPTED_IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|avif)$/i;

/**
 * Upload the image bytes to the admin-gated upload endpoint. The server
 * stores the file and returns the site-relative serving URL
 * (/api/storage/images/…) to use as the image URL.
 */
async function uploadImage(file: File): Promise<string> {
  if (!ACCEPTED_IMAGE_TYPES.test(file.type)) {
    throw new Error("只接受 PNG/JPEG/WebP/GIF/AVIF 圖片");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("圖片大小不可超過 10 MB");
  }

  const token = getAdminToken();
  const res = await fetch("/api/storage/uploads/game-appearance", {
    method: "POST",
    headers: {
      "Content-Type": file.type,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
    );
  }
  if (typeof data?.url !== "string") {
    throw new Error("伺服器回應格式不正確");
  }
  return data.url;
}

function UploadButton({
  label,
  uploading,
  onFile,
  testId,
}: {
  label: string;
  uploading: boolean;
  onFile: (file: File) => void;
  testId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="secondary"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        data-testid={testId}
      >
        {uploading ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : (
          <Upload className="w-4 h-4 mr-2" />
        )}
        {uploading ? "上傳中…" : label}
      </Button>
    </>
  );
}

function ImagePreview({
  src,
  fallback,
  alt,
  ratioClass,
}: {
  src: string;
  fallback: string;
  alt: string;
  ratioClass: string;
}) {
  const [errored, setErrored] = useState(false);
  useEffect(() => setErrored(false), [src]);
  return (
    <div
      className={`relative overflow-hidden rounded-md border bg-muted/40 ${ratioClass}`}
    >
      {errored ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground text-xs">
          <ImageIcon className="w-5 h-5" />
          圖片載入失敗
        </div>
      ) : (
        <img
          src={src || fallback}
          alt={alt}
          className="absolute inset-0 w-full h-full object-contain"
          onError={() => setErrored(true)}
        />
      )}
    </div>
  );
}

const MAX_MUSIC_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const ACCEPTED_AUDIO_MIME = /^audio\/(mpeg|mp3|ogg|wav|x-wav|wave|mp4|x-m4a|m4a|aac)$/i;
const AUDIO_EXT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
};

interface MusicTrack {
  id: string;
  title: string;
  contentType: string;
  byteSize: number;
  sortOrder: number;
  createdAt: string;
  url: string;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** 背景音樂管理區塊（Task #73）：上傳／更名／排序／刪除，即時生效。 */
function MusicSection() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const showError = (title: string, err: unknown) => {
    toast({
      variant: "destructive",
      title,
      description: err instanceof Error ? err.message : String(err),
    });
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/game/music/admin");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      setTracks(Array.isArray(data?.tracks) ? data.tracks : []);
    } catch (err) {
      showError("讀取音樂清單失敗", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadTrack = async (file: File) => {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mime = ACCEPTED_AUDIO_MIME.test(file.type)
      ? file.type
      : AUDIO_EXT_MIME[ext];
    if (!mime) {
      showError("上傳失敗", new Error("只接受 MP3/OGG/WAV/M4A 音訊檔"));
      return;
    }
    if (file.size > MAX_MUSIC_UPLOAD_BYTES) {
      showError("上傳失敗", new Error("音訊檔大小不可超過 20 MB"));
      return;
    }
    const defaultTitle = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 60);
    const title = window.prompt("曲名（1–60 字）：", defaultTitle || "未命名曲目");
    if (title === null) return;
    const cleaned = title.trim();
    if (!cleaned || cleaned.length > 60) {
      showError("上傳失敗", new Error("請提供曲名（1–60 字）"));
      return;
    }

    setUploading(true);
    try {
      const token = getAdminToken();
      const res = await fetch(
        `/api/game/music?title=${encodeURIComponent(cleaned)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": mime,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: file,
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      toast({ title: "音樂已上傳", description: `已加入曲目「${cleaned}」。` });
      await load();
    } catch (err) {
      showError("上傳失敗", err);
    } finally {
      setUploading(false);
    }
  };

  const renameTrack = async (id: string) => {
    const cleaned = editingTitle.trim();
    if (!cleaned || cleaned.length > 60) {
      showError("更名失敗", new Error("請提供曲名（1–60 字）"));
      return;
    }
    setBusyId(id);
    try {
      const res = await authedFetch(`/api/game/music/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: cleaned }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      setTracks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, title: cleaned } : t)),
      );
      setEditingId(null);
      toast({ title: "曲名已更新" });
    } catch (err) {
      showError("更名失敗", err);
    } finally {
      setBusyId(null);
    }
  };

  const moveTrack = async (id: string, direction: -1 | 1) => {
    const idx = tracks.findIndex((t) => t.id === id);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= tracks.length) return;
    const next = [...tracks];
    const removed = next.splice(idx, 1)[0];
    next.splice(target, 0, removed);
    setBusyId(id);
    try {
      const res = await authedFetch("/api/game/music/order", {
        method: "PUT",
        body: JSON.stringify({ ids: next.map((t) => t.id) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      setTracks(next);
    } catch (err) {
      showError("排序失敗", err);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const deleteTrack = async (id: string) => {
    setBusyId(id);
    try {
      const res = await authedFetch(`/api/game/music/${id}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      setTracks((prev) => prev.filter((t) => t.id !== id));
      setConfirmDeleteId(null);
      toast({ title: "曲目已刪除" });
    } catch (err) {
      showError("刪除失敗", err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Music className="w-5 h-5" />
          背景音樂
        </CardTitle>
        <CardDescription>
          遊戲首頁的背景音樂播放清單。玩家需自行按播放（瀏覽器限制不可自動播放）；沒有任何曲目時首頁不會顯示播放器。變更立即生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <input
            ref={inputRef}
            type="file"
            accept="audio/mpeg,audio/ogg,audio/wav,audio/mp4,audio/x-m4a,.mp3,.ogg,.wav,.m4a"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) uploadTrack(file);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            data-testid="upload-music"
          >
            {uploading ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Upload className="w-4 h-4 mr-2" />
            )}
            {uploading ? "上傳中…" : "上傳音檔"}
          </Button>
          <p className="text-xs text-muted-foreground">
            接受 MP3/OGG/WAV/M4A，單檔最大 20 MB。
          </p>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            讀取音樂清單中…
          </div>
        ) : tracks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            尚無曲目。上傳第一首音樂後，遊戲首頁就會出現播放器。
          </p>
        ) : (
          <ul className="space-y-2">
            {tracks.map((track, idx) => {
              const busy = busyId === track.id;
              return (
                <li
                  key={track.id}
                  className="border rounded-md p-3 space-y-2"
                  data-testid={`music-track-${track.id}`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground tabular-nums w-6 shrink-0">
                      {idx + 1}.
                    </span>
                    {editingId === track.id ? (
                      <>
                        <Input
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          maxLength={60}
                          className="h-8 flex-1 min-w-40"
                          data-testid={`input-music-title-${track.id}`}
                        />
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-8 w-8"
                          disabled={busy}
                          onClick={() => renameTrack(track.id)}
                          aria-label="儲存曲名"
                        >
                          {busy ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Check className="w-4 h-4" />
                          )}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          disabled={busy}
                          onClick={() => setEditingId(null)}
                          aria-label="取消更名"
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="font-medium flex-1 min-w-0 truncate">
                          {track.title}
                        </span>
                        <Badge variant="outline" className="shrink-0">
                          {formatBytes(track.byteSize)}
                        </Badge>
                      </>
                    )}
                  </div>
                  <audio
                    src={track.url}
                    controls
                    preload="none"
                    className="w-full h-9"
                  />
                  <div className="flex items-center gap-1 flex-wrap">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={busy || idx === 0}
                      onClick={() => moveTrack(track.id, -1)}
                      aria-label="上移"
                      data-testid={`button-music-up-${track.id}`}
                    >
                      <ArrowUp className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={busy || idx === tracks.length - 1}
                      onClick={() => moveTrack(track.id, 1)}
                      aria-label="下移"
                      data-testid={`button-music-down-${track.id}`}
                    >
                      <ArrowDown className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(track.id);
                        setEditingTitle(track.title);
                      }}
                      aria-label="更名"
                      data-testid={`button-music-rename-${track.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    {confirmDeleteId === track.id ? (
                      <span className="flex items-center gap-1 ml-1">
                        <span className="text-xs text-destructive">
                          確定刪除？
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 px-2"
                          disabled={busy}
                          onClick={() => deleteTrack(track.id)}
                          data-testid={`button-music-delete-confirm-${track.id}`}
                        >
                          {busy ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            "刪除"
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2"
                          disabled={busy}
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          取消
                        </Button>
                      </span>
                    ) : (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => setConfirmDeleteId(track.id)}
                        aria-label="刪除"
                        data-testid={`button-music-delete-${track.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function GameAppearancePage() {
  const { toast } = useToast();
  const isAdmin = Boolean(getAdminToken());

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [kanbanUrl, setKanbanUrl] = useState("");
  const [backgroundUrl, setBackgroundUrl] = useState("");
  const [uploadingKanban, setUploadingKanban] = useState(false);
  const [uploadingBackground, setUploadingBackground] = useState(false);
  const [eras, setEras] = useState<EraOption[]>([]);
  const [eraBackgrounds, setEraBackgrounds] = useState<Record<string, string>>({});
  const [uploadingEra, setUploadingEra] = useState<string | null>(null);

  const setEraUrl = (slug: string, url: string) => {
    setEraBackgrounds((prev) => {
      const next = { ...prev };
      if (url.trim()) next[slug] = url;
      else delete next[slug];
      return next;
    });
  };

  const handleUpload = async (
    file: File,
    setUrl: (url: string) => void,
    setUploading: (v: boolean) => void,
  ) => {
    setUploading(true);
    try {
      const servingPath = await uploadImage(file);
      setUrl(servingPath);
      toast({
        title: "圖片已上傳",
        description: "預覽已更新，記得按「儲存預設外觀」才會生效。",
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "上傳失敗",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/game/appearance-defaults");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: AppearanceDefaults = await res.json();
      setKanbanUrl(data.kanbanUrl ?? "");
      setBackgroundUrl(data.backgroundUrl ?? "");
      setEras(Array.isArray(data.eras) ? data.eras : []);
      setEraBackgrounds(data.eraBackgrounds ?? {});
      setUpdatedAt(data.updatedAt);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "讀取失敗",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await authedFetch("/api/game/appearance-defaults", {
        method: "PUT",
        body: JSON.stringify({
          kanbanUrl: kanbanUrl.trim() || null,
          backgroundUrl: backgroundUrl.trim() || null,
          eraBackgrounds,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      setKanbanUrl(data.kanbanUrl ?? "");
      setBackgroundUrl(data.backgroundUrl ?? "");
      setEraBackgrounds(data.eraBackgrounds ?? {});
      setUpdatedAt(data.updatedAt ?? null);
      toast({
        title: "已更新遊戲預設外觀",
        description: "所有未自訂外觀的玩家將立即套用新預設。",
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "儲存失敗",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="container mx-auto py-8 px-4 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5" />
              需要管理員權限
            </CardTitle>
            <CardDescription>
              請先以管理員身分登入後再進入遊戲外觀設定。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Sparkles className="w-7 h-7" />
          遊戲外觀
        </h1>
        <p className="text-muted-foreground mt-1">
          設定玩家首頁的全域預設看板顧問與背景圖。玩家若沒有自訂外觀，會立即套用這裡的預設；欄位留空代表使用系統內建圖片。
        </p>
        {updatedAt && (
          <p className="text-xs text-muted-foreground mt-2">
            上次更新：{new Date(updatedAt).toLocaleString()}
          </p>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          讀取中…
        </div>
      ) : (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">預設看板顧問</CardTitle>
                <CardDescription>
                  顯示在玩家首頁右側的人物立繪。建議使用去背直式圖片。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ImagePreview
                  src={kanbanUrl.trim() || DEFAULT_KANBAN}
                  fallback={DEFAULT_KANBAN}
                  alt="預設看板顧問預覽"
                  ratioClass="aspect-[3/4]"
                />
                {!kanbanUrl.trim() && (
                  <Badge variant="outline">目前使用系統內建圖片</Badge>
                )}
                <UploadButton
                  label="從電腦上傳圖片"
                  uploading={uploadingKanban}
                  onFile={(file) =>
                    handleUpload(file, setKanbanUrl, setUploadingKanban)
                  }
                  testId="upload-kanban"
                />
                <div className="space-y-2">
                  <Label htmlFor="kanban-url">看板顧問圖片網址</Label>
                  <div className="flex gap-2">
                    <Input
                      id="kanban-url"
                      placeholder="https://…（留空＝使用內建圖片）"
                      value={kanbanUrl}
                      onChange={(e) => setKanbanUrl(e.target.value)}
                      data-testid="input-kanban-url"
                    />
                    {kanbanUrl && (
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setKanbanUrl("")}
                        aria-label="清除看板顧問網址"
                        title="清除（改用內建圖片）"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    可直接從電腦上傳圖片，或貼上 http(s) 圖片網址。
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">預設背景圖</CardTitle>
                <CardDescription>
                  玩家首頁（辦公室）的全畫面背景。建議使用橫式高解析圖片。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ImagePreview
                  src={backgroundUrl.trim() || DEFAULT_BG}
                  fallback={DEFAULT_BG}
                  alt="預設背景圖預覽"
                  ratioClass="aspect-video"
                />
                {!backgroundUrl.trim() && (
                  <Badge variant="outline">目前使用系統內建圖片</Badge>
                )}
                <UploadButton
                  label="從電腦上傳圖片"
                  uploading={uploadingBackground}
                  onFile={(file) =>
                    handleUpload(file, setBackgroundUrl, setUploadingBackground)
                  }
                  testId="upload-background"
                />
                <div className="space-y-2">
                  <Label htmlFor="background-url">背景圖片網址</Label>
                  <div className="flex gap-2">
                    <Input
                      id="background-url"
                      placeholder="https://…（留空＝使用內建圖片）"
                      value={backgroundUrl}
                      onChange={(e) => setBackgroundUrl(e.target.value)}
                      data-testid="input-background-url"
                    />
                    {backgroundUrl && (
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setBackgroundUrl("")}
                        aria-label="清除背景圖網址"
                        title="清除（改用內建圖片）"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    可直接從電腦上傳圖片，或貼上 http(s) 圖片網址。
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">各時代背景圖</CardTitle>
              <CardDescription>
                為每個時代設定不同的玩家首頁背景。遊戲進入該時代時，未自訂背景的玩家會自動套用對應圖片；沒有設定的時代則使用上方的預設背景圖。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {eras.map((era) => {
                const url = eraBackgrounds[era.slug] ?? "";
                return (
                  <div
                    key={era.slug}
                    className="flex flex-col sm:flex-row gap-3 items-start border rounded-md p-3"
                    data-testid={`era-bg-row-${era.slug}`}
                  >
                    <div className="w-full sm:w-40 shrink-0">
                      <ImagePreview
                        src={url.trim() || backgroundUrl.trim() || DEFAULT_BG}
                        fallback={DEFAULT_BG}
                        alt={`${era.label} 背景預覽`}
                        ratioClass="aspect-video"
                      />
                    </div>
                    <div className="flex-1 w-full space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{era.label}</span>
                        {!url.trim() && (
                          <Badge variant="outline">使用預設背景</Badge>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Input
                          placeholder="https://…（留空＝使用預設背景圖）"
                          value={url}
                          onChange={(e) => setEraUrl(era.slug, e.target.value)}
                          data-testid={`input-era-bg-${era.slug}`}
                        />
                        {url && (
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => setEraUrl(era.slug, "")}
                            aria-label={`清除${era.label}背景`}
                            title="清除（改用預設背景圖）"
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                      <UploadButton
                        label="從電腦上傳圖片"
                        uploading={uploadingEra === era.slug}
                        onFile={(file) =>
                          handleUpload(
                            file,
                            (u) => setEraUrl(era.slug, u),
                            (v) => setUploadingEra(v ? era.slug : null),
                          )
                        }
                        testId={`upload-era-bg-${era.slug}`}
                      />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving} data-testid="save-appearance">
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              儲存預設外觀
            </Button>
          </div>

          <MusicSection />
        </>
      )}
    </div>
  );
}
