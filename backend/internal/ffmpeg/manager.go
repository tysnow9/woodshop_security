package ffmpeg

import (
	"context"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// Stream describes one FFmpeg HLS output (one per camera per quality level).
type Stream struct {
	ID        string // e.g. "cam1-thumb", "cam1-main"
	RTSPURL   string
	HLSDir    string
	Transcode bool // true = libx264 ultrafast; false = stream copy
}

// Manager owns all FFmpeg subprocesses and restarts them on failure.
type Manager struct {
	streams []Stream
	wg      sync.WaitGroup
}

func New(streams []Stream) *Manager {
	return &Manager{streams: streams}
}

// Start launches all streams in background goroutines.
// It returns immediately; call Wait() to block until ctx is cancelled.
func (m *Manager) Start(ctx context.Context) {
	for _, s := range m.streams {
		s := s
		m.wg.Add(1)
		go func() {
			defer m.wg.Done()
			runWithRestart(ctx, s)
		}()
	}
}

func (m *Manager) Wait() {
	m.wg.Wait()
}

func runWithRestart(ctx context.Context, s Stream) {
	backoff := 3 * time.Second
	const maxBackoff = 60 * time.Second

	for {
		if ctx.Err() != nil {
			return
		}

		if err := os.MkdirAll(s.HLSDir, 0o755); err != nil {
			log.Printf("[ffmpeg/%s] mkdir: %v — retry in %v", s.ID, err, backoff)
		} else {
			log.Printf("[ffmpeg/%s] starting", s.ID)
			err = run(ctx, s)
			if ctx.Err() != nil {
				// Clean shutdown — don't restart
				log.Printf("[ffmpeg/%s] stopped", s.ID)
				return
			}
			log.Printf("[ffmpeg/%s] exited (%v) — restart in %v", s.ID, err, backoff)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < maxBackoff {
			backoff *= 2
		}
	}
}

func run(ctx context.Context, s Stream) error {
	m3u8 := filepath.Join(s.HLSDir, "live.m3u8")
	segPat := filepath.Join(s.HLSDir, "seg%06d.ts")

	args := []string{
		"-hide_banner", "-loglevel", "warning",
		"-rtsp_transport", "udp",
		"-use_wallclock_as_timestamps", "1",
		"-i", s.RTSPURL,
	}

	if s.Transcode {
		// Sub stream: transcode to ensure browser-compatible HLS.
		// aresample=async=1 smooths out the jittery timestamps Amcrest cameras produce.
		args = append(args,
			"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
			"-c:a", "aac", "-ar", "22050", "-af", "aresample=async=1",
		)
	} else {
		// Main stream: copy video (zero CPU), transcode audio.
		// The camera's RTSP stream carries AAC without proper ADTS framing headers —
		// stream-copying results in segments with unspecified sample rate/channels that
		// browsers cannot decode. Transcoding regenerates proper ADTS-framed AAC-LC.
		// aresample=async=1 smooths the jittery timestamps the camera produces.
		args = append(args,
			"-c:v", "copy",
			// async=1000: allow up to ~20ms/s of timestamp-drift correction via
			// stretching/squeezing rather than silence insertion. The camera's jittery
			// RTSP timestamps can produce small gaps that become audible clicks/pops
			// when routed through the Web Audio API; larger async budget keeps the
			// audio stream continuous without the silence-insertion artifacts of async=1.
			"-c:a", "aac", "-ar", "48000", "-b:a", "128k", "-af", "aresample=async=1000",
		)
	}

	args = append(args,
		"-f", "hls",
		"-hls_time", "1",
		"-hls_list_size", "8",
		"-hls_flags", "delete_segments+append_list+omit_endlist+program_date_time",
		"-hls_segment_filename", segPat,
		m3u8,
	)

	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
