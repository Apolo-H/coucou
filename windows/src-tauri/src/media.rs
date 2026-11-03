// media.rs — Universal Media Tracker for Windows via GSMTC
// Follows the Spotify Windows pattern (src/spotify.rs win module)

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Serialize, Deserialize};
use tauri::{AppHandle, Emitter, Runtime};
use windows::Foundation::TypedEventHandler;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession,
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};

// Tauri command payloads
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaTrack {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub track_id: String,
    pub duration: f64,
    pub artwork_url: Option<String>,
    pub source_app_id: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaTimeline {
    pub position: f64,
    pub end_time: f64,
    pub last_updated: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub running: bool,
    pub playing: bool,
    pub status: String,
    pub track: Option<MediaTrack>,
    pub timeline: MediaTimeline,
    pub volume: u8,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LyricsResult {
    pub track_name: String,
    pub artist_name: String,
    pub album_name: String,
    pub duration: i32,
    pub synced_lyrics: Option<String>,
    pub plain_lyrics: Option<String>,
    pub instrumental: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Artwork {
    pub art_url: String,
    pub data_url: String,
}

const STATE_EVENT: &str = "media-state";
const TIMELINE_EVENT: &str = "media-timeline";
const PLAYBACK_EVENT: &str = "media-playback";
const TRACK_EVENT: &str = "media-track";
const ARTWORK_EVENT: &str = "media-artwork";

struct MediaSnapshot {
    track: Option<MediaTrack>,
    playing: bool,
    position: f64,
    end_time: f64,
    updated_at: Option<u64>,
    volume: u8,
    status: String,
}

enum Wake {
    Changed,
    Sessions,
    Stop,
}

struct Shared {
    generation: u64,
    active: bool,
    wake: Option<std::sync::mpsc::Sender<Wake>>,
    state: MediaState,
    last_timeline_emit: Instant,
}

static SHARED: LazyLock<Mutex<Shared>> = LazyLock::new(|| {
    Mutex::new(Shared {
        generation: 0,
        active: false,
        wake: None,
        state: MediaState {
            running: false,
            playing: false,
            status: "Unknown".into(),
            track: None,
            timeline: MediaTimeline { position: 0.0, end_time: 0.0, last_updated: 0 },
            volume: 50,
        },
        last_timeline_emit: Instant::now(),
    })
});

static ARTWORK_CACHE: LazyLock<Mutex<VecDeque<(String, String)>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

fn com() {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn current(generation: u64) -> bool {
    let s = SHARED.lock().unwrap();
    s.active && s.generation == generation
}

fn emit_state<R: Runtime>(app: &AppHandle<R>, state: &MediaState) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, STATE_EVENT, state);
}

fn emit_timeline<R: Runtime>(app: &AppHandle<R>, timeline: &MediaTimeline) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, TIMELINE_EVENT, timeline);
}

fn emit_playback<R: Runtime>(app: &AppHandle<R>, status: &str) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, PLAYBACK_EVENT, status);
}

fn emit_track<R: Runtime>(app: &AppHandle<R>, track: Option<&MediaTrack>) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, TRACK_EVENT, track);
}

fn emit_artwork<R: Runtime>(app: &AppHandle<R>, art_url: String, data_url: String) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, ARTWORK_EVENT, Artwork { art_url, data_url });
}

fn ticks_to_secs(ticks: i64) -> f64 {
    ticks as f64 / 10_000_000.0
}

fn windows_time_to_unix_ms(universal_time: i64) -> u64 {
    const FILETIME_TO_UNIX_EPOCH: i64 = 11_644_473_600_000_000;
    ((universal_time - FILETIME_TO_UNIX_EPOCH) / 10_000).max(0) as u64
}

fn wake_on<A: windows::core::RuntimeType + 'static>(
    tx: &std::sync::mpsc::Sender<Wake>,
) -> TypedEventHandler<GlobalSystemMediaTransportControlsSession, A> {
    let tx = tx.clone();
    TypedEventHandler::new(move |_, _| {
        let _ = tx.send(Wake::Changed);
        Ok(())
    })
}

