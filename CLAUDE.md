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
- **Model:** Amcrest IP5M-T1277EB-AI (5MP PoE AI Turret)
- **Count:** 2 (expandable)
- **Names:** `SE-Driveway` (cam1), `NW-Front` (cam2)
- **IPs:** `11.200.0.101` (cam1), `11.200.0.102` (cam2)
- **RTSP credentials:** `admin` / `Admin1001`
- **RTSP port:** 554
- **URL format:** `rtsp://admin:Admin1001@<ip>:554/cam/realmonitor?channel=1&subtype=0`

### Confirmed Stream Details
| Stream | Resolution | FPS | Video | Audio |
|--------|-----------|-----|-------|-------|
| Main (`subtype=0`) | 2960×1668 | 20fps | H.264 CBR | AAC-LC mono, 64kHz (camera native) |
| Sub (`subtype=1`) | 704×480 | 20fps | H.264 | AAC-LC mono, 8kHz |

**Camera main stream bitrate:** 5120 Kb/s CBR

### Camera Settings (Amcrest Web UI)
- **Video encode mode:** H.264 — do not switch to H.265; see Decisions below
- **Bit rate:** 5120 Kb/s, CBR — switched from VBR to eliminate the I-frame quality pulse visible in daytime scenes (VBR allocates extra bits to keyframes, causing a brightness/detail flash every GOP)
- **Frame Interval:** 60 frames (= 3 seconds at 20fps) — controls keyframe/GOP interval; determines HLS segment duration when stream-copying video (FFmpeg can only cut at keyframes); must stay at 60 to match `hls_time 3` in backend
- **Audio sample rate:** 64kHz (camera default, kept as-is) — FFmpeg resamples to 48kHz during audio transcode; non-standard but handled cleanly by `aresample=async=1000`
- **Audio noise filter:** Disabled (kept as-is)
- **Microphone volume:** 50 (kept as-is)
- **Max connections:** 10 — covers our 2 FFmpeg processes per camera + Scrypted with headroom

### Network / Connection Settings (per camera)
- TCP Port: 37777, UDP Port: 37778, HTTP: 80, RTSP: 554, HTTPS: 443
- RTSP transport: UDP — optimal for wired PoE LAN (lowest latency, negligible packet loss)
- RTMP not used — push protocol for external platforms, not relevant to our pipeline
- ONVIF not used — management layer that still uses RTSP underneath; no benefit over direct RTSP

## Storage Plan
- **Retention:** 7 days (currently limited to ~24h during development/testing)
- **Main stream at 5120 Kbps CBR, stream-copy:** ~2.3 GB/hour per camera
- **7 days × 2 cameras ≈ 768 GB** ✓ within 875 GB available
- **Recording method:** Camera-side NAS recording via NFS (see Architecture below)
- **NFS export:** `/nvr` on the Ubuntu server — cam1 writes to `/nvr/cam1/`, cam2 to `/nvr/cam2/`
  - `/etc/exports`: `/nvr *(rw,sync,no_subtree_check,no_root_squash,insecure)`
  - `/nvr` is outside the project directory to avoid VSCode file watcher noise

## Dev Workflow
```bash
# Terminal 1 — backend (starts FFmpeg processes automatically)
cd backend && go run .

# Terminal 2 — frontend (Vite dev server, proxies /api and /hls to :8080)
cd frontend && npm run dev

# Open: http://localhost:5173
```

## Current Status (as of 2026-03-29)

