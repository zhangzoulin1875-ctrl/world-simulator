import React from "react";
import { useLocation } from "wouter";
import { EncyclopediaDialog } from "@/components/game-encyclopedia";

/**
 * 全域「遊戲百科」開關的 Context。
 *
 * 讓任何頁面（含各子頁的說明視窗「相關詞彙」）都能開啟遊戲百科，並可預先帶入
 * 搜尋關鍵字，直接跳到對應名詞。百科視窗本身由本 Provider 統一渲染（掛在
 * Router 之上），因此切換頁面也能維持一致行為。
 */

type OnboardingStarter = () => void;

interface EncyclopediaContextValue {
  /** 開啟遊戲百科；帶入 query 時自動切到詞彙表並預填搜尋。 */
  openEncyclopedia: (query?: string) => void;
  /**
   * 由首頁註冊「開啟新手教學」的實作（新手教學畫面掛在首頁）。
   * 於其他頁面點「開啟新手教學」時，Provider 會導回首頁再觸發。
   */
  setOnboardingStarter: (fn: OnboardingStarter | null) => void;
}

const EncyclopediaContext =
  React.createContext<EncyclopediaContextValue | null>(null);

export function useEncyclopedia(): EncyclopediaContextValue {
  const ctx = React.useContext(EncyclopediaContext);
  if (!ctx) {
    throw new Error("useEncyclopedia 必須在 EncyclopediaProvider 內使用");
  }
  return ctx;
}

export function EncyclopediaProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [initialQuery, setInitialQuery] = React.useState<string | undefined>(
    undefined,
  );
  const onboardingRef = React.useRef<OnboardingStarter | null>(null);
  const pendingOnboardingRef = React.useRef(false);
  const [, navigate] = useLocation();

  const openEncyclopedia = React.useCallback((query?: string) => {
    setInitialQuery(query);
    setOpen(true);
  }, []);

  const setOnboardingStarter = React.useCallback(
    (fn: OnboardingStarter | null) => {
      onboardingRef.current = fn;
      // 若稍早在子頁請求過新手教學（此時尚未註冊），導回首頁掛載後補觸發一次。
      if (fn && pendingOnboardingRef.current) {
        pendingOnboardingRef.current = false;
        fn();
      }
    },
    [],
  );

  const handleStartOnboarding = React.useCallback(() => {
    if (onboardingRef.current) {
      onboardingRef.current();
    } else {
      pendingOnboardingRef.current = true;
      navigate("/game");
    }
  }, [navigate]);

  const value = React.useMemo(
    () => ({ openEncyclopedia, setOnboardingStarter }),
    [openEncyclopedia, setOnboardingStarter],
  );

  return (
    <EncyclopediaContext.Provider value={value}>
      {children}
      <EncyclopediaDialog
        open={open}
        onOpenChange={setOpen}
        onStartOnboarding={handleStartOnboarding}
        initialQuery={initialQuery}
      />
    </EncyclopediaContext.Provider>
  );
}