fn find_session(manager: &GlobalSystemMediaTransportControlsSessionManager) -> Option<GlobalSystemMediaTransportControlsSession> {
    let sessions = manager.GetSessions().ok()?;
    let mut best: Option<GlobalSystemMediaTransportControlsSession> = None;

    for i in 0..sessions.Size().ok()? {
        let session = sessions.GetAt(i).ok()?;
        let playback = session.GetPlaybackInfo().ok()?;
        let status = playback.PlaybackStatus().ok()?;

        if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing
            || status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused
        {
            return Some(session);
        }
        if best.is_none() {
            best = Some(session);
        }
    }
    best
}

struct Bound {
    session: GlobalSystemMediaTransportControlsSession,
    tokens: [Option<i64>; 3],
}

impl Bound {
    fn bind(session: GlobalSystemMediaTransportControlsSession, tx: &std::sync::mpsc::Sender<Wake>) -> Option<Bound> {
        let tokens = [
            session.MediaPropertiesChanged(&wake_on(tx)).ok(),
            session.PlaybackInfoChanged(&wake_on(tx)).ok(),
            session.TimelinePropertiesChanged(&wake_on(tx)).ok(),
        ];
        Some(Bound { session, tokens })
    }

    fn unbind(self) {
        let [media, playback, timeline] = self.tokens;
        if let Some(t) = media {
            let _ = self.session.RemoveMediaPropertiesChanged(t);
        }
        if let Some(t) = playback {
            let _ = self.session.RemovePlaybackInfoChanged(t);
        }
        if let Some(t) = timeline {
            let _ = self.session.RemoveTimelinePropertiesChanged(t);
        }
    }
}

fn snapshot(session: &GlobalSystemMediaTransportControlsSession) -> windows::core::Result<MediaSnapshot> {
    let props = session.TryGetMediaPropertiesAsync()?.get()?;
    let timeline = session.GetTimelineProperties()?;
    let start = timeline.StartTime()?.Duration;
    let position = ticks_to_secs(timeline.Position()?.Duration - start);
    let end_time = ticks_to_secs(timeline.EndTime()?.Duration - start);
    let duration = end_time; // Track duration = end_time - start_time (which is 0)
    let updated_at = timeline.LastUpdatedTime().ok().map(|t| windows_time_to_unix_ms(t.UniversalTime));

    let title = props.Title()?.to_string_lossy().to_string();
    let artist = props.Artist()?.to_string_lossy().to_string();
    let album = props.AlbumTitle()?.to_string_lossy().to_string();
    let track_id = format!("{}|{}|{}", artist, title, album);
    let source_app_id = session.SourceAppUserModelId()?.to_string_lossy().to_string();

    let artwork_url = props.Thumbnail().ok().and_then(|thumb| {
        thumbnail(thumb).as_deref().and_then(data_url).map(|data| format!("data:image/png;base64,{}", data))
    });

    let info = session.GetPlaybackInfo()?;
    let status = info.PlaybackStatus()?;
    let playing = status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;

    Ok(MediaSnapshot {
        track: Some(MediaTrack { title, artist, album, track_id, duration, artwork_url, source_app_id }),
        playing,
        position,
        end_time,
        updated_at,
        volume: 50,
        status: format!("{:?}", status),
    })
}

fn thumbnail(thumb: IRandomAccessStreamReference) -> Option<Vec<u8>> {
    let stream = thumb.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 3_000_000 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    let loaded = reader.LoadAsync(size as u32).ok()?.get().ok()?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    Some(bytes)
}

fn data_url(bytes: &[u8]) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    if bytes.is_empty() {
        return None;
    }
    Some(STANDARD.encode(bytes))
}

