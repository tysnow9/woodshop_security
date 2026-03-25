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
- **IPs:** `11.200.0.101`, `11.200.0.102`
- **RTSP credentials:** `admin` / `Admin1001`
- **RTSP port:** 554
- **URL format:** `rtsp://admin:Admin1001@<ip>:554/cam/realmonitor?channel=1&subtype=0`

### Confirmed Stream Details
| Stream | Resolution | FPS | Video | Audio |
|--------|-----------|-----|-------|-------|
| Main (`subtype=0`) | 2960×1668 | 20fps | H.264 | AAC mono, 64kHz |
| Sub (`subtype=1`) | 704×480 | 20fps | H.264 | AAC mono, 8kHz |

**Measured main stream bitrate:** ~3 Mbps

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

## Current Status (as of 2026-03-25)

### ✅ Working
- Live sub-stream (704×480) in camera grid thumbnails — muted autoplay
- Live main-stream (2960×1668) in full camera view — stream-copied, full quality
- FFmpeg process manager: 4 processes (2 cameras × thumb + main), auto-restart on crash, graceful shutdown
- HLS segments confirmed to contain both video and audio (ffprobe verified)
- Gear icon on each camera card → opens Amcrest web UI at `http://<ip>` in new tab
- Mute/unmute button in full camera view top bar
- Settings page UI shell (non-functional, display only)
- Graceful shutdown via Ctrl+C / SIGTERM

### ⚠️ Known Issue — Audio (Brave browser)
Audio is present in the HLS segments but Brave's strict autoplay policy blocks playback. Tried:
- Start muted → `video.play()` → set `video.muted = false` in `.then()` (async, fails)
- `forwardRef` / `useImperativeHandle` → call `video.muted = false` synchronously in click handler (still fails)

**Next thing to try:** Check Brave's site-level autoplay setting for `localhost` — may need to be set to "Allow" manually. Also worth testing in Chrome/Firefox to confirm audio pipeline works before debugging Brave-specific policy.

### 🔜 Next Phases
1. **Recording** — FFmpeg segment muxer writing 1-hour `.mp4` chunks to `recordings/`, rolling retention cleanup
2. **Segment indexer** — file watcher populates SQLite, maps `(cam, start_time, end_time)` → file path
3. **DVR timeline** — backend generates m3u8 playlists for any time range; frontend timeline scrubber
4. **Settings wired** — camera config, retention period, storage display connected to real backend data

## Architecture

### FFmpeg Process Design (per camera)
| Process | Input | Output | Notes |
|---------|-------|--------|-------|
| `{cam}-thumb` | sub stream (subtype=1) | HLS to `hls/{cam}/thumb/` | libx264 ultrafast transcode |
| `{cam}-main` | main stream (subtype=0) | HLS to `hls/{cam}/main/` | stream copy, zero CPU |

- HLS: 2-second segments, 6-segment rolling window
- `-use_wallclock_as_timestamps 1` on input to handle Amcrest's missing PTS
- `-af aresample=async=1` on thumb transcode to smooth DTS jitter

### FFmpeg Remaining Warnings (non-fatal)
```
[hls] Timestamps are unset in a packet for stream 0
[rtsp] DTS discontinuity in stream 1
```
These come from the camera's RTSP stream having imperfect timestamps. They don't affect playback. May revisit with `-fflags +genpts` if they cause segment issues.

### Backend (Go / Fiber)
- `backend/main.go` — entry point, wires FFmpeg manager + Fiber routes
- `backend/internal/ffmpeg/manager.go` — starts/monitors/restarts FFmpeg subprocesses
- API: `GET /api/cameras`, `GET /api/health`
- Serves HLS from disk: `GET /hls/{cam}/{stream}/*.{m3u8,ts}`
- Serves React SPA static files in production

### Frontend (React + Vite + Tailwind)
- `src/components/HlsPlayer.tsx` — hls.js player, `forwardRef` exposes `setMuted()`
- `src/components/CameraCard.tsx` — thumbnail grid card, sub stream
- `src/components/CameraGrid.tsx` — responsive grid (`minmax(320px, 1fr)`)
- `src/components/Layout.tsx` — top nav
- `src/pages/Dashboard.tsx` — camera grid, fetches `/api/cameras`
- `src/pages/CameraPage.tsx` — full view, main stream, mute toggle, timeline placeholder
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
