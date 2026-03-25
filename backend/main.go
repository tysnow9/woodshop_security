package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"

	"woodshop-security/internal/ffmpeg"
)

type Camera struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	IP     string `json:"ip"`
	Status string `json:"status"`
}

// Hardcoded for now — will move to config file
var cameras = []Camera{
	{ID: "cam1", Name: "Front Yard", IP: "11.200.0.101", Status: "online"},
	{ID: "cam2", Name: "Back Yard", IP: "11.200.0.102", Status: "online"},
}

const rtspUser = "admin"
const rtspPass = "Admin1001"

func rtspURL(ip, subtype string) string {
	return "rtsp://" + rtspUser + ":" + rtspPass + "@" + ip + ":554/cam/realmonitor?channel=1&subtype=" + subtype
}

func main() {
	port := getEnv("PORT", "8080")
	staticDir := getEnv("STATIC_DIR", "./static")
	hlsDir := getEnv("HLS_DIR", "./hls")

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

	app := fiber.New(fiber.Config{
		AppName:               "Woodshop Security",
		DisableStartupMessage: false,
	})

	app.Use(logger.New(logger.Config{
		Format: "[${time}] ${status} ${method} ${path}\n",
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

	// HLS segments served from disk
	app.Static("/hls", hlsDir, fiber.Static{
		Browse: false,
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
