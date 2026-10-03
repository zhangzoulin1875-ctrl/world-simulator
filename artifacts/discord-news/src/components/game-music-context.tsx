import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useListGameMusicTracks,
  getListGameMusicTracksQueryKey,
} from "@workspace/api-client-react";
import type { GameMusicTrack } from "@workspace/api-client-react";

/**
 * 背景音樂全域狀態。<audio> 元素常駐於 App 層，
 * 切換任何頁面（/game ↔ /world-map ↔ 管理頁等）音樂都不中斷。
 * 因瀏覽器自動播放限制，不自動播放。
 */
interface GameMusicState {
  tracks: GameMusicTrack[];
  track: GameMusicTrack | null;
  index: number;
  playing: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  togglePlay: () => void;
  goTo: (nextIndex: number) => void;
  seekPreview: (value: number) => void;
  seekCommit: (value: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
}

const GameMusicContext = createContext<GameMusicState | null>(null);

// localStorage 偏好持久化（音量／靜音／上次曲目／上次播放秒數）。
// 只還原設定與播放進度，不還原播放中狀態（瀏覽器自動播放限制）。
const STORAGE_KEY = "gameMusicPrefs";

// 播放中每隔幾毫秒才寫入一次進度，避免過度寫入 localStorage。
const POSITION_SAVE_INTERVAL_MS = 5000;

interface StoredMusicPrefs {
  volume?: number;
  muted?: boolean;
  trackId?: string;
  positionSec?: number;
}

function loadStoredPrefs(): StoredMusicPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const obj = parsed as Record<string, unknown>;
    const prefs: StoredMusicPrefs = {};
    if (
      typeof obj.volume === "number" &&
      Number.isFinite(obj.volume) &&
      obj.volume >= 0 &&
      obj.volume <= 1
    ) {
      prefs.volume = obj.volume;
    }
    if (typeof obj.muted === "boolean") {
      prefs.muted = obj.muted;
    }
    if (typeof obj.trackId === "string" && obj.trackId.length > 0) {
      prefs.trackId = obj.trackId;
    }
    if (
      typeof obj.positionSec === "number" &&
      Number.isFinite(obj.positionSec) &&
      obj.positionSec >= 0
    ) {
      prefs.positionSec = obj.positionSec;
    }
    return prefs;
  } catch {
    return {};
  }
}

function saveStoredPrefs(prefs: StoredMusicPrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage 不可用（隱私模式等）時靜默略過
  }
}

export function useGameMusic(): GameMusicState {
  const ctx = useContext(GameMusicContext);
  if (!ctx) {
    throw new Error("useGameMusic 必須在 GameMusicProvider 內使用");
  }
  return ctx;
}

