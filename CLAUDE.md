# Woodshop Security — Project Context

## Overview
A self-hosted home security camera system for Amcrest PoE cameras. Captures RTSP streams 24/7, records to local disk with configurable retention, and serves a modern dark-theme web UI accessible on the local network.

## Hardware

### Server PC
- **CPU:** Intel Core i7-8700T @ 2.40GHz (6 cores / 12 threads)
- **RAM:** 7.1 GB total, ~3.8 GB available
- **Disk:** 937 GB NVMe (`/dev/nvme0n1p2`), ~875 GB available, mounted at `/`
- **GPU:** Intel UHD Graphics 630 — VAAPI capable (`/dev/dri/renderD128`)
- **OS:** Ubuntu 25.10 (questing)

### Cameras
- **Model:** Amcrest PoE (~3K)
- **Count:** 2 (expandable)
- **Names:** `SE-Driveway` (cam1), `NW-Front` (cam2)
- **IPs:** `11.200.0.101` (cam1), `11.200.0.102` (cam2)
- **RTSP credentials:** `admin` / `Admin1001`
- **RTSP port:** 554
- **URL format:** `rtsp://admin:Admin1001@<ip>:554/cam/realmonitor?channel=1&subtype=0`

### Confirmed Stream Details
| Stream | Resolution | FPS | Video | Audio |
|--------|-----------|-----|-------|-------|
| Main (`subtype=0`) | 2960×1668 | 20fps | H.264 | AAC-LC mono, 48kHz |
| Sub (`subtype=1`) | 704×480 | 20fps | H.264 | AAC-LC mono, 8kHz |

**Measured main stream bitrate:** ~3 Mbps

### Important Camera Settings (Amcrest UI)
- **Audio sample rate:** 48000 Hz — changed from camera default 64kHz; non-standard rates cause browsers to silently reject AAC and FFmpeg to drop audio when stream-copying to MPEG-TS
- **Frame Interval:** 20 frames (= 1 second at 20fps) — controls keyframe/GOP interval; determines HLS segment duration when stream-copying video (FFmpeg can only cut at keyframes)

## Storage Plan
- **Retention:** 7 days (configurable in UI — not yet wired to backend)
- **Main stream at ~3 Mbps, stream-copy:** ~1.35 GB/hour per camera
- **7 days × 2 cameras = ~454 GB** ✓ well within 875 GB available

## Dev Workflow
```bash
# Terminal 1 — backend (starts FFmpeg processes automatically)
cd backend && go run .

# Terminal 2 — frontend (Vite dev server, proxies /api and /hls to :8080)
cd frontend && npm run dev

# Open: http://localhost:5173
```

## Current Status (as of 2026-03-26)

### ✅ Working
- Live sub-stream (704×480) in camera grid thumbnails — muted autoplay, correct aspect ratio (704/480, no cropping of camera timestamp overlays)
- Live main-stream (2960×1668) in full camera view — video stream-copied (zero CPU), audio transcoded to 48kHz AAC
- Audio working in Firefox and Brave — mute/unmute state persisted in localStorage across navigation
- Fullscreen button in top bar (Camera Settings → Mute → Fullscreen); double-click video also toggles; Escape exits
- ~3s latency vs raw RTSP (tested against iPhone via Scrypted/Home app)
- FFmpeg process manager: 4 processes (2 cameras × thumb + main), auto-restart on crash, graceful shutdown
- Settings page UI shell (non-functional, display only)

### ⚠️ Known FFmpeg Warnings (non-fatal)
```
[hls] Timestamps are unset in a packet for stream 0
[rtsp] DTS discontinuity in stream 1
```
Both come from the Amcrest camera's RTSP stream having imperfect timestamps. `-use_wallclock_as_timestamps 1` replaces them with wall-clock time. No effect on playback.

