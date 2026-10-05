import { Loader2, ScrollText } from "lucide-react";
import { storyState, type FocusStory } from "@/lib/focus";

/** 國策的「發動背景故事」:有就顯示,還在寫顯示「編寫中」,沒推行過就什麼都不顯示 */
export function FocusStoryBlock({ stories, focusId, isActive }: {
  stories: Record<string, FocusStory>; focusId: string; isActive: boolean;
}) {
  const st = storyState(stories, focusId, isActive);
  if (st.kind === "none") return null;
  if (st.kind === "writing") {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-[11px] text-white/50" data-testid={`story-writing-${focusId}`}>
        <Loader2 className="h-3 w-3 animate-spin" />史官正在記錄這段背景…
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-md border-l-2 border-amber-300/50 bg-amber-500/5 px-2.5 py-1.5" data-testid={`story-${focusId}`} data-source={st.story.source}>
      <div className="mb-0.5 flex items-center gap-1 text-[10px] text-amber-200/70"><ScrollText className="h-3 w-3" />背景</div>
      <p className="text-xs leading-relaxed text-white/80">{st.story.story}</p>
    </div>
  );
}
