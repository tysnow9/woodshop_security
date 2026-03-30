export interface Camera {
  id: string
  name: string
  ip: string
  status: 'online' | 'offline'
}

export interface RecordingSegment {
  id: number
  startTime: string      // ISO 8601 UTC: "2026-03-28T13:44:52Z"
  endTime: string        // ISO 8601 UTC
  motion: boolean
  durationSec: number
  hasSprite: boolean
  videoUrl: string       // "/recordings/42/video"
  spriteUrl: string      // "/recordings/42/sprite"
}

export interface RecordingsResponse {
  cam: string
  date: string
  segments: RecordingSegment[]
}

export interface RecordingDatesResponse {
  cam: string
  dates: string[]
}
