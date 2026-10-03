import React from "react";
import { BookOpen, Search, GraduationCap, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  GLOSSARY,
  GLOSSARY_CATEGORIES,
  CONCEPTS,
  CONCEPT_CATEGORIES,
  type GlossaryCategory,
  type ConceptCategory,
} from "@/lib/help-content";

type Section = "concepts" | "glossary";

/**
 * 首頁「問號」開啟的遊戲百科：彙整所有專有名詞（詞彙表）與遊戲概念／機制，
 * 支援分類瀏覽與關鍵字搜尋。
 *
 * 由父層（首頁）控制開關，並提供「重新開啟新手教學」的入口。
 */
export function EncyclopediaDialog({
  open,
  onOpenChange,
  onStartOnboarding,
  initialQuery,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStartOnboarding: () => void;
  /**
   * 開啟時要預先帶入的搜尋關鍵字（例如從說明視窗的相關詞彙點入）。
   * 有值時自動切到「名詞詞彙表」並填入搜尋框；無值則回到概念總覽。
   */
  initialQuery?: string;
}) {
  const [section, setSection] = React.useState<Section>("concepts");
  const [query, setQuery] = React.useState("");
  const [conceptCat, setConceptCat] = React.useState<ConceptCategory | "全部">("全部");
  const [glossaryCat, setGlossaryCat] = React.useState<GlossaryCategory | "全部">("全部");

  // 每次開啟時依 initialQuery 決定初始檢視：帶詞彙 → 詞彙表 + 預填搜尋；否則概念總覽。
  React.useEffect(() => {
    if (!open) return;
    if (initialQuery) {
      setSection("glossary");
      setQuery(initialQuery);
      setGlossaryCat("全部");
    } else {
      setSection("concepts");
      setQuery("");
    }
  }, [open, initialQuery]);

  const q = query.trim();

  const concepts = React.useMemo(() => {
    return CONCEPTS.filter((c) => {
      if (conceptCat !== "全部" && c.category !== conceptCat) return false;
      if (!q) return true;
      const hay = `${c.title}${c.body.join("")}${c.category}`;
      return hay.includes(q);
    });
  }, [q, conceptCat]);

  const terms = React.useMemo(() => {
    return GLOSSARY.filter((t) => {
      if (glossaryCat !== "全部" && t.category !== glossaryCat) return false;
      if (!q) return true;
      return `${t.term}${t.definition}${t.category}`.includes(q);
    });
  }, [q, glossaryCat]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[88vh] flex-col gap-0 overflow-hidden border-white/15 bg-zinc-900 p-0 text-white sm:max-w-2xl"
        data-testid="dialog-encyclopedia"
      >
        <DialogHeader className="border-b border-white/10 px-5 pb-4 pt-5 text-left">
          <DialogTitle className="flex items-center gap-2 font-serif text-lg">
            <BookOpen className="h-5 w-5 text-amber-300" />
            遊戲百科
          </DialogTitle>
          <DialogDescription className="text-white/60">
            查閱所有專有名詞與遊戲概念、機制；不確定某個介面怎麼玩時的第一站。
          </DialogDescription>
        </DialogHeader>

        {/* 控制列：搜尋 + 主分區切換 */}
        <div className="space-y-3 border-b border-white/10 px-5 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋名詞或概念…"
              className="w-full rounded-lg border border-white/20 bg-black/40 py-2 pl-9 pr-9 text-sm outline-none focus:border-amber-300/70"
              data-testid="input-encyclopedia-search"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-white/50 hover:bg-white/10 hover:text-white"
                aria-label="清除搜尋"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex gap-1.5">
            {(
              [
                { key: "concepts", label: "概念與機制" },
                { key: "glossary", label: "名詞詞彙表" },
              ] as { key: Section; label: string }[]
            ).map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSection(s.key)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  section === s.key
                    ? "bg-amber-500/85 text-black"
                    : "bg-white/5 text-white/70 hover:bg-white/10"
                }`}
                data-testid={`tab-encyclopedia-${s.key}`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* 分類篩選 */}
          {section === "concepts" ? (
            <CategoryChips
              options={["全部", ...CONCEPT_CATEGORIES]}
              value={conceptCat}
              onChange={(v) => setConceptCat(v as ConceptCategory | "全部")}
            />
          ) : (
            <CategoryChips
              options={["全部", ...GLOSSARY_CATEGORIES]}
              value={glossaryCat}
              onChange={(v) => setGlossaryCat(v as GlossaryCategory | "全部")}
            />
          )}
        </div>

        {/* 內容區 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="encyclopedia-body">
          {section === "concepts" ? (
            concepts.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="space-y-3">
                {concepts.map((c) => (
                  <article
                    key={c.title}
                    className="rounded-xl border border-white/10 bg-white/5 p-4"
                    data-testid={`concept-${c.title}`}
                  >
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold text-amber-200">
                        {c.category}
                      </span>
                      <h3 className="font-serif text-base font-bold">{c.title}</h3>
                    </div>
                    <div className="space-y-2 text-sm leading-relaxed text-white/80">
                      {c.body.map((p, i) => (
                        <p key={i}>{p}</p>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            )
          ) : terms.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-2">
              {terms.map((t) => (
                <div
                  key={t.term}
                  className="rounded-lg border border-white/10 bg-white/5 p-3"
                  data-testid={`term-${t.term}`}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <h3 className="font-bold text-white">{t.term}</h3>
                    <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/50">
                      {t.category}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed text-white/75">{t.definition}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部：重新開啟新手教學 */}
        <div className="flex items-center justify-between gap-3 border-t border-white/10 bg-black/30 px-5 py-3">
          <span className="text-xs text-white/50">第一次玩？可重新觀看新手教學。</span>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false);
              onStartOnboarding();
            }}
            className="flex items-center gap-1.5 rounded-lg border border-amber-300/50 bg-amber-500/15 px-3 py-1.5 text-sm font-semibold text-amber-100 transition hover:bg-amber-500/25"
            data-testid="button-reopen-onboarding"
          >
            <GraduationCap className="h-4 w-4" />
            開啟新手教學
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CategoryChips({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded-full border px-2.5 py-1 text-[11px] transition ${
            value === opt
              ? "border-amber-300/60 bg-amber-500/20 text-amber-100"
              : "border-white/15 bg-white/5 text-white/60 hover:bg-white/10"
          }`}
          data-testid={`chip-cat-${opt}`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-12 text-center text-white/50"
      data-testid="encyclopedia-empty"
    >
      <Search className="h-8 w-8 text-white/25" />
      <p className="text-sm">找不到符合的內容，換個關鍵字或分類試試。</p>
    </div>
  );
}
