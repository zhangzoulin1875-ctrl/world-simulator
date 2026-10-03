import type { Dispatch, SetStateAction } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Bot, Check, Loader2, Wand2 } from "lucide-react";
import { ATTITUDE_MAX, type AttitudeNation } from "./shared";

interface NpcAttitudesCardProps {
  attLoading: boolean;
  attNations: AttitudeNation[] | null;
  attDrafts: Record<string, string>;
  setAttDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  attSavingId: string | null;
  attGenId: string | null;
  saveAttitude: (id: string) => Promise<void>;
  generateAttitude: (id: string) => Promise<void>;
}

export function NpcAttitudesCard({
  attLoading,
  attNations,
  attDrafts,
  setAttDrafts,
  attSavingId,
  attGenId,
  saveAttitude,
  generateAttitude,
}: NpcAttitudesCardProps) {
  return (
    <Card data-testid="card-npc-attitudes">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="h-4 w-4" />
          NPC 外交態度
        </CardTitle>
        <CardDescription>
          為每個 NPC／無主國家設定「外交態度」，與其政治註記一起注入外交對話與條約談判的
          AI 判定。可手動編輯或按「AI 生成」（生成後自動儲存）。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {attLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入國家中…
          </div>
        ) : !attNations ? (
          <p className="py-2 text-sm text-muted-foreground">
            讀取國家失敗，請重新整理頁面。
          </p>
        ) : attNations.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            目前沒有 NPC 或無主國家。
          </p>
        ) : (
          <div className="space-y-4">
            {attNations.map((n) => {
              const draft = attDrafts[n.id] ?? "";
              const dirty = draft.trim() !== (n.diplomaticAttitude ?? "");
              const busy = attSavingId === n.id || attGenId === n.id;
              return (
                <div
                  key={n.id}
                  className="space-y-2 rounded-md border border-border p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {n.name ?? "未命名國家"}
                    </span>
                    {n.isNpc ? (
                      <Badge variant="secondary" className="text-[10px]">
                        NPC
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        無主
                      </Badge>
                    )}
                    {n.government && (
                      <span className="text-xs text-muted-foreground">
                        {n.government}
                      </span>
                    )}
                  </div>
                  {n.politicalNote && (
                    <p className="text-xs text-muted-foreground">
                      政治註記：{n.politicalNote}
                    </p>
                  )}
                  <Textarea
                    value={draft}
                    onChange={(e) =>
                      setAttDrafts((prev) => ({
                        ...prev,
                        [n.id]: e.target.value.slice(0, ATTITUDE_MAX),
                      }))
                    }
                    placeholder="描述此國的外交態度…（留空代表未設定）"
                    rows={3}
                    disabled={busy}
                    data-testid={`input-attitude-${n.id}`}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {draft.length} / {ATTITUDE_MAX}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void generateAttitude(n.id)}
                        disabled={busy}
                        data-testid={`button-gen-attitude-${n.id}`}
                      >
                        {attGenId === n.id ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <Wand2 className="mr-1.5 h-4 w-4" />
                        )}
                        AI 生成
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void saveAttitude(n.id)}
                        disabled={busy || !dirty}
                        data-testid={`button-save-attitude-${n.id}`}
                      >
                        {attSavingId === n.id ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="mr-1.5 h-4 w-4" />
                        )}
                        儲存
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
