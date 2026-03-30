package index

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

func atoi2(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

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

	// Parse the date in the server's local timezone. Camera filenames use the
	// local clock (cameras are NTP-synced to this server), so treating them as
	// UTC would shift every timestamp by the UTC offset (e.g. 7 h for PDT).
	base, err := time.ParseInLocation("2006-01-02", date, time.Local)
	if err != nil {
		return segmentInfo{}, fmt.Errorf("invalid date %q: %w", date, err)
	}

	startTime := time.Date(
		base.Year(), base.Month(), base.Day(),
		atoi2(m[1]), atoi2(m[2]), atoi2(m[3]),
		0, time.Local,
	)

	endTime := time.Date(
		base.Year(), base.Month(), base.Day(),
		atoi2(m[4]), atoi2(m[5]), atoi2(m[6]),
		0, time.Local,
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
