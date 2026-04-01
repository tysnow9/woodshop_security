# Woodshop Security — Architecture

## System Overview

Two Amcrest PoE cameras feed a self-hosted Ubuntu server. The server runs a Go backend that manages FFmpeg live-streaming processes, indexes camera recordings, and serves a React SPA to any browser on the LAN. Cameras independently write recordings to the server over NFS — recording is entirely decoupled from the live streaming pipeline.

---

## System Diagram

```mermaid
graph TB
    subgraph Cameras["Cameras (PoE LAN 11.200.0.0/24)"]
        CAM1["SE-Driveway\n11.200.0.101\nAmcrest IP5M-T1277EB-AI"]
        CAM2["NW-Front\n11.200.0.102\nAmcrest IP5M-T1277EB-AI"]
    end

    subgraph Server["Ubuntu Server (11.200.0.110)"]
        subgraph NFS["NFS Export (/nvr)"]
            NVRDIR["/nvr/cam1/serial/YYYY-MM-DD/\n/nvr/cam2/serial/YYYY-MM-DD/\n.mp4 segments, written by cameras"]
        end

        subgraph Backend["Go Backend (Fiber :8080)"]
            MGR["FFmpeg Manager\ninternal/ffmpeg/manager.go\n4 processes, auto-restart + backoff"]
            CLEANER["Retention Cleaner\ninternal/retention/cleaner.go\nhourly sweep, configurable 0–14 days"]
            STORE["Settings Store\ninternal/settings/settings.go\nconfig/settings.json"]
            INDEXER["Recording Indexer\ninternal/index/indexer.go\nscan /nvr every 60s\nfaststart + sprite workers"]
            DB["SQLite DB\nconfig/recordings.db\nWAL mode"]
            ROUTES["HTTP Routes\nmain.go\nFiber + CORS"]
        end

        subgraph FFmpegProcs["FFmpeg Subprocesses"]
            F1T["cam1-thumb\nRTSP sub → HLS\nlibx264 ultrafast\n1s segments, 8-seg window"]
            F1M["cam1-main\nRTSP main → HLS\nvideo stream-copy\naudio → 48kHz AAC\n2s segments, 7-seg window"]
            F2T["cam2-thumb\nRTSP sub → HLS\nlibx264 ultrafast\n1s segments, 8-seg window"]
            F2M["cam2-main\nRTSP main → HLS\nvideo stream-copy\naudio → 48kHz AAC\n2s segments, 7-seg window"]
        end

        subgraph HLSFiles["HLS Output (./hls/)"]
            H1T["hls/cam1/thumb/\nlive.m3u8 + seg*.ts\n704×480 @ 20fps"]
            H1M["hls/cam1/main/\nlive.m3u8 + seg*.ts\n2960×1668 @ 20fps"]
            H2T["hls/cam2/thumb/\nlive.m3u8 + seg*.ts\n704×480 @ 20fps"]
            H2M["hls/cam2/main/\nlive.m3u8 + seg*.ts\n2960×1668 @ 20fps"]
        end

        subgraph NTP["NTP (chrony)"]
            CHRONY["chrony :123\nstratum 3 upstream\nlocal stratum 10 fallback\nserves LAN 11.200.0.0/24"]
        end
    end

    subgraph Frontend["React SPA (Vite + Tailwind)"]
        DASH["Dashboard\nCamera grid\nCard order + visibility"]
        CAMPAGE["CameraPage\nFull single-camera view\nLive HLS + recorded playback\nTimeline scrubber"]
        DUALPAGE["DualCameraPage\nBoth cameras stacked\nWeb Audio API stereo routing\nBalance + L/R swap"]
        SETTINGS["Settings\nDrag-to-reorder cards\nRetention dropdown\nShow/hide toggles"]
        HLSPLAYER["HlsPlayer.tsx\nhls.js (MSE) or native HLS (Safari)\nautoplay muted, forwardRef setMuted()"]
        TIMELINE["Timeline.tsx\nRAF-based scrubber\nZoom/pan, segment blocks\nSprite thumbnail on scrub"]
    end

    subgraph Browser["Browser (any LAN device)"]
        CLIENT["HTTP client\nhls.js / native HLS\nWeb Audio API (stereo)\nlocalStorage persistence"]
    end

    %% Camera → NFS (recording)
    CAM1 -->|"NFS write\n.mp4 segments"| NVRDIR
    CAM2 -->|"NFS write\n.mp4 segments"| NVRDIR

    %% Camera → FFmpeg (live streaming)
    CAM1 -->|"RTSP UDP\nsubtype=1 (sub)"| F1T
    CAM1 -->|"RTSP UDP\nsubtype=0 (main)"| F1M
    CAM2 -->|"RTSP UDP\nsubtype=1 (sub)"| F2T
    CAM2 -->|"RTSP UDP\nsubtype=0 (main)"| F2M

    %% FFmpeg Manager → Subprocesses
    MGR -->|"spawn + monitor"| F1T
    MGR -->|"spawn + monitor"| F1M
    MGR -->|"spawn + monitor"| F2T
    MGR -->|"spawn + monitor"| F2M

    %% FFmpeg → HLS files
    F1T -->|"write segments"| H1T
    F1M -->|"write segments"| H1M
    F2T -->|"write segments"| H2T
    F2M -->|"write segments"| H2M

    %% Indexer → DB
    NVRDIR -->|"scan every 60s"| INDEXER
    INDEXER -->|"upsert recordings\nset faststart/sprite flags"| DB
    INDEXER -->|"ffmpeg faststart rewrite\nsprite sheet generation"| NVRDIR

    %% Settings store ↔ Cleaner
    STORE -->|"retentionDays callback"| CLEANER
    STORE -->|"retentionDays callback"| INDEXER
    CLEANER -->|"delete old date dirs"| NVRDIR

    %% Routes serve HLS
    H1T -->|"GET /hls/cam1/thumb/**"| ROUTES
    H1M -->|"GET /hls/cam1/main/**"| ROUTES
    H2T -->|"GET /hls/cam2/thumb/**"| ROUTES
    H2M -->|"GET /hls/cam2/main/**"| ROUTES

    %% Routes serve recordings
    DB -->|"GET /api/recordings*"| ROUTES
    NVRDIR -->|"GET /recordings/:id/video\nGET /recordings/:id/sprite"| ROUTES

    %% Settings API
    STORE <-->|"GET/PUT /api/settings"| ROUTES

    %% NTP
    CAM1 -->|"NTP query"| CHRONY
    CAM2 -->|"NTP query"| CHRONY

    %% Backend → Frontend (SPA served)
    ROUTES -->|"GET / (React SPA)"| Frontend

    %% Browser ↔ Backend
    CLIENT -->|"GET /api/cameras\nGET /api/recordings*\nGET /api/settings\nPUT /api/settings\nGET /hls/**\nGET /recordings/**"| ROUTES
    ROUTES -->|"HLS playlists + segments\nMP4 files (range requests)\nJSON API responses"| CLIENT

    %% Frontend composition
    DASH --> HLSPLAYER
    CAMPAGE --> HLSPLAYER
    CAMPAGE --> TIMELINE
    DUALPAGE --> HLSPLAYER
```

