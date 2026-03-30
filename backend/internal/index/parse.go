package index

import (
	"fmt"
	"regexp"
	"time"
)

type segmentInfo struct {
	StartTime time.Time
	EndTime   time.Time
	Motion    bool
}

var segmentRegexp = regexp.MustCompile(
	`^(\d{2})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2})\[([RM])\]`,
)

// parseSegmentFilename parses a recording filename given date string (YYYY-MM-DD).
// Caller must ensure filename does NOT end with "_" before calling.
// Handles midnight-crossing segments (end hour < start hour → add 24h to end).
func parseSegmentFilename(date, filename string) (segmentInfo, error) {
	m := segmentRegexp.FindStringSubmatch(filename)
	if m == nil {
		return segmentInfo{}, fmt.Errorf("filename does not match segment pattern: %s", filename)
	}

	base, err := time.Parse("2006-01-02", date)
	if err != nil {
		return segmentInfo{}, fmt.Errorf("invalid date %q: %w", date, err)
	}

	startTime, err := time.Parse("2006-01-02 15:04:05",
		fmt.Sprintf("%s %s:%s:%s", date, m[1], m[2], m[3]))
	if err != nil {
		return segmentInfo{}, fmt.Errorf("parse start time: %w", err)
	}
	startTime = time.Date(
		base.Year(), base.Month(), base.Day(),
		startTime.Hour(), startTime.Minute(), startTime.Second(),
		0, time.UTC,
	)

	endTime, err := time.Parse("2006-01-02 15:04:05",
		fmt.Sprintf("%s %s:%s:%s", date, m[4], m[5], m[6]))
	if err != nil {
		return segmentInfo{}, fmt.Errorf("parse end time: %w", err)
	}
	endTime = time.Date(
		base.Year(), base.Month(), base.Day(),
		endTime.Hour(), endTime.Minute(), endTime.Second(),
		0, time.UTC,
	)

	if endTime.Before(startTime) {
		endTime = endTime.Add(24 * time.Hour)
	}

	return segmentInfo{
		StartTime: startTime,
		EndTime:   endTime,
		Motion:    m[7] == "M",
	}, nil
}
