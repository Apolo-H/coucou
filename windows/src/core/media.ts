// media.ts — Universal Media Tracker core state (mirrors Spotify state shape)
// TypeScript port of the C# WindowsMediaWatcher + LrcService for the Tauri UI

import { State } from "./state";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Pill ID for the universal media tracker. */
export const MEDIA_ID = "integration_media";

/** Normalized playback status from GSMTC. */
export type PlaybackStatus = "Playing" | "Paused" | "Stopped" | "Unknown";

/** Current track metadata. */
export interface MediaTrack {
  title: string;
  artist: string;
  album: string;
  trackId: string;
  duration: number;           // seconds
  artworkUrl: string | null;  // blob: URL or data: URL
  sourceAppId: string;        // e.g. "Spotify.exe", "Chrome.exe"
}

/** Timeline from GSMTC. */
export interface MediaTimeline {
  position: number;      // seconds
  endTime: number;       // seconds
  lastUpdated: number;   // epoch ms
}

/** Full media state. */
export interface MediaState {
  running: boolean;
  playing: boolean;
  status: PlaybackStatus;
  track: MediaTrack | null;
  timeline: MediaTimeline;
  volume: number;        // 0–100
}

/** Parsed lyric line. */
export interface LyricLine {
  timestamp: number;     // seconds
  text: string;
}

/** Lyrics search result. */
export interface LyricsResult {
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  syncedLyrics: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
}

/** Global singleton state. */
export const Media = {
  state: {
    running: false,
    playing: false,
    status: "Unknown" as PlaybackStatus,
    track: null as MediaTrack | null,
    timeline: { position: 0, endTime: 0, lastUpdated: 0 },
    volume: 50,
  } as MediaState,

  /** Cached parsed lyrics for current track. */
  lyrics: [] as LyricLine[],
  lyricsTrackId: "",

  /** Currently visible lyrics window (for scroll). */
  visibleLyrics: { currentIndex: -1, lines: [] as LyricLine[] },

  /** Subscribe to state changes. */
  subscribe(cb: () => void) {
    return State.subscribe(cb);
  },

  /** Update state from Tauri event. */
  apply(next: Partial<MediaState>) {
    this.state = { ...this.state, ...next };
    State.notify();
  },

  /** Update timeline (high frequency, throttled in Rust). */
  applyTimeline(tl: MediaTimeline) {
    this.state.timeline = tl;
    this.updateVisibleLyrics();
    State.notify();
  },

  /** Update playback state. */
  applyPlayback(status: PlaybackStatus) {
    this.state.status = status;
    this.state.playing = status === "Playing";
    State.notify();
  },

  /** Track changed — fetch new lyrics. */
  async applyTrack(track: MediaTrack | null) {
    this.state.track = track;
    this.state.running = track !== null;
    if (track) {
      this.lyricsTrackId = track.trackId;
      await this.fetchLyrics(track);
    } else {
      this.lyrics = [];
      this.lyricsTrackId = "";
      this.visibleLyrics = { currentIndex: -1, lines: [] };
    }
    State.notify();
  },

  /** Fetch and parse lyrics via Tauri command. */
  async fetchLyrics(track: MediaTrack) {
    try {
      const result = await invoke<LyricsResult | null>("media_get_lyrics", {
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: Math.round(track.duration),
      });
      if (result?.syncedLyrics) {
        this.lyrics = parseLrc(result.syncedLyrics);
      } else {
        this.lyrics = [];
      }
    } catch {
      this.lyrics = [];
    }
    this.updateVisibleLyrics();
  },

  /** Compute visible lyrics window for current position. */
  updateVisibleLyrics() {
    const pos = this.state.timeline.position;
    getCurrentLineIndex(pos, this.lyrics);
    const { currentIndex, lines } = getVisibleLines(pos, this.lyrics);
    this.visibleLyrics = { currentIndex, lines };
  },

  /** Seek to position (seconds). */
  async seek(seconds: number) {
    const t = Math.max(0, Math.min(seconds, this.state.track?.duration ?? seconds));
    await invoke("media_seek", { position: t });
  },

  /** Toggle play/pause. */
  async togglePlayPause() {
    await invoke("media_play_pause");
  },

  /** Next track. */
  async next() {
    await invoke("media_next");
  },

  /** Previous track. */
  async previous() {
    await invoke("media_previous");
  },

  /** Set volume 0–100. */
  async setVolume(vol: number) {
    const v = Math.max(0, Math.min(100, Math.round(vol)));
    await invoke("media_set_volume", { volume: v });
  },

  /** Get artwork as blob URL. */
  async refreshArtwork() {
    if (!this.state.track) return;
    try {
      const bytes = await invoke<number[] | null>("media_get_artwork");
      if (bytes) {
        const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
        const url = URL.createObjectURL(blob);
        this.state.track = { ...this.state.track, artworkUrl: url };
        State.notify();
      }
    } catch { /* ignore */ }
  },
};

/** Parse LRC text into sorted LyricLine[]. */
export function parseLrc(raw: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const regex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3})|:(\d{2}))?\]\s*(.*)/;

  for (const line of raw.split(/\r?\n/)) {
    const m = line.trim().match(regex);
    if (!m) continue;

    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    let ms = 0;
    if (m[3]) {
      ms = m[3].length === 2 ? parseInt(m[3], 10) * 10 : parseInt(m[3], 10);
    } else if (m[4]) {
      ms = parseInt(m[4], 10) * 10;
    }
    const text = m[5].trim();
    if (/^(ti|ar|al|by|offset|re):/i.test(text)) continue;

    lines.push({ timestamp: min * 60 + sec + ms / 1000, text });
  }
  lines.sort((a, b) => a.timestamp - b.timestamp);
  return lines;
}

/** Binary search for current line index. */
export function getCurrentLineIndex(position: number, lyrics: LyricLine[]): number {
  if (!lyrics.length) return -1;
  let lo = 0, hi = lyrics.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyrics[mid].timestamp <= position) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Visible window around current line. */
export function getVisibleLines(
  position: number,
  lyrics: LyricLine[],
  before = 2,
  after = 4
): { currentIndex: number; lines: LyricLine[] } {
  const idx = getCurrentLineIndex(position, lyrics);
  const current = Math.max(0, idx);
  const start = Math.max(0, current - before);
  const end = Math.min(lyrics.length, current + after + 1);
  return { currentIndex: current - start, lines: lyrics.slice(start, end) };
}

/** Progress 0–1 within current line (for karaoke highlight). */
export function getLineProgress(position: number, lyrics: LyricLine[], currentIndex: number): number {
  if (currentIndex < 0 || currentIndex >= lyrics.length) return 0;
  const cur = lyrics[currentIndex];
  const next = lyrics[currentIndex + 1];
  const dur = (next?.timestamp ?? position + 3) - cur.timestamp;
  if (dur <= 0) return 1;
  const elapsed = position - cur.timestamp;
  if (elapsed <= 0) return 0;
  return Math.min(1, elapsed / dur);
}

/** Format seconds as mm:ss. */
export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Register Tauri event listeners. */
export async function registerMediaListeners() {
  await listen<MediaState>("media-state", (e) => Media.apply(e.payload));
  await listen<MediaTimeline>("media-timeline", (e) => Media.applyTimeline(e.payload));
  await listen<PlaybackStatus>("media-playback", (e) => Media.applyPlayback(e.payload));
  await listen<MediaTrack | null>("media-track", (e) => Media.applyTrack(e.payload));
  // Initial state
  const init = await invoke<MediaState>("media_get_state");
  if (init) Media.apply(init);
}