### ✅ Working
- Live sub-stream (704×480) in camera grid thumbnails — muted autoplay, correct aspect ratio (704/480)
- Live main-stream (2960×1668) in full camera view — video stream-copied (zero CPU), audio transcoded to 48kHz AAC
- Audio working in all browsers including Safari — mute/unmute persisted in localStorage
- Fullscreen — button in top bar; Escape exits; button hidden on iOS (Safari doesn't support `requestFullscreen` on divs)
- Zoom & pan — pinch/scroll to zoom (1×–8×), drag to pan, in both full camera view and combined view; works with trackpad, mouse, and touch via `react-zoom-pan-pinch`
- ~6s latency vs raw RTSP (3s segments + hls.js liveSyncDurationCount:1; increased from ~3s when Frame Interval changed from 20→60 to fix I-frame flash)
- FFmpeg process manager: 4 processes (2 cameras × thumb + main), auto-restart on crash, graceful shutdown
- **LAN access** — Go backend binds `0.0.0.0:8080`; accessible from any device on the home network after `npm run build`; tested on macOS Safari, iOS Safari, and Windows browsers
- **Combined view** — third card in the grid shows both cameras stacked; full view plays both main streams simultaneously with true stereo audio via Web Audio API
  - Inline audio settings panel (SlidersHorizontal icon): live balance slider + L/R channel swap
  - Balance slider always reflects physical L/R speaker orientation regardless of swap state
  - L/R assignment and balance persisted to `nvr_dual_settings` in localStorage
  - Always starts muted (one click to hear)
- **Settings page** — fully functional:
  - Camera rows (SE-Driveway, NW-Front, Combined) with working show/hide toggles
  - Drag-to-reorder via GripVertical handles — order persisted to `nvr_card_order`
  - Combined row shows current L/R assignment, Layers icon, Active/Hidden status
  - All enabled states persisted to `nvr_enabled` in localStorage
  - Dashboard reads both keys on mount to render cards in correct order with correct visibility
- **Retention cleanup** — backend goroutine sweeps `/nvr` hourly, deletes date dirs older than configured window; `0` = disabled (keep forever); persisted to `./config/settings.json`; wired to Settings page dropdown (0–14 days); warns in UI when reducing retention
- **NTP** — `chrony` installed and syncing (stratum 3); configured to serve LAN at `11.200.0.110:123`; `local stratum 10` fallback keeps cameras synced when internet is unavailable; both cameras confirmed querying the local server

### ⚠️ Known Issues
- **Combined audio crackle** — intermittent pops/crackle audible when routing both main streams through the Web Audio API (`createMediaElementSource`). The native browser player masks HLS segment-boundary discontinuities; Web Audio API exposes them. The camera's jittery RTSP timestamps are the root cause. `aresample=async=1000` on the FFmpeg side and `latencyHint: 'playback'` on the AudioContext mitigate it but don't eliminate it. Fundamental limitation of Web Audio + HLS; moving to 3-second segments may reduce frequency of crackle vs. 1-second segments.
- **Safari: stereo balance/pan not functional** — `createMediaElementSource()` does not capture audio from `<video>` elements on WebKit (tested macOS Safari), even when using native HLS (forced on Safari to avoid the MSE/hls.js + Web Audio bug). The gain nodes and StereoPannerNode exist in the graph but receive no signal. Audio plays, mute/unmute works, but the balance slider has no effect. Chrome/Brave/Firefox work correctly. Root cause is a WebKit limitation; no clean workaround found yet.
- **FFmpeg warnings (non-fatal):**
  ```
  [hls] Timestamps are unset in a packet for stream 0
  [rtsp] DTS discontinuity in stream 1
  ```
  Both from the Amcrest camera's imperfect RTSP timestamps. `-use_wallclock_as_timestamps 1` replaces them with wall-clock time. No effect on playback.

### 🔜 Next Phases
1. ~~**Ubuntu as NAS**~~ ✅ **Done** — NFS server running, both cameras recording to `/nvr/cam1` and `/nvr/cam2`
2. ~~**Retention cleanup**~~ ✅ **Done** — hourly backend sweep, UI dropdown, persisted to `config/settings.json`
3. ~~**NTP**~~ ✅ **Done** — chrony serving LAN at `11.200.0.110`, offline fallback via `local stratum 10`
4. **Recording indexer** — backend file watcher populates SQLite, maps `(cam, start_time, end_time)` → file path; expose `GET /api/recordings?cam=cam1&date=2026-03-28`
5. **Playback UI** — calendar/timeline picker in frontend; native `<video>` element for `.mp4` playback (no HLS needed — browsers seek `.mp4` natively via HTTP range requests)
6. **Settings wired** — storage usage on Settings page connected to real backend data (`du` on `/nvr`)
7. **One-click launch** — systemd unit that starts Docker Compose with `After=nfs-server.service` ordering

## Architecture

### Live Streaming vs Recording (separation of concerns)
These are deliberately separate pipelines:

```
Camera ──RTSP──► FFmpeg ──► HLS segments ──► browser  (live, ~3s latency)
Camera ──NFS───► Ubuntu /nvr/ (recordings/)            (recording, camera-managed)
                     └──► backend indexes files ──► browser  (playback)
```

**Live streaming:** FFmpeg pulls RTSP, muxes to HLS. Browser plays via hls.js. ~3s latency, no recording logic in this path.

**Recording:** Cameras write directly to Ubuntu NFS export (`/nvr`) using their built-in NAS client. Recording continues even if our backend is down. Our backend is read-only for recordings.

**Playback:** Backend scans recording files, serves index API + file bytes (HTTP range requests). Frontend uses native `<video>` for `.mp4` — full seek support, no HLS required.

### FFmpeg Process Design (per camera)
| Process | Input | Output | Notes |
|---------|-------|--------|-------|
| `{cam}-thumb` | sub stream (subtype=1) | HLS to `hls/{cam}/thumb/` | libx264 ultrafast + AAC 22050Hz transcode |
| `{cam}-main` | main stream (subtype=0) | HLS to `hls/{cam}/main/` | video stream-copy, audio transcoded to 48kHz AAC |

**HLS settings (thumb):** 1-second segments (`hls_time 1`), 8-segment rolling window (`hls_list_size 8`), `program_date_time` tags — thumb transcodes so FFmpeg inserts keyframes freely
**HLS settings (main):** 3-second segments (`hls_time 3`), 5-segment rolling window (`hls_list_size 5`), `program_date_time` tags — stream-copy requires segment boundaries to align with camera keyframes (Frame Interval 60 = 3s GOP)
**Input flags:** `-rtsp_transport udp -use_wallclock_as_timestamps 1`
**Main stream audio:** `-c:a aac -ar 48000 -b:a 128k -af aresample=async=1000`

Why transcode audio instead of stream-copying: the Amcrest RTSP stream carries AAC without proper ADTS framing headers. Stream-copying into MPEG-TS produces segments where ffprobe (and browsers) cannot determine sample rate or channel count. Re-encoding regenerates correct ADTS framing.

Why `aresample=async=1000`: the camera produces jittery RTSP timestamps. `async=1` only allowed 1 sample/second of drift correction, so larger timestamp jumps passed through as audio gaps. `async=1000` gives a ~20ms/second correction budget, keeping audio continuous via stretching/squeezing rather than silence insertion.

### HLS Latency
- Camera Frame Interval 60 frames → 3s keyframe interval → 3s segments for stream-copy
- `hls_time 3` + `hls_list_size 5` → 15 seconds of playlist window
- hls.js `liveSyncDurationCount: 1` → ~6s behind live edge → ~6s total vs raw RTSP

### HLS Serving (critical detail)
`live.m3u8` playlists are served with a **custom no-cache handler** — `Cache-Control: no-cache, no-store`, read directly from disk via `os.ReadFile`. Fiber's default static handler caches file metadata for 10 seconds, which caused hls.js to receive stale 304 responses for up to 10 seconds while FFmpeg wrote new segments every second (manifested as stream freezing every ~10s). `.ts` segments use the standard static handler with `MaxAge: 3600` since they are immutable once written.

### Why HLS and not WebRTC/RTMP/DASH
- Browsers cannot speak RTSP natively
- **HLS** — HTTP-based, universal browser support via hls.js, ~3s latency, proven for NVR use; correct choice
- **WebRTC** — sub-second latency but requires signaling server, STUN/TURN, significant complexity; not justified for local LAN security camera viewing
- **RTMP** — camera push protocol for streaming to YouTube etc.; not applicable to our pull-based pipeline
- **DASH** — similar to HLS with more complexity; no advantage here
- **LL-HLS** — Apple's low-latency HLS extension (~1–2s); viable future upgrade if latency becomes a concern

### Backend (Go / Fiber)
- `backend/main.go` — entry point, Fiber routes, FFmpeg manager startup; `STATIC_DIR` defaults to `../frontend/dist` so `go run .` serves the built SPA directly
- `backend/internal/ffmpeg/manager.go` — FFmpeg subprocess lifecycle (start, monitor, restart with exponential backoff)
- `backend/internal/settings/settings.go` — thread-safe JSON settings store; atomic write via temp file + rename; defaults to 7-day retention if no file exists
- `backend/internal/retention/cleaner.go` — hourly goroutine; walks `/nvr/cam*/serial/YYYY-MM-DD/` dirs, deletes any dated dir older than `retentionDays`; skips non-date dirs (e.g. `DVRWorkDirectory`); `retentionDays=0` disables cleanup entirely
- `GET /api/cameras` — camera list
- `GET /api/health` — health check
- `GET /api/settings` — returns `{retentionDays}`
- `PUT /api/settings` — updates settings, persists to `config/settings.json` (gitignored, stays local)
- `GET /hls/:cam/:stream/live.m3u8` — no-cache playlist handler
- `GET /hls/**` — static segment handler (cached)
- React SPA static files in production
- Env vars: `PORT` (8080), `STATIC_DIR`, `HLS_DIR` (./hls), `NVR_DIR` (/nvr), `CONFIG_DIR` (./config)

### Frontend (React + Vite + Tailwind)
- `src/lib/api.ts` — fetch wrappers, `hlsUrl()` helper
- `src/lib/types.ts` — `Camera` type
- `src/lib/dualSettings.ts` — shared `DualSettings` type, `getDualSettings()` / `saveDualSettings()`; also exports `CAM_NAMES` and `OTHER_CAM` mappings used across Combined-related components
- `src/components/HlsPlayer.tsx` — hls.js player; `forwardRef` exposes `setMuted()` for synchronous unmute inside click handlers (required by browser autoplay policy); `startMuted` captured at mount via ref so mute toggles don't rebuild the player
- `src/components/CameraCard.tsx` — thumbnail grid card, sub stream, aspect ratio `704/480`
- `src/components/CameraGrid.tsx` — responsive grid; reads `nvr_card_order` and `nvr_enabled` from localStorage on mount to render cards in saved order with correct visibility
- `src/components/DualCard.tsx` — "Combined" grid card; stacked thumbnails (two `704/240` strips = same height as a single `704/480` card); reads `dualSettings` to show correct L/R assignment in footer
- `src/components/Layout.tsx` — top nav
- `src/pages/Dashboard.tsx` — camera grid, fetches `/api/cameras`
- `src/pages/CameraPage.tsx` — full camera view, main stream, mute/fullscreen, zoom/pan, DVR timeline placeholder
- `src/pages/DualCameraPage.tsx` — Combined full view; two main streams stacked; Web Audio API stereo routing via `StereoPannerNode` + per-channel `GainNode`s; graph built lazily on first Unmute (avoids StrictMode `createMediaElementSource` pitfall); inline settings panel for live balance + L/R swap; balance correctly negated when channels are swapped; mute also sets `video.muted` directly because Safari's `createMediaElementSource()` doesn't fully disconnect native audio output; Safari detected via UA and forced onto native HLS path (skips hls.js) because MSE/hls.js + `createMediaElementSource` doesn't capture audio on WebKit; stall recovery (`video.load()`) on native HLS path
- `src/pages/Settings.tsx` — camera/combined rows with drag-to-reorder (GripVertical, HTML5 DnD) and functional show/hide toggles; saves to `nvr_card_order` and `nvr_enabled`; retention dropdown (0 = Off, 1–14 days) fetched from and saved to `GET/PUT /api/settings`; warns when reducing retention

### localStorage Keys
| Key | Type | Description |
|-----|------|-------------|
| `nvr_muted` | `'true'/'false'` | Mute state, persisted across navigation |
| `nvr_card_order` | `string[]` JSON | Dashboard card order: e.g. `["cam2","cam1","combined"]` |
| `nvr_enabled` | `Record<string,bool>` JSON | Show/hide state for each card; `{cam1, cam2, combined}` |
| `nvr_dual_settings` | `DualSettings` JSON | Combined view: `{leftCam, balance}` |

### Deployment
- Docker Compose: single `app` service, Go binary + static React build
- Bind mounts: `/nvr:/recordings`, `./hls`, `./config`, `./frontend/dist`
- **systemd unit (when setting up one-click launch):** must include `After=nfs-server.service Requires=nfs-server.service` so Docker Compose doesn't start before the NFS export is ready
- `nfs-kernel-server` is enabled on boot (confirmed via systemctl); no extra setup needed for reboots

## Decisions & Lessons Learned

### H.265 — tried and reverted
Switched NW-Front to H.265 at the camera to explore storage/quality gains. **Broke the app immediately:** hls.js uses the browser's MSE (Media Source Extensions) API which cannot decode H.265/HEVC. The stream-copy puts raw H.265 into MPEG-TS segments that FFmpeg accepts but browsers reject. HomeKit continued working because Scrypted transcodes independently.

Attempted fix: VAAPI hardware transcode (H.265 → H.264 via Intel UHD 630). Failed due to render group permissions (`No VA display found for device /dev/dri/renderD128` — fixable with `sudo usermod -aG render chip` + re-login). But even if VAAPI worked, the quality benefit is marginal: we'd be serving transcoded H.264, not H.265, so the quality ceiling is set by the transcode, not the camera codec. The stream-copy H.264 architecture (zero CPU, no failure modes) is superior for this pipeline.

**Decision: keep both cameras on H.264.** The bitrate increase (4096 → 5120 Kb/s) is the correct lever for quality — more bits per frame in H.264 stream-copy, delivered directly to the browser with zero processing.

### I-frame quality pulse — VBR→CBR + longer GOP
Noticed in daytime: pixels would flash bright/dark at exactly 1-second intervals; not visible in IR/night or in the Home app (Scrypted re-encodes at 1080p, smoothing the artifact). Root cause: VBR encoder allocates a large bit budget to each I-frame (all macroblocks refreshed) and far fewer bits to the 19 trailing P-frames, creating a visible quality pulse in high-detail outdoor scenes. Home app looks better because Scrypted's transcode redistributes bits evenly.

**Fix:** switched camera from VBR → CBR (5120 Kbps) to prevent the encoder from "saving up" bits for keyframes, and increased Frame Interval from 20 → 60 frames (1s → 3s GOP) so the refresh happens every 3 seconds rather than every 1. Backend `hls_time` updated from 1 → 3 to match. Trade-off: latency increases from ~3s to ~6s.

### Recording architecture — camera NAS (NFS) over FFmpeg segment muxer
Original plan was to add a recording FFmpeg process per camera writing `.mp4` segments. Revised to camera-side NAS recording because:
- Recording continues if our backend crashes
- No additional FFmpeg processes (saves CPU/memory)
- Our backend becomes read-only for recordings — simpler, nothing to corrupt
- Camera's recording engine is purpose-built; ours would be redundant

### NAS = NFS, not SMB
Amcrest cameras use **NFS** for their NAS recording feature, not SMB/CIFS. The "NFS might have risk" popup in the camera UI is Amcrest's own confirmation of this. Setting up Samba will not work — the cameras will not connect to it.

Working NFS setup:
- Install `nfs-kernel-server` on Ubuntu
- Export: `/nvr *(rw,sync,no_subtree_check,no_root_squash,insecure)` in `/etc/exports`
- Camera NAS tab: Server Address = `11.200.0.110`, Remote Directory = `/nvr/cam1` (or `/nvr/cam2`)
- The Remote Directory field in the Amcrest UI has a ~32 character limit — keep the path short
- Pre-create the subdirectories (`/nvr/cam1`, `/nvr/cam2`) with `chmod 777` — cameras may not create them

### Recording file structure (confirmed)
```
/nvr/cam1/
  {serial}/               ← camera serial, e.g. AMC09446207BFEAB3F
    DVRWorkDirectory      ← camera lock file, ignore
    2026-03-28/
      001/                ← channel number
        dav/              ← always named "dav" regardless of format
          13/             ← hour (0-23)
            13.44.52-13.52.27[R][0@0][0].mp4   ← completed segment
            13.44.52-13.52.27[R][0@0][0].idx   ← index sidecar
            13.52.27-13.52.27[R][0@0][0].mp4_  ← currently recording (trailing _)
```

Key facts:
- **Format is `.mp4`** — directly browser-playable, no conversion needed
- **In-progress files have a trailing `_`** — indexer must ignore `*.mp4_` files
- **`[R]` = Regular** (continuous/general), **`[M]` = Motion detected** — useful for timeline markers
- **Filename encodes start/end timestamps** — no need to read file metadata for time range
- Camera schedule has General, Motion, and Alarm recording types all enabled 24/7

### NTP — local time server for cameras
Cameras need accurate time for recording filenames and timestamp overlays. The Ubuntu server runs `chrony` (already installed on Ubuntu 25.10) and is configured to serve NTP on the LAN.

Config added at `/etc/chrony/conf.d/lan-server.conf`:
```
allow 11.200.0.0/24
local stratum 10
```
`local stratum 10` is the key for offline use — without it, chrony stops answering clients when it has no upstream internet sync. With it, the local hardware clock becomes the fallback source.

Camera NTP settings: Server = `11.200.0.110`, Port = `123`. Both cameras confirmed querying the local server (`sudo chronyc clients`).

## Future Features (Deferred)
- Motion/object detection with timeline markers
- Discord notifications
- Snapshot capture
- External drive support
- One-click launch: `.desktop` launcher or shell script that starts backend + frontend and opens the browser
