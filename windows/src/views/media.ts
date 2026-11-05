// media.ts — Universal Media Pill (overview right column)
// Compact pill showing current track + controls on hover, click opens lyrics panel.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Media, fmtTime } from "../core/media";
import { buildLyricsPanel } from "./lyrics";
import { t } from "../i18n/i18n";

export interface MediaPillHost {
  el: HTMLElement;
  sync(): void;
}

// Color for media pill (dynamic based on artwork or fallback)
const MEDIA_COLOR = "#1DB954"; // Spotify green as default

function lighter(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => Math.min(255, Math.round(x + amount * 255)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function mediaButton(color: string, icon: string, onClick: () => void, title: string): HTMLElement {
  const b = h("button", { class: "np-pill-btn", title }, svg(icon, 8));
  b.style.borderColor = `${color}24`;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  b.addEventListener("mouseenter", () => {
    b.style.background = `${color}2e`;
    b.style.borderColor = `${color}8c`;
    b.style.color = lighter(color, 0.3);
    b.style.boxShadow = `0 0 6px ${color}59`;
  });
  b.addEventListener("mouseleave", () => {
    b.style.background = "";
    b.style.borderColor = `${color}24`;
    b.style.color = "";
    b.style.boxShadow = "";
  });
  return b;
}

export function buildMediaPill(
  task: { id: string; name: string; color: string },
  onTap: () => void,
  onLyrics: () => void,
): MediaPillHost {
  const color = task.color || MEDIA_COLOR;
  const mini = h("div", { class: "mini-bot" }); // placeholder for Mochi mini
  mini.style.background = color;
  const label = h("span", { class: "lbl", text: task.name });
  const playBtn = mediaButton(color, ICONS.play, () => void Media.togglePlayPause(), t("Play"));
  const nextBtn = mediaButton(color, ICONS.forward, () => void Media.next(), t("Next"));
  const prevBtn = mediaButton(color, ICONS.backward, () => void Media.previous(), t("Previous"));
  const lyricsBtn = mediaButton(color, ICONS.bubbleRound, () => {
    onTap();
    onLyrics();
  }, t("Lyrics"));
  const controls = h("div", { class: "np-pill-controls" }, prevBtn, playBtn, nextBtn, lyricsBtn);
  const pill = h("div", { class: "pill np-pill media-pill", onclick: onTap }, mini, label, controls);
  pill.style.borderColor = `${color}24`;

  let hovered = false;
  let playing: boolean | null = null;
  let currentTrackId = "";

  const sync = () => {
    const s = Media.state;
    const track = s.track;

    // Update label with track title when playing
    if (track) {
      const display = `${track.title} — ${track.artist}`;
      if (label.textContent !== display) label.textContent = display;
    } else {
      if (label.textContent !== task.name) label.textContent = task.name;
    }

    // Show controls on hover when track loaded
    const show = hovered && track != null;
    pill.classList.toggle("controls", show);

    // Play/pause icon
    if (playing !== s.playing) {
      playing = s.playing;
      clear(playBtn);
      playBtn.append(svg(s.playing ? ICONS.pause : ICONS.play, 8));
    }
    playBtn.title = s.playing ? t("Pause") : t("Play");
    nextBtn.title = t("Next");
    prevBtn.title = t("Previous");
    lyricsBtn.title = t("Lyrics");

    // Update mini bot animation state (dancing when playing)
    mini.classList.toggle("dancing", s.playing);

    // Track changed — refresh artwork
    if (track && track.trackId !== currentTrackId) {
      currentTrackId = track.trackId;
      Media.refreshArtwork();
    }
  };

  pill.addEventListener("mouseenter", () => {
    hovered = true;
    pill.style.background = `${color}2e`;
    pill.style.borderColor = `${color}8c`;
    pill.style.boxShadow = `0 2px 10px ${color}59`;
    label.style.color = lighter(color, 0.3);
    sync();
  });

  pill.addEventListener("mouseleave", () => {
    hovered = false;
    pill.style.background = "";
    pill.style.borderColor = `${color}24`;
    pill.style.boxShadow = "";
    label.style.color = "";
    sync();
  });

  // Subscribe to media state
  Media.subscribe(sync);

  sync();
  return { el: pill, sync };
}

// ── Media Card (overview left card — expanded view) ────────────────────────────

export interface MediaCardHost {
  el: HTMLElement;
  sync(): void;
  toggleLyrics(): void;
}

class ProgressBar {
  readonly el: HTMLElement;
  private fill: HTMLElement;
  private knob: HTMLElement;
  private trackEl: HTMLElement;
  private hovering = false;
  private dragging = false;
  private fraction = 0;
  enabled = true;
  private onChange: (f: number) => void;
  private onCommit: (f: number) => void;

  constructor(onChange: (f: number) => void, onCommit: (f: number) => void) {
    this.onChange = onChange;
    this.onCommit = onCommit;
    this.fill = h("i", { class: "np-fill" });
    this.knob = h("i", { class: "np-knob" });
    this.trackEl = h("i", { class: "np-track" });
    this.el = h("div", { class: "np-bar" }, this.trackEl, this.fill, this.knob);

    this.el.addEventListener("mouseenter", () => { this.hovering = true; this.paint(); });
    this.el.addEventListener("mouseleave", () => { this.hovering = false; this.paint(); });
    this.el.addEventListener("pointerdown", (e) => {
      if (!this.enabled || e.button !== 0) return;
      e.stopPropagation();
      this.dragging = true;
      try { this.el.setPointerCapture(e.pointerId); } catch {}
      this.onChange(this.at(e.clientX));
      this.paint();
    });
    this.el.addEventListener("pointermove", (e) => { if (this.dragging) this.onChange(this.at(e.clientX)); });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.onCommit(this.at(e.clientX));
      this.paint();
    };
    this.el.addEventListener("pointerup", end);
    this.el.addEventListener("pointercancel", end);
  }

  get active() { return this.enabled && (this.hovering || this.dragging); }

  private at(x: number) {
    const r = this.el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / Math.max(1, r.width)));
  }

  set(f: number) { this.fraction = Math.min(1, Math.max(0, f)); this.paint(); }

  private paint() {
    const active = this.active;
    this.el.classList.toggle("active", active);
    const pct = `${this.fraction * 100}%`;
    this.fill.style.width = pct;
    this.fill.style.background = active ? MEDIA_COLOR : "#C5C8CD";
    this.knob.style.left = `clamp(0px, calc(${pct} - 4.5px), calc(100% - 9px))`;
  }
}