### 🔜 Next Phases
1. **Recording** — FFmpeg segment muxer writing 1-hour `.mp4` chunks to `recordings/`, rolling retention cleanup
2. **Segment indexer** — file watcher populates SQLite, maps `(cam, start_time, end_time)` → file path
3. **DVR timeline** — backend generates m3u8 playlists for any time range; frontend timeline scrubber
4. **Settings wired** — camera config, retention period, storage display connected to real backend data

## Architecture

### FFmpeg Process Design (per camera)
| Process | Input | Output | Notes |
|---------|-------|--------|-------|
| `{cam}-thumb` | sub stream (subtype=1) | HLS to `hls/{cam}/thumb/` | libx264 ultrafast + AAC 22050Hz transcode |
| `{cam}-main` | main stream (subtype=0) | HLS to `hls/{cam}/main/` | video stream-copy, audio transcoded to 48kHz AAC |

**HLS settings:** 1-second segments (`hls_time 1`), 8-segment rolling window (`hls_list_size 8`), `program_date_time` tags embedded in playlist
**Input flags:** `-rtsp_transport udp -use_wallclock_as_timestamps 1`
**Main stream audio:** `-c:a aac -ar 48000 -b:a 128k -af aresample=async=1`

Why transcode audio instead of stream-copying: the Amcrest RTSP stream carries AAC without proper ADTS framing headers. Stream-copying into MPEG-TS produces segments where ffprobe (and browsers) cannot determine sample rate or channel count. Re-encoding regenerates correct ADTS framing.

### HLS Latency
- Camera Frame Interval 20 frames → 1s keyframe interval → 1s segments for stream-copy
- `hls_time 1` + `hls_list_size 8` → 8 seconds of playlist window
- hls.js `liveSyncDurationCount: 1` → ~2s behind live edge → ~3s total vs raw RTSP

### HLS Serving (critical detail)
`live.m3u8` playlists are served with a **custom no-cache handler** — `Cache-Control: no-cache, no-store`, read directly from disk via `os.ReadFile`. Fiber's default static handler caches file metadata for 10 seconds, which caused hls.js to receive stale 304 responses for up to 10 seconds while FFmpeg wrote new segments every second (manifested as stream freezing every ~10s). `.ts` segments use the standard static handler with `MaxAge: 3600` since they are immutable once written.

### Backend (Go / Fiber)
- `backend/main.go` — entry point, Fiber routes, FFmpeg manager startup
- `backend/internal/ffmpeg/manager.go` — FFmpeg subprocess lifecycle (start, monitor, restart with exponential backoff)
- `GET /api/cameras` — camera list
- `GET /api/health` — health check
- `GET /hls/:cam/:stream/live.m3u8` — no-cache playlist handler
- `GET /hls/**` — static segment handler (cached)
- React SPA static files in production

### Frontend (React + Vite + Tailwind)
- `src/components/HlsPlayer.tsx` — hls.js player; `forwardRef` exposes `setMuted()` for synchronous unmute inside click handlers (required by browser autoplay policy); `startMuted` captured at mount via ref so mute toggles don't rebuild the player
- `src/components/CameraCard.tsx` — thumbnail grid card, sub stream, aspect ratio `704/480`
- `src/components/CameraGrid.tsx` — responsive grid (`minmax(320px, 1fr)`)
- `src/components/Layout.tsx` — top nav
- `src/pages/Dashboard.tsx` — camera grid, fetches `/api/cameras`
- `src/pages/CameraPage.tsx` — full view, main stream, mute/fullscreen controls, DVR timeline placeholder
- `src/pages/Settings.tsx` — UI shell only (non-functional)
- `src/lib/api.ts` — fetch wrappers, `hlsUrl()` helper
- `src/lib/types.ts` — `Camera` type

### Deployment
- Docker Compose: single `app` service, Go binary + static React build
- Bind mounts: `./recordings`, `./hls`, `./config`, `./frontend/dist`
- VAAPI device passthrough for future H.265 transcode

## Future Features (Deferred)
- Motion/object detection with timeline markers
- Discord notifications
- Snapshot capture
- External drive support
- VAAPI H.265 recording toggle (halves storage, ~454 GB for 14 days)
