package index

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
)

// runFaststart rewrites src .mp4 with the moov atom at the front so browsers
// can begin playback and seek without downloading the whole file first.
// Writes to src+".faststart.tmp" then atomically renames to src.
// Safe to call concurrently for different files.
func runFaststart(ctx context.Context, src string) error {
	tmp := src + ".faststart.tmp"

	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx,
		"ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-i", src,
		"-movflags", "+faststart",
		"-c", "copy",
		tmp,
	)
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("ffmpeg faststart %q: %w — %s", src, err, stderr.String())
	}

	if err := os.Rename(tmp, src); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename faststart tmp: %w", err)
	}

	return nil
}
