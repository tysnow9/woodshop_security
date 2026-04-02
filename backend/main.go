package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"

	"woodshop-security/internal/ffmpeg"
	"woodshop-security/internal/index"
	"woodshop-security/internal/retention"
	"woodshop-security/internal/settings"
)

type Camera struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	IP     string `json:"ip"`
	Status string `json:"status"`
}

// Hardcoded for now — will move to config file
var cameras = []Camera{
	{ID: "cam1", Name: "SE-Driveway", IP: "11.200.0.101", Status: "online"},
	{ID: "cam2", Name: "NW-Front", IP: "11.200.0.102", Status: "online"},
}

const rtspUser = "admin"
const rtspPass = "Admin1001"

func rtspURL(ip, subtype string) string {
	return "rtsp://" + rtspUser + ":" + rtspPass + "@" + ip + ":554/cam/realmonitor?channel=1&subtype=" + subtype
}

func main() {
	port := getEnv("PORT", "8080")
	staticDir := getEnv("STATIC_DIR", "../frontend/dist")
	hlsDir := getEnv("HLS_DIR", "./hls")
	nvrDir := getEnv("NVR_DIR", "/nvr")
	configDir := getEnv("CONFIG_DIR", "./config")

	store, err := settings.Load(filepath.Join(configDir, "settings.json"))
	if err != nil {
		log.Fatalf("failed to load settings: %v", err)
	}

	// Build FFmpeg stream list — sub (thumb) + main per camera
	var streams []ffmpeg.Stream
	for _, cam := range cameras {
		streams = append(streams,
			ffmpeg.Stream{
				ID:        cam.ID + "-thumb",
				RTSPURL:   rtspURL(cam.IP, "1"), // sub stream
				HLSDir:    filepath.Join(hlsDir, cam.ID, "thumb"),
				Transcode: true, // sub stream needs transcode for browser compat
			},
			ffmpeg.Stream{
				ID:        cam.ID + "-main",
				RTSPURL:   rtspURL(cam.IP, "0"), // main stream
				HLSDir:    filepath.Join(hlsDir, cam.ID, "main"),
				Transcode: false, // stream copy — full res, zero CPU
			},
		)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	mgr := ffmpeg.New(streams)
	mgr.Start(ctx)

	cleaner := retention.New(nvrDir, func() int { return store.Get().RetentionDays })
	cleaner.Start(ctx)

	dbPath := filepath.Join(configDir, "recordings.db")
	recDB, err := index.OpenDB(dbPath)
	if err != nil {
		log.Fatalf("failed to open recordings DB: %v", err)
	}

	indexer := index.NewIndexer(nvrDir, recDB, func() int {
		return store.Get().RetentionDays
	})
	indexer.Start(ctx)

	app := fiber.New(fiber.Config{
		AppName:               "Woodshop Security",
		DisableStartupMessage: false,
	})

	app.Use(logger.New(logger.Config{
		Format: "[${time}] ${status} ${method} ${path}\n",
		Next:   func(c *fiber.Ctx) bool { return strings.HasPrefix(c.Path(), "/hls/") },
	}))
	app.Use(cors.New())

	// API
	api := app.Group("/api")
	api.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok"})
	})
	api.Get("/cameras", func(c *fiber.Ctx) error {
		return c.JSON(cameras)
	})

	api.Get("/settings", func(c *fiber.Ctx) error {
		return c.JSON(store.Get())
	})

	// Known camera IDs for validation.
	knownCams := make(map[string]bool)
	for _, cam := range cameras {
		knownCams[cam.ID] = true
	}
	var dateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

	// GET /api/recordings/dates?cam=cam1
	api.Get("/recordings/dates", func(c *fiber.Ctx) error {
		cam := c.Query("cam")
		if !knownCams[cam] {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "unknown cam"})
		}
		dates, err := recDB.ListDates(cam)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}
		if dates == nil {
			dates = []string{}
		}
		return c.JSON(fiber.Map{"cam": cam, "dates": dates})
	})

	// GET /api/recordings?cam=cam1&date=2026-03-28
	api.Get("/recordings", func(c *fiber.Ctx) error {
		cam := c.Query("cam")
		date := c.Query("date")
		if !knownCams[cam] {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "unknown cam"})
		}
		if !dateRE.MatchString(date) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid date"})
		}
		rows, err := recDB.ListByDate(cam, date)
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}

		type segment struct {
			ID          int64  `json:"id"`
			StartTime   string `json:"startTime"`
			EndTime     string `json:"endTime"`
			Motion      bool   `json:"motion"`
			DurationSec int    `json:"durationSec"`
			HasSprite   bool   `json:"hasSprite"`
			VideoURL    string `json:"videoUrl"`
			SpriteURL   string `json:"spriteUrl"`
		}

		// Resolve R/M overlaps: when a segment's end time overlaps with the
		// next segment's start time (e.g. R clip has a ~5s tail into an M clip),
		// trim the earlier segment's end time to the next segment's start.
		// Drop any segment that becomes shorter than 5 seconds after trimming.
		const minDurationSec = 5
		{
			n := 0
			for i := range rows {
				if i+1 < len(rows) && rows[i].EndTime.After(rows[i+1].StartTime) {
					rows[i].EndTime = rows[i+1].StartTime
				}
				if int(rows[i].EndTime.Sub(rows[i].StartTime).Seconds()) >= minDurationSec {
					rows[n] = rows[i]
					n++
				}
			}
			rows = rows[:n]
		}

		segs := make([]segment, 0, len(rows))
		for _, r := range rows {
			// Skip rows whose files were deleted (e.g. by the retention cleaner
			// before the DB prune runs, or from a prior misconfigured cutoff).
			if _, err := os.Stat(r.FilePath); err != nil {
				continue
			}
			segs = append(segs, segment{
				ID:          r.ID,
				StartTime:   r.StartTime.UTC().Format("2006-01-02T15:04:05Z"),
				EndTime:     r.EndTime.UTC().Format("2006-01-02T15:04:05Z"),
				Motion:      r.Motion,
				DurationSec: int(r.EndTime.Sub(r.StartTime).Seconds()),
				HasSprite:   r.SpritePath != "",
				VideoURL:    "/recordings/" + strconv.FormatInt(r.ID, 10) + "/video",
				SpriteURL:   "/recordings/" + strconv.FormatInt(r.ID, 10) + "/sprite",
			})
		}
		return c.JSON(fiber.Map{"cam": cam, "date": date, "segments": segs})
	})

	api.Put("/settings", func(c *fiber.Ctx) error {
		var next settings.Settings
		if err := c.BodyParser(&next); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		}
		if next.RetentionDays < 0 || next.RetentionDays > 365 {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "retentionDays must be 0–365"})
		}
		if err := store.Set(next); err != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(store.Get())
	})

	// Recording file serving — video and sprite.
	app.Get("/recordings/:id/video", func(c *fiber.Ctx) error {
		id, err := strconv.ParseInt(c.Params("id"), 10, 64)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid id"})
		}
		row, err := recDB.GetByID(id)
		if err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "not found"})
		}
		if _, err := os.Stat(row.FilePath); err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "file not found"})
		}
		c.Set("Cache-Control", "public, max-age=3600, immutable")
		return c.SendFile(row.FilePath)
	})

	app.Get("/recordings/:id/sprite", func(c *fiber.Ctx) error {
		id, err := strconv.ParseInt(c.Params("id"), 10, 64)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "invalid id"})
		}
		row, err := recDB.GetByID(id)
		if err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "not found"})
		}
		if row.SpritePath == "" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "sprite not yet generated"})
		}
		if _, err := os.Stat(row.SpritePath); err != nil {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "sprite file not found"})
		}
		c.Set("Cache-Control", "public, max-age=3600, immutable")
		return c.SendFile(row.SpritePath)
	})

	// HLS playlists: no-cache so hls.js always sees the latest segment list.
	// Fiber's Static handler caches file metadata for 10s by default, which causes
	// hls.js to receive stale 304s while FFmpeg is writing new segments every 2s.
	app.Get("/hls/:cam/:stream/live.m3u8", func(c *fiber.Ctx) error {
		path := filepath.Join(hlsDir, c.Params("cam"), c.Params("stream"), "live.m3u8")
		data, err := os.ReadFile(path)
		if err != nil {
			return fiber.ErrNotFound
		}
		c.Set("Cache-Control", "no-cache, no-store")
		c.Set("Content-Type", "application/vnd.apple.mpegurl")
		return c.Send(data)
	})

	// HLS segments: immutable once written, cache freely.
	app.Static("/hls", hlsDir, fiber.Static{
		Browse: false,
		MaxAge: 3600,
	})

	// React SPA
	app.Static("/", staticDir)
	app.Get("*", func(c *fiber.Ctx) error {
		return c.SendFile(staticDir + "/index.html")
	})

	// Shut down fiber when context is cancelled (Ctrl+C / SIGTERM)
	go func() {
		<-ctx.Done()
		log.Println("Shutting down...")
		_ = app.Shutdown()
	}()

	log.Printf("Woodshop Security on :%s\n", port)
	if err := app.Listen(":" + port); err != nil {
		log.Fatal(err)
	}

	mgr.Wait()
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
