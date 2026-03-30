import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RecordingSegment } from '../lib/types'

interface TimelineProps {
  segments: RecordingSegment[]
  date: string               // YYYY-MM-DD — defines day bounds for clamping
  currentTime: Date | null   // current playback position; null when live
  onSeek: (time: Date) => void
  onLive: () => void
  onScrubChange: (scrubbing: boolean, segment: RecordingSegment | null, frameIndex: number) => void
  isLive: boolean
  className?: string
}

// ── Coordinate helpers ──────────────────────────────────────────────────────

function timeToX(tMs: number, barWidth: number, centerMs: number, pps: number): number {
  return barWidth / 2 + ((tMs - centerMs) / 1000) * pps
}

function xToTime(x: number, barWidth: number, centerMs: number, pps: number): number {
  return centerMs + ((x - barWidth / 2) / pps) * 1000
}

function clampPixelsPerSec(pps: number, barWidth: number): number {
  const minPps = barWidth / (24 * 3600) // full day fits
  const maxPps = barWidth / 120          // 2 minutes fills the bar
  return Math.max(minPps, Math.min(maxPps, pps))
}

function localDayBounds(date: string): { dayStart: number; dayEnd: number } {
  const [y, m, d] = date.split('-').map(Number)
  return {
    dayStart: new Date(y, m - 1, d).getTime(),       // local midnight
    dayEnd:   new Date(y, m - 1, d + 1).getTime(),   // local next midnight
  }
}

function clampCenter(centerMs: number, date: string): number {
  const { dayStart, dayEnd } = localDayBounds(date)
  return Math.max(dayStart, Math.min(dayEnd, centerMs))
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

// ── Label helpers ───────────────────────────────────────────────────────────

const LABEL_INTERVALS_SEC = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800]

function getLabelIntervalSec(pixelsPerSec: number): number {
  const targetSec = 100 / pixelsPerSec
  return LABEL_INTERVALS_SEC.find(i => i >= targetSec) ?? 10800
}

function getVisibleLabels(
  centerMs: number,
  pixelsPerSec: number,
  barWidth: number,
  date: string,
): Array<{ ms: number; x: number; label: string }> {
  if (pixelsPerSec === 0) return []
  const intervalSec = getLabelIntervalSec(pixelsPerSec)
  const intervalMs = intervalSec * 1000
  const { dayStart, dayEnd } = localDayBounds(date)
  const firstMs  = Math.ceil(dayStart / intervalMs) * intervalMs
  const result = []
  for (let ms = firstMs; ms <= dayEnd; ms += intervalMs) {
    const x = timeToX(ms, barWidth, centerMs, pixelsPerSec)
    if (x < -40 || x > barWidth + 40) continue
    const dt = new Date(ms)
    const h = dt.getHours().toString().padStart(2, '0')
    const m = dt.getMinutes().toString().padStart(2, '0')
    result.push({ ms, x, label: m === '00' ? h + ':00' : h + ':' + m })
  }
  return result
}

// ── Component ───────────────────────────────────────────────────────────────

