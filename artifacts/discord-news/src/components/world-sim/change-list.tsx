import { Pencil, Plus, Trash2 } from "lucide-react";
import type { WorldSimChange } from "./shared";

export function ChangeIcon({ action }: { action: string }) {
  if (action === "createNpc")
    return <Plus className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />;
  if (action === "deleteNation")
    return <Trash2 className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  return <Pencil className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />;
}

export function ChangeList({ changes }: { changes: WorldSimChange[] }) {
  if (changes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">此提案沒有任何國家或領土變更。</p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {changes.map((c, i) => (
        <li
          key={i}
          className="flex items-start gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm"
        >
          <span className="mt-0.5 shrink-0">
            <ChangeIcon action={c.action} />
          </span>
          <span className="min-w-0">
            <span className="font-medium">{c.nationName}</span>
            <span className="text-muted-foreground"> — {c.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