---

## Pipeline: Live Streaming

```
Camera RTSP ──UDP──► FFmpeg subprocess ──► .ts segments on disk ──► Go static handler ──► hls.js in browser
```

| Process | Input | Video | Audio | Segments |
|---------|-------|-------|-------|----------|
| `{cam}-thumb` | subtype=1 (704×480) | libx264 ultrafast | AAC 22050Hz | 1s, 8-seg window |
| `{cam}-main` | subtype=0 (2960×1668) | stream copy (zero CPU) | AAC 48kHz 128kbps | 2s, 7-seg window |

**Why stream-copy for main:** No CPU or quality cost. The camera's H.264 CBR stream is delivered directly into MPEG-TS segments. Audio must be transcoded because the camera's RTSP stream carries AAC without valid ADTS framing headers.

**Why 2s segments for main:** Camera GOP (Frame Interval 40 = 2s at 20fps) — FFmpeg can only split at keyframe boundaries when stream-copying. `hls_time 2` matches the GOP exactly.

**HLS latency:** 2s segment + `liveSyncDurationCount: 2` in hls.js → ~6s behind live edge. `liveSyncDurationCount: 2` keeps two segments buffered, preventing the stall that occurred at the first segment boundary with count=1.

**Playlist caching:** `live.m3u8` served with `Cache-Control: no-cache, no-store` (bypasses Fiber's 10s static cache). `.ts` segments use `max-age=3600` (immutable once written).

---

## Pipeline: Recording (camera-side NAS)

```
Camera NFS client ──NFS──► /nvr/cam{N}/{serial}/YYYY-MM-DD/001/dav/{hour}/*.mp4
```

Cameras use their built-in NAS recording feature. Our backend plays no role in writing recordings — it only manages retention cleanup and indexing. Recording continues even if the backend is down.

**File format:** `.mp4` (H.264, directly browser-playable). In-progress files have a trailing `_` and are skipped by the indexer.

**Filename format:** `HH.MM.SS-HH.MM.SS[R/M][0@0][0].mp4` — encodes start time, end time, and motion flag (`R`=regular, `M`=motion). All times are local time, not UTC.

**Retention:** Goroutine sweeps `/nvr` hourly, deleting date-directories older than `retentionDays`. `retentionDays=0` disables cleanup.

---

## Pipeline: Recording Indexer

```
/nvr scan (60s) ──► SQLite upsert ──► faststart rewrite ──► sprite generation
```

| Step | File | Details |
|------|------|---------|
| Scan | `indexer.go` | Walk `/nvr` every 60s; 2 background workers; non-blocking enqueue |
| Faststart | `faststart.go` | Rewrite moov to file front; required — cameras write moov at end |
| Sprite | `sprite.go` | 240×135px frames at 1/10s, tiled 270×1; displayed at 320×180 in UI |
| DB | `db.go` | SQLite WAL; `faststart_failed` flag for corrupt files (no retry) |

---

## Pipeline: Playback

```
Browser seek ──► GET /api/recordings?cam=&date= ──► <video src="/recordings/:id/video"> ──► HTTP range requests
```

Playback uses native `<video>` with MP4 files served via HTTP range requests (206 Partial Content). No HLS involved. The Timeline scrubber shows all segments across all available dates; seeking loads the correct segment directly.

---

## Backend: Go / Fiber

| File | Responsibility |
|------|---------------|
| `main.go` | Entry point, Fiber app, routes, process wiring |
| `internal/ffmpeg/manager.go` | FFmpeg subprocess lifecycle — start, monitor, exponential-backoff restart |
| `internal/settings/settings.go` | Thread-safe JSON settings store; atomic write via temp-rename |
| `internal/retention/cleaner.go` | Hourly goroutine; walks `/nvr`, prunes dated dirs beyond retention window |
| `internal/index/indexer.go` | Scans NVR every 60s; queues faststart + sprite work |
| `internal/index/faststart.go` | ffmpeg moov-to-front rewrite; atomic rename via `.faststart.tmp` |
| `internal/index/sprite.go` | ffmpeg contact sheet: 240×135px, 1/10s, up to 270 frames |
| `internal/index/db.go` | SQLite CRUD for recordings |
| `internal/index/parse.go` | Parses Amcrest filename format to extract start/end time and motion flag |

**API surface:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/cameras` | Camera list |
| GET | `/api/settings` | Current settings (`retentionDays`) |
| PUT | `/api/settings` | Update settings |
| GET | `/api/recordings/dates?cam=` | Distinct dates with recordings, newest first |
| GET | `/api/recordings?cam=&date=` | All segments for camera+date, sorted by start_time |
| GET | `/recordings/:id/video` | MP4 file with HTTP range support (206) |
| GET | `/recordings/:id/sprite` | Sprite contact sheet JPEG |
| GET | `/hls/:cam/:stream/live.m3u8` | No-cache HLS playlist |
| GET | `/hls/**` | Cached `.ts` segments |
| GET | `/*` | React SPA (catch-all) |

---

## Frontend: React + Vite + Tailwind

| File | Responsibility |
|------|---------------|
| `App.tsx` | Router: `/`, `/camera/:id`, `/dual`, `/settings` |
| `pages/Dashboard.tsx` | Camera grid; reads `nvr_card_order` + `nvr_enabled` from localStorage |
| `pages/CameraPage.tsx` | Full single-camera view; live HLS + recorded playback; Timeline scrubber; sprite thumbnails |
| `pages/DualCameraPage.tsx` | Both cameras stacked; Web Audio API stereo via `StereoPannerNode` + `GainNode`; Safari native HLS fallback |
| `pages/Settings.tsx` | Drag-to-reorder (HTML5 DnD), show/hide toggles, retention dropdown |
| `components/CameraCard.tsx` | Thumbnail grid card (sub stream, 704/480 aspect ratio) |
| `components/DualCard.tsx` | Combined grid card; two stacked sub streams |
| `components/HlsPlayer.tsx` | hls.js player with `forwardRef` `setMuted()`; Safari auto-detects native HLS |
| `components/Timeline.tsx` | RAF-based scrubber; zoom/pan; sprite thumbnails; `headerContent` slot for controls |
| `components/Layout.tsx` | Top nav |
| `lib/api.ts` | Fetch wrappers + `hlsUrl()` |
| `lib/types.ts` | `Camera`, `RecordingSegment` types |
| `lib/dualSettings.ts` | `DualSettings` type, `CAM_NAMES`, `OTHER_CAM` |

**localStorage keys:**

| Key | Description |
|-----|-------------|
| `nvr_muted` | Mute state |
| `nvr_card_order` | Dashboard card order |
| `nvr_enabled` | Card show/hide state |
| `nvr_dual_settings` | Combined view L/R assignment + balance |

---

## Deployment

**Dev:**
```bash
cd backend && go run .          # starts FFmpeg + serves SPA on :8080
cd frontend && npm run dev      # Vite dev server on :5173, proxies /api and /hls to :8080
```

**Production (Docker Compose):**
```bash
docker-compose up --build
```
Single container: Go binary + pre-built React SPA. Bind mounts:
- `/nvr:/recordings` — NFS recording volume
- `./hls` — HLS segment output
- `./config` — settings + SQLite DB persistence
- `./frontend/dist:/app/static:ro` — React build

**NTP:** `chrony` on the server serves NTP to the LAN at `11.200.0.110:123`. `local stratum 10` ensures cameras stay synced when the internet is unavailable.
