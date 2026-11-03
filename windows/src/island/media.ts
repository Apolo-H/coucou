// island/media.ts — Island event handlers for Universal Media Tracker
// Connects Tauri events (from Rust GSMTC) → TypeScript Media state

import { onEvent } from "../core/bridge";
import { State } from "../core/state";
import type { MediaState, MediaTimeline, PlaybackStatus, MediaTrack } from "../core/media";
import { Media, registerMediaListeners, MEDIA_ID } from "../core/media";

export interface MediaHost {
  /** Show island silently when media starts playing. */
  revealSilently(): void;
}

/** Register all media-related Tauri event handlers. */
export function registerMediaHandlers(host: MediaHost) {
  // Full state updates
  void onEvent<MediaState>("media-state", (s) => applyMediaState(host, s));

  // High-frequency timeline updates
  void onEvent<MediaTimeline>("media-timeline", (tl) => {
    Media.applyTimeline(tl);
  });

  // Playback status changes
  void onEvent<PlaybackStatus>("media-playback", (status) => {
    Media.applyPlayback(status);
    // Reveal silently on Playing from hidden
    if (status === "Playing" && !State.spotifyPlaying && !State.paused && State.mode === "hidden") {
      host.revealSilently();
    }
  });

  // Track metadata changes
  void onEvent<MediaTrack | null>("media-track", (track) => {
    Media.applyTrack(track);
  });

  // Artwork blob updates
  void onEvent<{ artUrl: string; dataUrl: string }>("media-artwork", (art) => {
    if (Media.state.track) {
      Media.state.track = { ...Media.state.track, artworkUrl: art.dataUrl };
      State.notify();
    }
  });

  // Subscribe to state changes for pill name sync
  State.subscribe(() => {
    syncPillName();
  });

  // Initialize listeners (also fetches initial state)
  registerMediaListeners();
}

/** Apply full state from Tauri. */
function applyMediaState(host: MediaHost, next: MediaState) {
  const wasPlaying = Media.state.playing;
  Media.apply(next);

  // Reveal on play transition from hidden
  if (!wasPlaying && Media.state.playing && !State.paused && State.mode === "hidden") {
    host.revealSilently();
  }
}

/** Sync pill name with current track title. */
export function syncPillName() {
  // Find the media pill task
  const task = State.tasks.find((t) => t.id === MEDIA_ID);
  if (!task) return;

  const track = Media.state.track;
  const title = track?.title ?? "";
  const def = pillDefinitionSync(MEDIA_ID);
  const name = title || (def?.name ?? "Media");
  if (task.name !== name) task.name = name;
}

/** Synchronous pill definition lookup (avoids circular import). */
function pillDefinitionSync(id: string) {
  // This mirrors the logic from pills.ts without importing it
  if (id === "integration_media") {
    return { name: "Media", color: "#1DB954" };
  }
  return undefined;
}