function iconBtn(icon: string, size: number, stroke: number, onClick: () => void): HTMLElement {
  const b = h("button", { class: "np-icon" }, svg(icon, size, stroke ? { stroke } : {}));
  b.addEventListener("click", onClick);
  return b;
}

export function buildMediaCard(): MediaCardHost {
  const color = MEDIA_COLOR;

  // Artwork
  const art = h("div", { class: "np-art" });
  const artImg = h("img", { alt: "", draggable: "false" }) as HTMLImageElement;
  const artNote = svg(ICONS.musicNote, 16);
  artNote.style.color = `${color}b3`;
  art.append(artNote, artImg);

  const title = h("span", { class: "np-title" });
  const subtitle = h("div", { class: "np-sub" });
  const head = h("div", { class: "np-head" },
    art,
    h("div", { class: "np-text" }, h("div", { class: "np-title-row" }, dot(color, 6), title), subtitle),
  );

  let dragFraction: number | null = null;
  const elapsed = h("span", { class: "np-time elapsed" });
  const remaining = h("span", { class: "np-time remaining" });

  const progress = new ProgressBar(
    (f) => { dragFraction = f; paintProgress(); },
    (f) => { dragFraction = null; Media.seek(f * (Media.state.track?.duration ?? 0)); }
  );
  const progressRow = h("div", { class: "np-progress" }, elapsed, progress.el, remaining);

  // Controls row
  const prev = iconBtn(ICONS.backward, 11, 0, () => void Media.previous());
  const next = iconBtn(ICONS.forward, 11, 0, () => void Media.next());
  prev.title = t("Previous");
  next.title = t("Next");
  prev.style.color = "#C5C8CD";
  next.style.color = "#C5C8CD";
  const play = h("button", { class: "np-play", onclick: () => void Media.togglePlayPause() });
  play.style.background = color;
  play.style.color = "#101114";

  // Volume
  const volIcon = h("span", { class: "np-vol-icon" });
  const volume = new ProgressBar(
    (f) => Media.setVolume(f * 100),
    (f) => Media.setVolume(f * 100)
  );
  const volumeRow = h("div", { class: "np-volume" }, volIcon, volume.el);

  const controlsRow = h("div", { class: "np-controls" },
    h("div", { class: "np-buttons" }, prev, play, next),
    h("div", { class: "grow" }),
    volumeRow
  );

  // Lyrics panel (initially hidden, toggled by button in pill)
  const lyricsPanel = buildLyricsPanel();
  lyricsPanel.el.style.display = "none";

  const card = h("div", { class: "np-card media-card" }, head, progressRow, controlsRow, lyricsPanel.el);

  const paintProgress = () => {
    const s = Media.state;
    const track = s.track;
    const dur = track?.duration ?? 0;
    const pos = dragFraction != null ? dragFraction * dur : s.timeline.position;
    const rem = Math.max(0, dur - pos);
    elapsed.textContent = fmtTime(pos);
    remaining.textContent = dur > 0 ? `-${fmtTime(rem)}` : "";
    progress.enabled = !!track && dur > 0;
    volume.enabled = track != null;
    progress.set(dur > 0 ? pos / dur : 0);

    // Play button icon
    clear(play);
    play.append(svg(s.playing ? ICONS.pause : ICONS.play, 16));

    // Volume icon
    clear(volIcon);
    const volumeIcon = s.volume === 0 ? ICONS.volume0 : s.volume < 33 ? ICONS.volume1 : s.volume < 66 ? ICONS.volume2 : ICONS.volume3;
    volIcon.append(svg(volumeIcon, 12, { stroke: 2 }));
    volume.set(s.volume / 100);
    volumeRow.title = t("Volume {0}%", { 0: Math.round(s.volume) });
  };

  const sync = () => {
    const s = Media.state;
    const track = s.track;

    if (track) {
      title.textContent = track.title || "Unknown Title";
      const details = [track.artist, track.album].filter(Boolean);

      // Artwork
      if (track.artworkUrl) {
        if (artImg.getAttribute("src") !== track.artworkUrl) artImg.src = track.artworkUrl;
        art.classList.add("has-art");
      } else {
        art.classList.remove("has-art");
        artImg.removeAttribute("src");
      }

      // Source app indicator
      const source = track.sourceAppId?.replace(".exe", "") || "Media";
      subtitle.textContent = [...details, source].join(" · ");
    } else {
      title.textContent = t("Not playing");
      subtitle.textContent = t("Open a music app to see controls");
      art.classList.remove("has-art");
      artImg.removeAttribute("src");
    }
    card.classList.toggle("idle", !track);

    paintProgress();

    // Sync lyrics panel if open
    if (lyricsPanel.el.style.display !== "none") {
      lyricsPanel.sync();
    }
  };

  // Subscribe
  Media.subscribe(sync);

  sync();
  return { el: card, sync, toggleLyrics: lyricsPanel.toggle };
}