export function GameMusicProvider({ children }: { children: React.ReactNode }) {
  const { data } = useListGameMusicTracks({
    query: {
      queryKey: getListGameMusicTracksQueryKey(),
      staleTime: 1000 * 60 * 5,
    },
  });
  const tracks = useMemo(() => data?.tracks ?? [], [data?.tracks]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const storedPrefsRef = useRef<StoredMusicPrefs | null>(null);
  if (storedPrefsRef.current === null) {
    storedPrefsRef.current = loadStoredPrefs();
  }
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(storedPrefsRef.current.muted ?? false);
  const [volume, setVolumeState] = useState(
    storedPrefsRef.current.volume ?? 0.6,
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const restoredTrackRef = useRef(false);
  // 目前曲目最新的播放秒數（供寫入 localStorage，避免頻繁重跑 effect）。
  const positionRef = useRef(0);
  // 上次寫入進度的時間戳，用來節流 onTimeUpdate 的寫入頻率。
  const lastPositionSaveRef = useRef(0);
  // 待還原的播放秒數，只在「還原的曲目與存的相同」時套用一次。
  const restorePositionRef = useRef<number | null>(
    storedPrefsRef.current.positionSec ?? null,
  );

  // 曲目清單載入後，還原上次播放的曲目（找不到就 fallback 第一首）。
  useEffect(() => {
    if (restoredTrackRef.current || tracks.length === 0) return;
    restoredTrackRef.current = true;
    const storedId = storedPrefsRef.current?.trackId;
    if (!storedId) {
      restorePositionRef.current = null;
      return;
    }
    const storedIndex = tracks.findIndex((t) => t.id === storedId);
    if (storedIndex < 0) {
      // 存的曲目已不存在，放棄還原進度。
      restorePositionRef.current = null;
      return;
    }
    if (storedIndex > 0) setIndex(storedIndex);
  }, [tracks]);

  // Keep the index valid if tracks change (e.g. admin deleted one).
  useEffect(() => {
    if (tracks.length > 0 && index >= tracks.length) setIndex(0);
  }, [tracks.length, index]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = muted;
  }, [volume, muted]);

  const track =
    tracks.length > 0 ? tracks[Math.min(index, tracks.length - 1)] : null;

  // 目前偏好（含播放進度）寫入 localStorage。以最新的 positionRef 為準。
  const writePrefs = () => {
    saveStoredPrefs({
      volume,
      muted,
      trackId: track?.id ?? storedPrefsRef.current?.trackId,
      positionSec: positionRef.current,
    });
  };
  const writePrefsRef = useRef(writePrefs);
  writePrefsRef.current = writePrefs;

  // Switch source when the track changes; keep playing state.
  // 換曲時進度歸零（該曲從頭），除非稍後由 restorePositionRef 還原。
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !track) return;
    positionRef.current = 0;
    setCurrentTime(0);
    setDuration(0);
    audio.src = track.url;
    audio.load();
    if (playing) {
      audio.play().catch(() => setPlaying(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);

  // 偏好變更即寫入 localStorage（曲目清單載入前不覆寫已存的 trackId）。
  useEffect(() => {
    writePrefs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume, muted, track?.id]);

  // 離開頁面／切到背景時保存最新進度。
  useEffect(() => {
    const flush = () => writePrefsRef.current();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const goTo = (nextIndex: number) => {
    if (tracks.length === 0) return;
    // 玩家主動換曲後不再套用還原進度。
    restorePositionRef.current = null;
    setIndex(((nextIndex % tracks.length) + tracks.length) % tracks.length);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      audio
        .play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    }
  };

  const seekPreview = (value: number) => {
    setSeeking(true);
    setCurrentTime(value);
  };

  const seekCommit = (value: number) => {
    setSeeking(false);
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(duration) || duration <= 0) return;
    audio.currentTime = value;
    setCurrentTime(value);
    positionRef.current = value;
    writePrefs();
  };

  const setVolume = (v: number) => {
    setVolumeState(v);
    if (v > 0 && muted) setMuted(false);
  };

  const toggleMute = () => setMuted((m) => !m);

  const value: GameMusicState = {
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
  };

  return (
    <GameMusicContext.Provider value={value}>
      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(e) => {
          if (seeking) return;
          const t = e.currentTarget.currentTime;
          setCurrentTime(t);
          positionRef.current = t;
          const now = Date.now();
          if (now - lastPositionSaveRef.current > POSITION_SAVE_INTERVAL_MS) {
            lastPositionSaveRef.current = now;
            writePrefs();
          }
        }}
        onLoadedMetadata={(e) => {
          const audio = e.currentTarget;
          setDuration(audio.duration);
          // 若還原的曲目與存的相同，從存的秒數開始（超出曲長則從頭）。
          const pos = restorePositionRef.current;
          if (pos != null && track?.id === storedPrefsRef.current?.trackId) {
            restorePositionRef.current = null;
            if (Number.isFinite(audio.duration) && pos > 0 && pos < audio.duration) {
              audio.currentTime = pos;
              setCurrentTime(pos);
              positionRef.current = pos;
            }
          }
        }}
        onEnded={() => {
          // playlist loop
          if (tracks.length <= 1) {
            const audio = audioRef.current;
            if (audio) {
              audio.currentTime = 0;
              audio.play().catch(() => setPlaying(false));
            }
          } else {
            goTo(index + 1);
          }
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          writePrefs();
        }}
      />
      {children}
    </GameMusicContext.Provider>
  );
}
