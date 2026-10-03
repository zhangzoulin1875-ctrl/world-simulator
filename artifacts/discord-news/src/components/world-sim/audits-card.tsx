import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Globe2, Loader2 } from "lucide-react";
import { ChangeList } from "./change-list";
import { formatDateTime, type AuditEntry } from "./shared";

interface AuditsCardProps {
  auditsLoading: boolean;
  auditsError: string | null;
  audits: AuditEntry[] | null;
}

export function AuditsCard({
  auditsLoading,
  auditsError,
  audits,
}: AuditsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe2 className="h-4 w-4" />
          稽核紀錄
        </CardTitle>
        <CardDescription>
          AI 每次世界變更（管理員隨選或每回合自動模擬）的可讀紀錄，最新在上。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {auditsLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入稽核紀錄中…
          </div>
        ) : auditsError ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {auditsError}
          </p>
        ) : !audits || audits.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            尚無任何 AI 世界變更紀錄。
          </p>
        ) : (
          <ul className="space-y-3" data-testid="list-audits">
            {audits.map((a) => (
              <li key={a.id} className="rounded-lg border p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <Badge variant={a.source === "auto" ? "outline" : "default"}>
                    {a.source === "auto" ? "自動模擬" : "管理員"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(a.createdAt)}
                  </span>
                </div>
                <p className="text-sm font-medium">{a.summary}</p>
                {a.instruction && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    指令：{a.instruction}
                  </p>
                )}
                {a.changes.length > 0 && (
                  <div className="mt-2">
                    <ChangeList changes={a.changes} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
