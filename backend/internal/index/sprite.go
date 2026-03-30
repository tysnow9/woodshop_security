package index

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// generateSprite creates a horizontal contact sheet: 1 frame per 10 seconds,
// tiled in a single row, each frame scaled to 640×360px.
// Output: same dir as src, same basename, extension ".sprite.jpg"
// e.g. /nvr/.../13.44.52-13.52.27[R][0@0][0].sprite.jpg
// Returns the sprite path on success.
func generateSprite(ctx context.Context, srcPath string) (string, error) {
	spritePath := strings.TrimSuffix(srcPath, ".mp4") + ".sprite.jpg"

	// Skip if already generated.
	if _, err := os.Stat(spritePath); err == nil {
		return spritePath, nil
	}

	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx,
		"ffmpeg",
		"-skip_frame", "noref",
		"-hide_banner", "-loglevel", "error",
		"-i", srcPath,
		"-vf", "fps=1/10,scale=640:360,tile=500x1",
		"-frames:v", "1",
		"-q:v", "3",
		spritePath,
	)
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("ffmpeg sprite %q: %w — %s", srcPath, err, stderr.String())
	}

	return spritePath, nil
}
