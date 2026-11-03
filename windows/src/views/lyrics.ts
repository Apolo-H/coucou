// lyrics.ts — Synchronized lyrics panel (Nusa 1.1 style)
// Expandable view with auto-scroll, current line highlight, click-to-seek.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Media, getLineProgress } from "../core/media";

export interface LyricsPanelHost {
  el: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  sync(): void;
}

/** Build the expandable lyrics panel. */
export function buildLyricsPanel(): LyricsPanelHost {
  const panel = h("div", { class: "lyrics-panel" });
  const header = h("div", { class: "lyrics-header" });
  const title = h("span", { class: "lyrics-title" });
  const artist = h("span", { class: "lyrics-artist" });
  const closeBtn = h("button", { class: "lyrics-close", title: "Close lyrics" }, svg(ICONS.xmark, 12, { stroke: 2 }));
  header.append(h("div", { class: "lyrics-head-text" }, title, artist), closeBtn);

  const list = h("div", { class: "lyrics-list" });
  const empty = h("div", { class: "lyrics-empty", text: "No lyrics for this track" });
  list.append(empty);

  panel.append(header, list);

  let open = false;
  let currentTrackId = "";

  const sync = () => {
    const track = Media.state.track;
    const trackId = track?.trackId ?? "";
    const hasLyrics = Media.lyrics.length > 0;

    // Update header
    if (track) {
      title.textContent = track.title || "Unknown Title";
      artist.textContent = track.artist || "Unknown Artist";
    }

    // Track changed — rebuild list
    if (trackId !== currentTrackId) {
      currentTrackId = trackId;
      rebuildList();
    }

    // Update highlight + scroll
    if (hasLyrics) {
      highlightCurrentLine();
    }

    empty.style.display = hasLyrics ? "none" : "flex";
  };

  const rebuildList = () => {
    clear(list);
    if (!Media.lyrics.length) {
      list.append(empty);
      return;
    }

    // Create line elements
    Media.lyrics.forEach((line, idx) => {
      const el = h("div", {
        class: "lyric-line",
        "data-index": String(idx),
      }, line.text || "♪");
      el.addEventListener("click", () => seekToLine(idx));
      list.append(el);
    });
  };

  const highlightCurrentLine = () => {
    const { currentIndex } = Media.visibleLyrics;
    const items = list.querySelectorAll<HTMLElement>(".lyric-line");
    items.forEach((el, i) => {
      const isCurrent = i === currentIndex;
      el.classList.toggle("current", isCurrent);
      if (isCurrent) {
        const progress = getLineProgress(Media.state.timeline.position, Media.lyrics, Media.visibleLyrics.currentIndex);
        el.style.setProperty("--karaoke-progress", String(progress));
        // Smooth scroll into view (center)
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  };

  const seekToLine = async (index: number) => {
    const line = Media.lyrics[index];
    if (!line) return;
    await Media.seek(line.timestamp);
  };

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });

  function openPanel() {
    if (open) return;
    open = true;
    panel.classList.add("open");
    panel.style.display = "flex";
    // Animate in
    requestAnimationFrame(() => panel.classList.add("visible"));
    sync();
  }

  function closePanel() {
    if (!open) return;
    open = false;
    panel.classList.remove("visible");
    setTimeout(() => {
      if (!open) panel.style.display = "none";
    }, 200);
  }

  function toggle() {
    open ? closePanel() : openPanel();
  }

  // Subscribe to media changes
  Media.subscribe(() => {
    if (open) sync();
  });

  return {
    el: panel,
    open: openPanel,
    close: closePanel,
    toggle,
    sync,
  };
}