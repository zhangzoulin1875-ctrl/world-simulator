import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getAdminToken } from "@/lib/admin-token";
import { Loader2, Pencil, RefreshCw, ScrollText, Search, Sparkles } from "lucide-react";

interface NoteNation {
  id: string;
  name: string | null;
  government: string | null;
  isNpc: boolean;
  isOwned: boolean;
  politicalNote: string | null;
  diplomaticAttitude: string | null;
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

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return typeof (data as { error?: unknown })?.error === "string"
    ? (data as { error: string }).error
    : `請求失敗（${res.status}）`;
}

function kindLabel(n: NoteNation): { label: string; variant: "secondary" | "outline" | "default" } {
  if (n.isNpc) return { label: "NPC", variant: "secondary" };
  if (!n.isOwned) return { label: "無主", variant: "outline" };
  return { label: "玩家", variant: "default" };
}

function NoteCard({
  nation,
  onUpdated,
}: {
  nation: NoteNation;
  onUpdated: (id: string, politicalNote: string | null) => void;
}) {
  const kind = kindLabel(nation);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(nation.politicalNote ?? "");
  const [prompt, setPrompt] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  const busy = saving || regenerating;

  const startEdit = () => {
    setDraft(nation.politicalNote ?? "");
    setCardError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setCardError(null);
  };

  const save = async () => {
    setSaving(true);
    setCardError(null);
    try {
      const res = await authedFetch(`/api/npc-nations/${nation.id}`, {
        method: "PATCH",
        body: JSON.stringify({ politicalNote: draft }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const next = draft.trim() === "" ? null : draft.trim().slice(0, 1000);
      onUpdated(nation.id, next);
      setEditing(false);
    } catch (err) {
      setCardError(err instanceof Error ? err.message : "存檔失敗");
    } finally {
      setSaving(false);
    }
  };

  const regenerate = async () => {
    setRegenerating(true);
    setCardError(null);
    try {
      const res = await authedFetch(`/api/npc-nations/${nation.id}/political-note`, {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { politicalNote?: string };
      const next = typeof data.politicalNote === "string" ? data.politicalNote : null;
      onUpdated(nation.id, next);
      setDraft(next ?? "");
      setEditing(false);
    } catch (err) {
      setCardError(err instanceof Error ? err.message : "重新生成失敗");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <Card data-testid={`card-note-${nation.id}`}>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {nation.name ?? "未命名國家"}
          <Badge variant={kind.variant} className="text-[10px]">
            {kind.label}
          </Badge>
        </CardTitle>
        <CardDescription>{nation.government ?? "未設定政體"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
              maxLength={1000}
              placeholder="輸入政治註記內容（留空則清除）…"
              disabled={busy}
              data-testid={`textarea-note-${nation.id}`}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{draft.length}/1000</span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={cancelEdit}
                  disabled={busy}
                  data-testid={`button-cancel-${nation.id}`}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  onClick={save}
                  disabled={busy}
                  data-testid={`button-save-${nation.id}`}
                >
                  {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                  存檔
                </Button>
              </div>
            </div>
          </div>
        ) : nation.politicalNote ? (
          <p className="whitespace-pre-wrap leading-relaxed">{nation.politicalNote}</p>
        ) : (
          <p className="text-muted-foreground">尚未產生</p>
        )}

        {showPrompt && !editing ? (
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="（選填）提示詞／方向，引導 AI 生成，例如「更強調軍國主義色彩」…"
            disabled={busy}
            data-testid={`textarea-prompt-${nation.id}`}
          />
        ) : null}

        {cardError ? (
          <p className="text-xs text-destructive" data-testid={`text-error-${nation.id}`}>
            {cardError}
          </p>
        ) : null}

        {!editing ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={startEdit}
              disabled={busy}
              data-testid={`button-edit-${nation.id}`}
            >
              <Pencil className="mr-1 h-3.5 w-3.5" />
              手動編輯
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPrompt((v) => !v)}
              disabled={busy}
              data-testid={`button-toggle-prompt-${nation.id}`}
            >
              <Sparkles className="mr-1 h-3.5 w-3.5" />
              {showPrompt ? "隱藏提示詞" : "提示詞"}
            </Button>
            <Button
              size="sm"
              onClick={regenerate}
              disabled={busy}
              data-testid={`button-regenerate-${nation.id}`}
            >
              {regenerating ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              重新生成
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function PoliticalNotes() {
  const [nations, setNations] = useState<NoteNation[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/npc-nations/political-notes");
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setNations((data.nations ?? []) as NoteNation[]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "載入失敗");
      setNations(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUpdated = useCallback((id: string, politicalNote: string | null) => {
    setNations((prev) =>
      prev ? prev.map((n) => (n.id === id ? { ...n, politicalNote } : n)) : prev,
    );
  }, []);

  const filtered = useMemo(() => {
    if (!nations) return [];
    const q = search.trim().toLowerCase();
    if (q === "") return nations;
    return nations.filter((n) =>
      [n.name, n.government, n.politicalNote]
        .filter((s): s is string => typeof s === "string")
        .some((s) => s.toLowerCase().includes(q)),
    );
  }, [nations, search]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-serif font-bold">
          <ScrollText className="h-5 w-5" />
          政治註記總覽
        </h1>
        <p className="text-sm text-muted-foreground">
          一次瀏覽並管理所有國家（NPC／無主／玩家）的政治註記（治理風格）。可手動編輯、或一鍵以 AI 重新生成（可選填提示詞引導方向）。
        </p>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜尋國名、政體或註記內容…"
          className="pl-9"
          data-testid="input-search-notes"
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          載入中…
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {error}
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {nations && nations.length > 0 ? "沒有符合搜尋的國家。" : "目前沒有任何國家。"}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">共 {filtered.length} 個國家</p>
          {filtered.map((n) => (
            <NoteCard key={n.id} nation={n} onUpdated={handleUpdated} />
          ))}
        </div>
      )}
    </div>
  );
}