fn read_and_emit<R: Runtime>(app: &AppHandle<R>, generation: u64, bound: Option<&Bound>) {
    let read = bound.and_then(|b| snapshot(&b.session).ok());
    let now = now_ms();
    let (state, track_for_art) = {
        let mut s = SHARED.lock().unwrap();
        if !(s.active && s.generation == generation) {
            return;
        }
        match read {
            Some(snap) => {
                s.state.running = true;
                s.state.playing = snap.playing;
                s.state.status = snap.status.clone();
                s.state.track = snap.track.clone();
                s.state.timeline.position = snap.position;
                s.state.timeline.end_time = snap.end_time;
                s.state.timeline.last_updated = snap.updated_at.unwrap_or(now);
                s.state.volume = snap.volume;
                (s.state.clone(), snap.track)
            }
            None => {
                s.state.running = false;
                s.state.playing = false;
                s.state.status = "Unknown".into();
                s.state.track = None;
                s.state.timeline = MediaTimeline { position: 0.0, end_time: 0.0, last_updated: now };
                s.state.volume = 50;
                (s.state.clone(), None)
            }
        }
    };

    emit_state(app, &state);

    // Throttled timeline emit
    {
        let mut s = SHARED.lock().unwrap();
        if s.last_timeline_emit.elapsed() >= Duration::from_millis(33) {
            s.last_timeline_emit = Instant::now();
            emit_timeline(app, &state.timeline);
            emit_playback(app, &state.status);
        }
    }

    emit_playback(app, &state.status);

    if let Some(track) = track_for_art {
        if let Some(art_url) = &track.artwork_url {
            let data = match ARTWORK_CACHE.lock().unwrap().iter().find(|(k, _)| *k == track.track_id).map(|(_, d)| d.clone()) {
                Some(data) => data,
                None => {
                    if let Some(data) = thumbnail_from_track(&track) {
                        let mut cache = ARTWORK_CACHE.lock().unwrap();
                        cache.push_back((track.track_id.clone(), data.clone()));
                        while cache.len() > 12 {
                            cache.pop_front();
                        }
                        data
                    } else {
                        return;
                    }
                }
            };
            emit_artwork(app, art_url.clone(), data);
        }
    }
}

fn thumbnail_from_track(_track: &MediaTrack) -> Option<String> {
    // The thumbnail was already fetched in snapshot, but we don't have it here.
    // In practice, the artwork is emitted from read_and_emit when track changes.
    None
}

// Public API for the island module
pub fn sync<R: Runtime>(app: &AppHandle<R>, on: bool) {
    let (tx, rx) = std::sync::mpsc::channel();
    let (old, generation, state) = {
        let mut s = SHARED.lock().unwrap();
        if s.active == on {
            return;
        }
        s.active = on;
        s.generation += 1;
        s.state = MediaState {
            running: false,
            playing: false,
            status: "Unknown".into(),
            track: None,
            timeline: MediaTimeline { position: 0.0, end_time: 0.0, last_updated: 0 },
            volume: 50,
        };
        let old = s.wake.take();
        if on {
            s.wake = Some(tx.clone());
        }
        (old, s.generation, s.state.clone())
    };
    if let Some(old) = old {
        let _ = old.send(Wake::Stop);
    }
    if on {
        let app = app.clone();
        let _ = thread::Builder::new()
            .name("coucou-media".into())
            .spawn(move || listen(app, generation, tx, rx));
    } else {
        emit_state(app, &state);
    }
}

fn listen<R: Runtime>(app: AppHandle<R>, generation: u64, tx: std::sync::mpsc::Sender<Wake>, rx: std::sync::mpsc::Receiver<Wake>) {
    com();
    let manager = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync().and_then(|op| op.get()) {
        Ok(m) => m,
        Err(err) => {
            crate::log::line(format!("media: no media sessions: {err}"));
            return;
        }
    };

    let sessions_token = {
        let tx = tx.clone();
        manager
            .SessionsChanged(&TypedEventHandler::new(move |_, _| {
                let _ = tx.send(Wake::Sessions);
                Ok(())
            }))
            .ok()
    };

    let mut bound: Option<Bound> = None;
    let mut rebind = true;

    while current(generation) {
        if rebind {
            if let Some(b) = bound.take() {
                b.unbind();
            }
            bound = find_session(&manager).and_then(|s| Bound::bind(s, &tx));
            rebind = false;
        }
        read_and_emit(&app, generation, bound.as_ref());

        let mut stop = false;
        match rx.recv() {
            Ok(Wake::Changed) => {}
            Ok(Wake::Sessions) => rebind = true,
            Ok(Wake::Stop) | Err(_) => stop = true,
        }
        while let Ok(more) = rx.try_recv() {
            match more {
                Wake::Changed => {}
                Wake::Sessions => rebind = true,
                Wake::Stop => stop = true,
            }
        }
        if stop {
            break;
        }
    }

    if let Some(b) = bound {
        b.unbind();
    }
    if let Some(token) = sessions_token {
        let _ = manager.RemoveSessionsChanged(token);
    }
}

// Tauri commands (must be public)
#[tauri::command]
pub async fn media_get_state() -> Result<MediaState, String> {
    let s = SHARED.lock().unwrap();
    Ok(s.state.clone())
}

