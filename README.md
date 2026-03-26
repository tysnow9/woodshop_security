# Woodshop Security

A self-hosted home security NVR (network video recorder) built for Amcrest PoE cameras. Streams 24/7 to a local Ubuntu PC with a modern dark-theme web UI accessible from anywhere on the local network.

## Features

- **Live streaming** — low-latency HLS streams (~3s behind live) from each camera, viewable in any modern browser
- **Dual-quality streams** — full-resolution main stream (2960×1668) in the detail view, sub-stream thumbnails (704×480) in the grid
- **Audio** — live audio in the full camera view; mute/unmute with state persisted across sessions
- **Fullscreen** — fullscreen button or double-click the video; Escape to exit
- **24/7 recording** *(in progress)* — continuous segmented recordings with configurable rolling retention
- **DVR timeline** *(in progress)* — scrub back through recordings, jump to any point, return to live
- **Dark UI** — clean, responsive React interface; works on desktop and tablet
- **Camera settings** — gear icon on each card opens the native Amcrest web UI directly
- **Docker-ready** — single Compose file with VAAPI hardware acceleration passthrough

## Stack

| Layer | Tech |
|---|---|
| Backend | Go + [Fiber](https://github.com/gofiber/fiber) |
| Video pipeline | FFmpeg (HLS segmenter, stream-copy video, AAC audio transcode) |
| Frontend | React + Vite + Tailwind CSS |
| Metadata | SQLite *(upcoming)* |
| Deployment | Docker Compose |

## Getting Started

### Requirements

- Ubuntu (tested on 25.10)
- `ffmpeg` installed (`sudo apt install ffmpeg`)
- Go 1.24+ (`sudo apt install golang-go`)
- Node 18+ / npm

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

### Production (Docker)

```bash
# Build the frontend first
cd frontend && npm run build && cd ..

# Run with Docker Compose
docker compose up -d
```

Open **http://&lt;server-ip&gt;:8080**

## Project Structure

```
woodshop_security/
├── backend/
│   ├── main.go                      # Fiber server, routes, FFmpeg manager startup
│   └── internal/ffmpeg/manager.go  # FFmpeg subprocess lifecycle management
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── CameraCard.tsx       # Grid thumbnail card
│       │   ├── CameraGrid.tsx       # Responsive camera grid
│       │   ├── HlsPlayer.tsx        # hls.js video player component
│       │   └── Layout.tsx           # Top nav shell
│       └── pages/
│           ├── Dashboard.tsx        # Main camera grid view
│           ├── CameraPage.tsx       # Full camera view + timeline
│           └── Settings.tsx         # Settings page (UI shell)
├── docker-compose.yml
└── CLAUDE.md                        # Architecture notes and dev context
```

## Hardware (reference setup)

- **Server:** Intel i7-8700T, 8 GB RAM, 1 TB NVMe, Intel UHD 630 (VAAPI)
- **Cameras:** 2× Amcrest PoE @ 2960×1668, 20fps, H.264 + AAC 48kHz
