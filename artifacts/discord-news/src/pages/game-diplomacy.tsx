import { Link } from "wouter";
import { ArrowLeft, Loader2, LogIn, Shield } from "lucide-react";
import {
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
} from "@workspace/api-client-react";
import { useCurrentUser, startDiscordLogin } from "@/lib/current-user";
import { Shell } from "@/components/diplomacy/shared";
import { DiplomacyScreen } from "@/components/diplomacy/diplomacy-screen";

const BASE = import.meta.env.BASE_URL;
const DEFAULT_BG = `${BASE}game/home-bg-default.webp`;

export default function GameDiplomacy() {
  const { data: me, isLoading: loadingMe } = useCurrentUser();
  const authenticated = me?.authenticated === true;

  const { data: nationEnvelope } = useGetPlayerNation({
    query: {
      queryKey: getGetPlayerNationQueryKey(),
      enabled: authenticated,
      staleTime: 1000 * 30,
    },
  });
  const nation = nationEnvelope?.nation ?? null;
  const noNation = nationEnvelope != null && !nationEnvelope.hasNation;
  const bg = nation?.backgroundUrl || DEFAULT_BG;

  if (loadingMe) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center">
          <div className="flex items-center gap-3 rounded-xl bg-black/60 px-6 py-4 text-white backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>載入外交資料中…</span>
          </div>
        </div>
      </Shell>
    );
  }

  if (!authenticated) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#5865f2]">
              <LogIn className="h-7 w-7" />
            </div>
            <h1 className="mb-2 font-serif text-xl font-bold">外交介面</h1>
            <p className="mb-6 text-sm text-white/70">
              請先以 Discord 登入，才能進行外交。
            </p>
            <button
              onClick={() => startDiscordLogin()}
              className="w-full rounded-lg bg-[#5865f2] px-4 py-2.5 text-sm font-semibold transition hover:bg-[#4752c4]"
              data-testid="button-diplomacy-login"
            >
              使用 Discord 登入
            </button>
            <Link
              href="/game"
              className="mt-4 inline-flex items-center gap-1 text-xs text-white/60 hover:text-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              回玩家首頁
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  if (noNation) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <Shield className="mx-auto mb-3 h-10 w-10 text-white/40" />
            <h1 className="mb-2 font-serif text-xl font-bold">尚未建國</h1>
            <p className="mb-6 text-sm text-white/70">
              你還沒有國家。請先到玩家首頁完成建國，再回來進行外交。
            </p>
            <Link
              href="/game"
              className="block w-full rounded-lg bg-amber-500/85 px-4 py-2.5 text-sm font-bold text-black transition hover:bg-amber-400"
              data-testid="button-go-founding"
            >
              前往建國
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  return <DiplomacyScreen bg={bg} resources={nation} />;
}