export default function Timeline({
  segments,
  date,
  currentTime,
  onSeek,
  onLive,
  onScrubChange,
  isLive,
  className,
}: TimelineProps) {
  // Hot-path refs — never cause a React re-render directly
  const viewCenterMsRef    = useRef<number>(Date.now())
  const pixelsPerSecRef    = useRef<number>(0)
  const userInteractingRef = useRef(false)
  // True when the user has manually panned away from the live edge.
  // Prevents the live tick from snapping the view back while they explore.
  // Cleared when entering live mode (Go Live).
  const userHasPannedRef   = useRef(false)
  const lastPointerXRef    = useRef<number | null>(null)
  const rafRef             = useRef<number | null>(null)
  const interactTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const liveTickRef        = useRef<ReturnType<typeof setInterval> | null>(null)
  // Tracks previous interacting state so onScrubChange only fires on transitions.
  const wasInteractingRef  = useRef(false)

  // State — synced from refs via RAF flush
  const [viewCenterMs, setViewCenterMs] = useState<number>(Date.now())
  const [pixelsPerSec, setPixelsPerSec] = useState<number>(0)
  const [interacting, setInteracting]   = useState(false)

  const barRef = useRef<HTMLDivElement>(null)

  // Keep stable refs to props used inside RAF/event handlers to avoid stale closures
  const segmentsRef      = useRef(segments)
  const onScrubChangeRef = useRef(onScrubChange)
  const dateRef          = useRef(date)
  useEffect(() => { segmentsRef.current = segments }, [segments])
  useEffect(() => { onScrubChangeRef.current = onScrubChange }, [onScrubChange])
  useEffect(() => { dateRef.current = date }, [date])

  // ── RAF flush ────────────────────────────────────────────────────────────

  function scheduleFlush() {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const centerMs      = viewCenterMsRef.current
      const isInteracting = userInteractingRef.current

      let scrubSeg: RecordingSegment | null = null
      let scrubFrame = 0
      if (isInteracting) {
        scrubSeg = segmentsRef.current.find(s =>
          new Date(s.startTime).getTime() <= centerMs &&
          new Date(s.endTime).getTime()   >= centerMs
        ) ?? null
        if (scrubSeg) {
          scrubFrame = Math.floor((centerMs - new Date(scrubSeg.startTime).getTime()) / 10000)
        }
      }

      setViewCenterMs(centerMs)
      setPixelsPerSec(pixelsPerSecRef.current)
      setInteracting(isInteracting)

      // Only notify parent when scrub state actually changes, not on every live tick.
      if (isInteracting !== wasInteractingRef.current || isInteracting) {
        wasInteractingRef.current = isInteracting
        onScrubChangeRef.current(isInteracting, scrubSeg, scrubFrame)
      }
    })
  }

  // ── Initialization ───────────────────────────────────────────────────────

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar || pixelsPerSecRef.current !== 0) return
    const barWidth = bar.getBoundingClientRect().width
    if (barWidth === 0) return
    // Default zoom: 6 hours visible so segments aren't microscopic.
    const SIX_HOURS_SEC = 6 * 3600
    const pps = barWidth / SIX_HOURS_SEC
    pixelsPerSecRef.current = pps

    if (isLive) {
      const halfWindowMs = (barWidth / 2 / pps) * 1000
      viewCenterMsRef.current = Date.now() - halfWindowMs
    } else {
      viewCenterMsRef.current = currentTime?.getTime() ?? Date.now()
    }
    setPixelsPerSec(pps)
    setViewCenterMs(viewCenterMsRef.current)
  }, []) // run once

  // ── Live tick — advance view so live edge stays at right ─────────────────

  useEffect(() => {
    if (!isLive) {
      if (liveTickRef.current) clearInterval(liveTickRef.current)
      return
    }

    // Entering live mode: clear the panned flag and snap view to live edge.
    userHasPannedRef.current = false
    const bar = barRef.current
    if (bar && pixelsPerSecRef.current > 0) {
      const barWidth = bar.getBoundingClientRect().width
      const halfWindowMs = (barWidth / 2 / pixelsPerSecRef.current) * 1000
      viewCenterMsRef.current = Date.now() - halfWindowMs
      scheduleFlush()
    }

    liveTickRef.current = setInterval(() => {
      // Don't override user's manually scrolled position.
      if (userInteractingRef.current || userHasPannedRef.current) return
      const bar = barRef.current
      if (!bar || pixelsPerSecRef.current === 0) return
      const barWidth = bar.getBoundingClientRect().width
      const halfWindowMs = (barWidth / 2 / pixelsPerSecRef.current) * 1000
      viewCenterMsRef.current = Date.now() - halfWindowMs
      scheduleFlush()
    }, 1000)
    return () => { if (liveTickRef.current) clearInterval(liveTickRef.current) }
  }, [isLive])

  // ── Auto-scroll during playback ──────────────────────────────────────────

  useEffect(() => {
    if (isLive || !currentTime || userInteractingRef.current) return
    viewCenterMsRef.current = currentTime.getTime()
    scheduleFlush()
  }, [currentTime, isLive])

  // ── Wheel event (non-passive so preventDefault works) ────────────────────

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return

    function onWheel(e: WheelEvent) {
      e.preventDefault()
      userInteractingRef.current = true
      userHasPannedRef.current = true  // user has manually navigated away from live edge
      if (interactTimerRef.current) clearTimeout(interactTimerRef.current)

      const rect     = bar!.getBoundingClientRect()
      const barWidth = rect.width
      const mouseX   = e.clientX - rect.left

      if (e.shiftKey) {
        const delta      = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
        const zoomFactor = Math.pow(1.002, delta)
        const newPps     = clampPixelsPerSec(pixelsPerSecRef.current * zoomFactor, barWidth)
        const mouseTimeMs = xToTime(mouseX, barWidth, viewCenterMsRef.current, pixelsPerSecRef.current)
        pixelsPerSecRef.current = newPps
        viewCenterMsRef.current = clampCenter(
          mouseTimeMs - ((mouseX - barWidth / 2) / newPps) * 1000,
          dateRef.current,
        )
      } else {
        const delta    = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        const deltaSec = delta / pixelsPerSecRef.current
        viewCenterMsRef.current = clampCenter(
          viewCenterMsRef.current + deltaSec * 1000,
          dateRef.current,
        )
      }

      scheduleFlush()

      interactTimerRef.current = setTimeout(() => {
        userInteractingRef.current = false
      }, 500)
    }

    bar.addEventListener('wheel', onWheel, { passive: false })
    return () => bar.removeEventListener('wheel', onWheel)
  }, [date])

  // ── ResizeObserver ───────────────────────────────────────────────────────

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const ro = new ResizeObserver(() => scheduleFlush())
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])

  // ── Pointer handlers (pan + seek) ────────────────────────────────────────

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    userInteractingRef.current = true
    lastPointerXRef.current = e.clientX
    if (interactTimerRef.current) clearTimeout(interactTimerRef.current)
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!userInteractingRef.current || lastPointerXRef.current === null) return
    const bar = barRef.current
    if (!bar) return
    const dx = e.clientX - lastPointerXRef.current
    if (dx === 0) return
    lastPointerXRef.current = e.clientX
    userHasPannedRef.current = true  // actual drag movement — mark as manually panned
    const deltaSec = dx / pixelsPerSecRef.current
    viewCenterMsRef.current = clampCenter(
      viewCenterMsRef.current - deltaSec * 1000,
      date,
    )
    scheduleFlush()
  }

  function handlePointerUp(_e: React.PointerEvent<HTMLDivElement>) {
    if (!userInteractingRef.current) return
    lastPointerXRef.current = null
    onSeek(new Date(viewCenterMsRef.current))
    interactTimerRef.current = setTimeout(() => {
      userInteractingRef.current = false
    }, 2000)
  }

  // ── Derived: nearby segments for sprite pre-fetch ────────────────────────

  const nearbySegments = [...segments]
    .sort((a, b) =>
      Math.abs(new Date(a.startTime).getTime() - viewCenterMs) -
      Math.abs(new Date(b.startTime).getTime() - viewCenterMs)
    )
    .slice(0, 5)

  // ── Render ───────────────────────────────────────────────────────────────

  const barWidth = barRef.current?.clientWidth ?? 0

  return (
    <div className={`flex items-center gap-3 px-3 pb-3 pt-1 ${className ?? ''}`}>
      {/* Timeline */}
      <div className="flex-1 flex flex-col" style={{ overflow: 'visible' }}>

        {/* Bar area */}
        <div
          ref={barRef}
          className="relative h-11 bg-zinc-900 rounded cursor-ew-resize select-none"
          style={{ overflow: 'visible', touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          {/* Segment blocks */}
          {pixelsPerSec > 0 && segments.map(seg => {
            const x1 = timeToX(new Date(seg.startTime).getTime(), barWidth, viewCenterMs, pixelsPerSec)
            const x2 = timeToX(new Date(seg.endTime).getTime(),   barWidth, viewCenterMs, pixelsPerSec)
            if (x2 < 0 || x1 > barWidth) return null
            return (
              <div
                key={seg.id}
                className={`absolute top-0 h-full ${seg.motion ? 'bg-amber-600/70' : 'bg-sky-700/60'}`}
                style={{
                  left:  Math.max(0, x1),
                  width: Math.max(2, Math.min(barWidth, x2) - Math.max(0, x1)), // min 2px so tiny segments are visible
                }}
              />
            )
          })}

          {/* Center needle — always visible; white in playback, faint in live */}
          <div
            className={`absolute top-0 h-full w-px pointer-events-none z-20 transition-colors ${
              isLive ? 'bg-white/20' : 'bg-white/90'
            }`}
            style={{ left: '50%' }}
          />
          {!isLive && (
            <div className="absolute w-2 h-2 bg-white rounded-full pointer-events-none z-20"
                 style={{ left: 'calc(50% - 4px)', top: -4 }} />
          )}

          {/* Live edge indicator */}
          {isLive && pixelsPerSec > 0 && (() => {
            const liveX = timeToX(Date.now(), barWidth, viewCenterMs, pixelsPerSec)
            if (liveX < 0 || liveX > barWidth) return null
            return (
              <div className="absolute top-0 h-full pointer-events-none z-20"
                   style={{ left: liveX }}>
                <div className="absolute top-0 h-full w-0.5 bg-red-500/80" />
                <div className="absolute -top-1 -left-1 w-2 h-2 bg-red-500 rounded-full" />
              </div>
            )
          })()}

          {/* Scrub time label above center needle */}
          {interacting && (
            <div className="absolute bottom-full mb-2 z-50 pointer-events-none"
                 style={{ left: '50%', transform: 'translateX(-50%)' }}>
              <div className="bg-zinc-900/90 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200 shadow whitespace-nowrap">
                {formatTime(viewCenterMs)}
              </div>
            </div>
          )}
        </div>

        {/* Dynamic time labels */}
        <div className="relative h-5 overflow-hidden">
          {getVisibleLabels(viewCenterMs, pixelsPerSec, barWidth, date).map(({ ms, x, label }) => (
            <span
              key={ms}
              className="absolute text-[10px] text-zinc-500 -translate-x-1/2 whitespace-nowrap"
              style={{ left: x }}
            >
              {label}
            </span>
          ))}
        </div>

        {/* Hidden sprite pre-fetchers */}
        <div style={{ display: 'none' }} aria-hidden>
          {nearbySegments.filter(s => s.hasSprite).map(s => (
            <img key={s.id} src={s.spriteUrl} />
          ))}
        </div>
      </div>

      {/* Live button */}
      <button
        onClick={onLive}
        className={`shrink-0 px-3 py-1.5 rounded text-[11px] font-semibold uppercase tracking-wider border transition-colors ${
          isLive
            ? 'bg-red-950/60 text-red-400 border-red-900/50 cursor-default'
            : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:border-sky-600 hover:text-sky-400'
        }`}
      >
        {isLive ? '● Live' : 'Go Live'}
      </button>
    </div>
  )
}
