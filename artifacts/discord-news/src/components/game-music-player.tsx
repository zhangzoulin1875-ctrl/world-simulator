import { useState } from "react";
import { useLocation } from "wouter";
import {
  Music,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  ListMusic,
  X,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useGameMusic } from "@/components/game-music-context";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 背景音樂播放器 UI。播放狀態與 <audio> 常駐於
 * GameMusicProvider（App 層），此元件僅是控制面板，切換任何頁面時
 * 音樂不中斷。清單循環、可切換上下一首、播放清單選歌、拖曳進度
 * （音檔端點支援 HTTP Range）、音量／靜音。沒有任何曲目時整個元件不渲染。
 */
export function GameMusicPlayer() {
  const {
    tracks,
    track,
    index,
    playing,
    muted,
    volume,
    currentTime,
    duration,
    togglePlay,
    goTo,
    seekPreview,
    seekCommit,
    setVolume,
    toggleMute,
  } = useGameMusic();

  if (!track) return null;

  return (
    <div
      className="flex min-w-0 items-center gap-1.5 rounded-lg border border-white/15 bg-black/50 px-2 py-1.5 backdrop-blur sm:gap-2 sm:px-3 sm:py-2"
      title="背景音樂"
      data-testid="game-music-player"
    >
      <Music className="hidden h-4 w-4 shrink-0 text-amber-300 sm:block" />

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={() => goTo(index - 1)}
          className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
          disabled={tracks.length <= 1}
          title="上一首"
          aria-label="上一首"
          data-testid="button-music-prev"
        >
          <SkipBack className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={togglePlay}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white transition hover:bg-white/20"
          title={playing ? "暫停" : "播放"}
          aria-label={playing ? "暫停" : "播放"}
          data-testid="button-music-toggle"
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
        </button>
        <button
          onClick={() => goTo(index + 1)}
          className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white disabled:opacity-40"
          disabled={tracks.length <= 1}
          title="下一首"
          aria-label="下一首"
          data-testid="button-music-next"
        >
          <SkipForward className="h-3.5 w-3.5" />
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
              title="播放清單"
              aria-label="播放清單"
              data-testid="button-music-playlist"
            >
              <ListMusic className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            className="w-64 border-white/15 bg-zinc-900/95 p-1.5 text-white backdrop-blur"
          >
            <div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold text-white/50">
              播放清單（{tracks.length} 首）
            </div>
            <div className="max-h-64 overflow-y-auto">
              {tracks.map((t, i) => (
                <button
                  key={t.id}
                  onClick={() => goTo(i)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-white/10 ${
                    i === index ? "text-amber-300" : "text-white/85"
                  }`}
                  data-testid={`button-music-track-${i}`}
                >
                  <span className="w-4 shrink-0 text-center">
                    {i === index ? (
                      playing ? (
                        <Pause className="mx-auto h-3 w-3" />
                      ) : (
                        <Play className="mx-auto h-3 w-3" />
                      )
                    ) : (
                      <span className="tabular-nums text-white/40">{i + 1}</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={t.title}>
                    {t.title}
                  </span>
                  {i === index && (
                    <span className="shrink-0 text-[10px] text-amber-300/80">
                      播放中
                    </span>
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="hidden min-w-0 leading-tight sm:block sm:w-36 md:w-44">
        <div
          className="truncate text-xs font-semibold text-white/90"
          data-testid="text-music-title"
          title={track.title}
        >
          {track.title}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] tabular-nums text-white/50">
            {formatTime(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={Number.isFinite(duration) && duration > 0 ? duration : 0}
            step={0.1}
            value={Math.min(currentTime, duration || 0)}
            onChange={(e) => {
              seekPreview(Number(e.target.value));
            }}
            onMouseUp={(e) => {
              seekCommit(Number((e.target as HTMLInputElement).value));
            }}
            onTouchEnd={(e) => {
              seekCommit(Number((e.target as HTMLInputElement).value));
            }}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-amber-300"
            aria-label="播放進度"
            data-testid="slider-music-seek"
          />
          <span className="text-[10px] tabular-nums text-white/50">
            {formatTime(duration)}
          </span>
        </div>
      </div>

      <div className="hidden shrink-0 items-center gap-1 md:flex">
        <button
          onClick={toggleMute}
          className="flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
          title={muted ? "取消靜音" : "靜音"}
          aria-label={muted ? "取消靜音" : "靜音"}
          data-testid="button-music-mute"
        >
          {muted || volume === 0 ? (
            <VolumeX className="h-4 w-4" />
          ) : (
            <Volume2 className="h-4 w-4" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="h-1 w-16 cursor-pointer accent-amber-300"
          aria-label="音量"
          data-testid="slider-music-volume"
        />
      </div>

      {/* mobile: mute-only shortcut (no room for slider) */}
      <button
        onClick={toggleMute}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white md:hidden"
        title={muted ? "取消靜音" : "靜音"}
        aria-label={muted ? "取消靜音" : "靜音"}
      >
        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </button>
    </div>
  );
}

/**
 * 浮動播放器。遊戲首頁 /game 已把播放器放在底部欄，故不在 /game 顯示。
 * /game/ 開頭的子頁面（軍事、外交、政治…）恆常顯示；
 * 其他頁面（/world-map 等）只在音樂播放中才顯示，
 * 確保「音樂在響卻找不到控制」不會發生，也不遮擋頁面主要內容。
 * 固定於右下角、蓋在全螢幕頁面（z-50）之上。
 */
export function GameMusicFloatingPlayer() {
  const [location] = useLocation();
  const { playing } = useGameMusic();
  // 關閉狀態僅存在記憶體：換頁保留（此元件常駐於 App 外殼、不卸載），重載歸零。
  const [closed, setClosed] = useState(false);
  // 正規化尾斜線，避免 /game/ 等變體讓浮動播放器誤現身於首頁。
  const path = location.replace(/\/+$/, "") || "/";
  if (path === "/game") return null;
  if (!path.startsWith("/game/") && !playing) return null;
  if (closed) return null;
  return (
    <div
      className="fixed bottom-3 right-3 z-[60] max-w-[calc(100vw-1.5rem)]"
      data-testid="game-music-floating"
    >
      <button
        onClick={() => setClosed(true)}
        className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-white/25 bg-zinc-800 text-white/80 shadow transition hover:bg-zinc-700 hover:text-white"
        title="關閉播放器（重新載入後會再出現）"
        aria-label="關閉播放器"
        data-testid="button-music-floating-close"
      >
        <X className="h-3 w-3" />
      </button>
      <GameMusicPlayer />
    </div>
  );
}