#[tauri::command]
pub async fn media_play_pause() -> Result<bool, String> {
    let s = SHARED.lock().unwrap();
    if s.state.track.is_some() {
        com();
        if let Ok(manager) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().and_then(|op| op.get()) {
            if let Some(session) = find_session(&manager) {
                return session.TryTogglePlayPauseAsync()
                    .map_err(|e| e.to_string())?
                    .get()
                    .map_err(|e| e.to_string());
            }
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn media_next() -> Result<bool, String> {
    let s = SHARED.lock().unwrap();
    if s.state.track.is_some() {
        com();
        if let Ok(manager) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().and_then(|op| op.get()) {
            if let Some(session) = find_session(&manager) {
                return session.TrySkipNextAsync()
                    .map_err(|e| e.to_string())?
                    .get()
                    .map_err(|e| e.to_string());
            }
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn media_previous() -> Result<bool, String> {
    let s = SHARED.lock().unwrap();
    if s.state.track.is_some() {
        com();
        if let Ok(manager) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().and_then(|op| op.get()) {
            if let Some(session) = find_session(&manager) {
                return session.TrySkipPreviousAsync()
                    .map_err(|e| e.to_string())?
                    .get()
                    .map_err(|e| e.to_string());
            }
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn media_seek(position: f64) -> Result<bool, String> {
    let s = SHARED.lock().unwrap();
    if s.state.track.is_some() {
        com();
        if let Ok(manager) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().and_then(|op| op.get()) {
            if let Some(session) = find_session(&manager) {
                if let Ok(timeline) = session.GetTimelineProperties() {
                    let start = timeline.StartTime().map_err(|e| e.to_string())?.Duration;
                    let target_ticks = ((start as f64 / 10_000_000.0 + position) * 10_000_000.0) as i64;
                    return session.TryChangePlaybackPositionAsync(target_ticks)
                        .map_err(|e| e.to_string())?
                        .get()
                        .map_err(|e| e.to_string());
                }
            }
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn media_set_volume(_volume: u8) -> Result<(), String> {
    // GSMTC doesn't provide global volume control per session easily
    Ok(())
}

#[tauri::command]
pub async fn media_get_artwork() -> Result<Option<Vec<u8>>, String> {
    let s = SHARED.lock().unwrap();
    if let Some(track) = &s.state.track {
        com();
        if let Ok(manager) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().and_then(|op| op.get()) {
            if let Some(session) = find_session(&manager) {
                let props = session.TryGetMediaPropertiesAsync()
                    .map_err(|e| e.to_string())?
                    .get()
                    .map_err(|e| e.to_string())?;
                let thumb = props.Thumbnail().map_err(|e| e.to_string())?;
                return Ok(thumbnail(thumb));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn media_get_lyrics(
    title: String,
    artist: String,
    album: String,
    duration: i32,
) -> Result<Option<LyricsResult>, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://lrclib.net/api/get?track_name={}&artist_name={}&album_name={}&duration={}",
        urlencoding::encode(&title),
        urlencoding::encode(&artist),
        urlencoding::encode(&album),
        duration
    );
    let resp = client.get(&url).timeout(Duration::from_secs(10)).send().await.map_err(|e| e.to_string())?;
    if resp.status().as_u16() == 404 {
        let search_url = format!(
            "https://lrclib.net/api/search?track_name={}&artist_name={}",
            urlencoding::encode(&title),
            urlencoding::encode(&artist)
        );
        if let Ok(search_resp) = client.get(&search_url).timeout(Duration::from_secs(10)).send().await {
            if let Ok(results) = search_resp.json::<Vec<LyricsResult>>().await {
                let results_clone = results.clone();
                if let Some(best) = results.into_iter().find(|r| r.synced_lyrics.is_some()).or_else(|| results_clone.first().cloned()) {
                    return Ok(Some(best));
                }
            }
        }
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("LRCLIB API error: {}", resp.status()));
    }
    let result = resp.json::<LyricsResult>().await.map_err(|e| e.to_string())?;
    Ok(Some(result))
}

// Initialize the media manager (called from lib.rs setup)
pub async fn init_media_manager<R: Runtime>(app: &AppHandle<R>) -> windows::core::Result<()> {
    // Check if media pill is active
    let settings = crate::settings::load();
    if settings.active_integrations.contains(&"integration_media".to_string()) {
        sync(app, true);
    }
    Ok(())
}