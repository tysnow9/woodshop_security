import type { Camera, RecordingDatesResponse, RecordingsResponse } from './types'

const BASE = '/api'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export type AppSettings = { retentionDays: number }

export const api = {
  cameras: {
    list: () => get<Camera[]>('/cameras'),
  },
  settings: {
    get: () => get<AppSettings>('/settings'),
    update: (s: AppSettings) => put<AppSettings>('/settings', s),
  },
  recordings: {
    listDates: (cam: string) =>
      get<RecordingDatesResponse>(`/recordings/dates?cam=${encodeURIComponent(cam)}`),
    listByDate: (cam: string, date: string) =>
      get<RecordingsResponse>(`/recordings?cam=${encodeURIComponent(cam)}&date=${encodeURIComponent(date)}`),
  },
}

export function hlsUrl(cameraId: string, stream: 'thumb' | 'main'): string {
  return `/hls/${cameraId}/${stream}/live.m3u8`
}
