import { useEffect, useRef, useState } from 'react'
import type { Camera } from '../lib/types'
import CameraCard from './CameraCard'
import DualCard from './DualCard'

interface Props {
  cameras: Camera[]
}

function getCardOrder(cameraIds: string[]): string[] {
  try {
    const saved = localStorage.getItem('nvr_card_order')
    if (saved) {
      const parsed: string[] = JSON.parse(saved)
      const valid = new Set([...cameraIds, 'combined'])
      const filtered = parsed.filter((id) => valid.has(id))
      const missing = [...cameraIds, 'combined'].filter((id) => !filtered.includes(id))
      return [...filtered, ...missing]
    }
  } catch {}
  return [...cameraIds, 'combined']
}

function getEnabledState(): Record<string, boolean> {
  try {
    // Prefer the unified key written by Settings; fall back to legacy combined key.
    const unified = localStorage.getItem('nvr_enabled')
    if (unified) return JSON.parse(unified)
    const combined = localStorage.getItem('nvr_combined_enabled')
    return { cam1: true, cam2: true, combined: combined !== 'false' }
  } catch { return { cam1: true, cam2: true, combined: true } }
}

export default function CameraGrid({ cameras }: Props) {
  const [order, setOrder] = useState<string[]>([])
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const initialized = useRef(false)

  // Initialize once when cameras first loads (starts as [] until API responds).
  useEffect(() => {
    if (cameras.length === 0 || initialized.current) return
    initialized.current = true
    setOrder(getCardOrder(cameras.map((c) => c.id)))
    setEnabled(getEnabledState())
  }, [cameras])

  if (cameras.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        No cameras configured.
      </div>
    )
  }

  // Fall back to default order on the first render before initialization completes.
  const displayOrder =
    order.length > 0
      ? order
      : [...cameras.map((c) => c.id), 'combined']

  return (
    <div
      className="grid gap-4 p-6"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))' }}
    >
      {displayOrder.map((id) => {
        if (id === 'combined') {
          if ((enabled.combined ?? true) === false || cameras.length < 2) return null
          return <DualCard key="combined" cameras={cameras} />
        }
        const cam = cameras.find((c) => c.id === id)
        if (!cam) return null
        if ((enabled[id] ?? true) === false) return null
        return <CameraCard key={cam.id} camera={cam} />
      })}
    </div>
  )
}
