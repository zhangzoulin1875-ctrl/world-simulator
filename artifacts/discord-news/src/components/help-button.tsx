import React from "react";
import { HelpCircle, BookOpen } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HELP_CONTENT, type HelpKey, type HelpSection } from "@/lib/help-content";
import { useHelpScope, isHelpSeen, markHelpSeen } from "@/lib/help-storage";
import { useEncyclopedia } from "@/components/encyclopedia-context";

/**
 * 各頁面／分頁的「問號說明」按鈕：
 * - 點擊開啟對應分頁的說明視窗。
 * - 玩家「首次到訪」某個 helpKey 時自動彈出一次；之後只在主動點擊時出現。
 * - 首次狀態以目前登入玩家做區隔，記在本機（見 help-storage）。
 *
 * 放在各頁表頭中間上方（以絕對定位置中），手機與桌機皆可正常顯示。
 */
export function HelpButton({
  helpKey,
  className,
}: {
  helpKey: HelpKey;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const scope = useHelpScope();
  const content = HELP_CONTENT[helpKey];

  // 首次到訪自動彈出：依 scope + helpKey 記錄，切換分頁時各自獨立觸發。
  React.useEffect(() => {
    if (!isHelpSeen(scope, helpKey)) {
      markHelpSeen(scope, helpKey);
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, helpKey]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "absolute left-1/2 top-3 z-30 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white/85 backdrop-blur transition hover:bg-black/75 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        }
        title="說明"
        aria-label="開啟此頁說明"
        data-testid={`button-help-${helpKey}`}
      >
        <HelpCircle className="h-5 w-5" />
      </button>
      <HelpDialog open={open} onOpenChange={setOpen} content={content} />
    </>
  );
}

/** 說明視窗：呈現「遊戲內意義」「如何操作」與「相關詞彙」。 */
export function HelpDialog({
  open,
  onOpenChange,
  content,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: HelpSection;
}) {
  const { openEncyclopedia } = useEncyclopedia();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto border-white/15 bg-zinc-900 text-white sm:max-w-lg"
        data-testid="dialog-help"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif">
            <HelpCircle className="h-5 w-5 text-amber-300" />
            {content.title}
          </DialogTitle>
          <DialogDescription className="text-white/60">
            {content.subtitle}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold tracking-wide text-amber-200/90">
              <BookOpen className="h-3.5 w-3.5" />
              這個介面的意義
            </h3>
            <div className="space-y-2 text-sm leading-relaxed text-white/85">
              {content.meaning.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-bold tracking-wide text-amber-200/90">
              如何操作
            </h3>
            <ol className="space-y-1.5 text-sm leading-relaxed text-white/85">
              {content.howto.map((step, i) => (
                <li key={i} className="flex gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-[11px] font-bold text-amber-200">
                    {i + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>

          {content.terms && content.terms.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-bold tracking-wide text-amber-200/90">
                相關詞彙
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {content.terms.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      openEncyclopedia(t);
                    }}
                    className="rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] text-white/75 transition hover:border-amber-300/60 hover:bg-amber-500/15 hover:text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60"
                    data-testid={`chip-term-${t}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-white/40">
                點選詞彙即可在「遊戲百科」查閱其解釋。
              </p>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
