export interface DualSettings {
  leftCam: string  // camera ID assigned to the left audio channel (top panel)
  balance: number  // -1 (full left) to 1 (full right), 0 = equal
}

const DEFAULTS: DualSettings = { leftCam: 'cam2', balance: 0 }

// Static camera metadata — avoids fetching /api/cameras on every dual-view component.
export const CAM_NAMES: Record<string, string> = {
  cam1: 'SE-Driveway',
  cam2: 'NW-Front',
}

// Given one cam ID, returns the other.
export const OTHER_CAM: Record<string, string> = { cam1: 'cam2', cam2: 'cam1' }

export function getDualSettings(): DualSettings {
  try {
    const raw = localStorage.getItem('nvr_dual_settings')
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {}
  return { ...DEFAULTS }
}

export function saveDualSettings(s: DualSettings): void {
  try { localStorage.setItem('nvr_dual_settings', JSON.stringify(s)) } catch {}
}
