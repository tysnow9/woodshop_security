import type { Camera } from './types'

const BASE = '/api'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

export const api = {
  cameras: {
    list: () => get<Camera[]>('/cameras'),
  },
}

export function hlsUrl(cameraId: string, stream: 'thumb' | 'main'): string {
  return `/hls/${cameraId}/${stream}/live.m3u8`
}
