# Woodshop Security

A self-hosted home security NVR built for Amcrest PoE cameras. Streams 24/7 to a local Ubuntu server with a modern dark-theme web UI accessible from any device on the local network.

## Features

- **Live streaming** — HLS streams (~6s latency) from each camera, viewable in any modern browser
- **Dual-quality streams** — full-resolution main stream (2960×1668) in the detail view, sub-stream thumbnails (704×480) in the grid
- **Recorded playback** — full DVR timeline scrubber with zoom/pan, segment coloring (blue=regular, amber=motion), sprite thumbnail preview while scrubbing, gap detection
- **Audio** — live audio in the full camera view; mute/unmute state persisted; works in all browsers including Safari
- **Combined stereo view** — third grid card plays both cameras simultaneously with true L/R stereo audio via Web Audio API; inline balance slider and channel swap
- **Zoom & pan** — pinch or scroll to zoom (up to 8×), drag to pan; trackpad, mouse, and touch all supported
- **Fullscreen** — button in top bar; Escape to exit
- **Settings** — reorder and show/hide camera cards via drag-and-drop; retention window (0–14 days); storage settings
- **24/7 recording** — continuous `.mp4` segments written directly by cameras to a local NFS share; backend is read-only for recordings (survives backend restarts)
- **Docker-ready** — single Compose file

## Stack

| Layer | Tech |
|---|---|
| Backend | Go + [Fiber](https://github.com/gofiber/fiber) |
| Video pipeline | FFmpeg (HLS segmenter, stream-copy video, AAC audio transcode) |
| Recording | Camera-side NFS — cameras write `.mp4` directly to Ubuntu NFS export |
| Recording index | SQLite with WAL mode; faststart rewrite + sprite sheet generation |
| Frontend | React + Vite + Tailwind CSS |
| Deployment | Docker Compose |

## Getting Started

### Requirements

- Ubuntu (tested on 25.10)
- `ffmpeg` installed (`sudo apt install ffmpeg`)
- Go 1.24+ (`sudo apt install golang-go`)
- Node 18+ / npm
- `nfs-kernel-server` for camera recording (`sudo apt install nfs-kernel-server`)

### Development

```bash
# Terminal 1 — backend (also starts all FFmpeg processes)
cd backend
go run .

# Terminal 2 — frontend (Vite dev server with proxy to backend)
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**

### LAN access (no Docker)

```bash
cd frontend && npm run build
cd backend && go run .
```

Open **http://&lt;server-ip&gt;:8080** from any device on the network.

### Production (Docker)

```bash
cd frontend && npm run build && cd ..
docker compose up -d
```

Open **http://&lt;server-ip&gt;:8080**

## Project Structure

```
woodshop_security/
├── backend/
│   ├── main.go                           # Fiber server, routes, FFmpeg manager startup
│   └── internal/
│       ├── ffmpeg/manager.go             # FFmpeg subprocess lifecycle management
│       ├── index/                        # Recording indexer
│       │   ├── indexer.go                # Scans /nvr every 60s, queues work
│       │   ├── faststart.go              # ffmpeg moov-to-front rewrite
│       │   ├── sprite.go                 # ffmpeg sprite sheet generation
│       │   ├── db.go                     # SQLite CRUD
│       │   ├── schema.go                 # DB schema
│       │   └── parse.go                  # Amcrest filename parser
│       ├── retention/cleaner.go          # Hourly retention sweep
│       └── settings/settings.go          # Thread-safe JSON settings store
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── CameraCard.tsx            # Grid thumbnail card
│       │   ├── CameraGrid.tsx            # Responsive camera grid
│       │   ├── DualCard.tsx              # Combined stereo grid card
│       │   ├── HlsPlayer.tsx             # hls.js video player component
│       │   ├── Timeline.tsx              # RAF-based DVR timeline scrubber
│       │   └── Layout.tsx                # Top nav shell
│       ├── lib/
│       │   ├── api.ts                    # Fetch wrappers, hlsUrl() helper
│       │   ├── dualSettings.ts           # Combined view settings
│       │   └── types.ts                  # Camera, RecordingSegment types
│       └── pages/
│           ├── Dashboard.tsx             # Main camera grid view
│           ├── CameraPage.tsx            # Full camera view + DVR playback
│           ├── DualCameraPage.tsx        # Combined stereo view
│           └── Settings.tsx              # Retention, card order/visibility
├── docker-compose.yml
├── ARCHITECTURE.md                       # System diagram + pipeline details
└── CLAUDE.md                             # Full project context and dev notes
```

## Hardware (reference setup)

- **Server:** Intel i7-8700T, ~8 GB RAM, 937 GB NVMe, Intel UHD 630 (VAAPI capable)
- **Cameras:** 2× Amcrest IP5M-T1277EB-AI PoE @ 2960×1668, 20fps, H.264 CBR 5120 Kbps

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Backend listen port |
| `HLS_DIR` | `./hls` | HLS segment output directory |
| `NVR_DIR` | `/nvr` | Root of NFS recording volume |
| `CONFIG_DIR` | `./config` | Settings JSON + SQLite DB |
| `STATIC_DIR` | `../frontend/dist` | Built React SPA |
