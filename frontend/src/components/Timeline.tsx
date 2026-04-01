import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RecordingSegment } from '../lib/types'

interface TimelineProps {
  segments: RecordingSegment[]
  minMs: number              // left clamp bound (oldest available timestamp)
  maxMs: number              // right clamp bound (live edge / now)
  jumpToMs?: number          // when changed, snaps the view center to this timestamp
  currentTime: Date | null   // current playback position; null when live
  onSeek: (time: Date) => void
  onScrubChange: (scrubbing: boolean, segment: RecordingSegment | null, frameIndex: number, timeMs: number) => void
  onViewCenterChange?: (ms: number) => void  // fires each RAF with current needle time
  isLive: boolean
  headerContent?: React.ReactNode  // rendered above the bar, same width as bar
  className?: string
}

// ── Coordinate helpers ──────────────────────────────────────────────────────

function timeToX(tMs: number, barWidth: number, centerMs: number, pps: number): number {
  return barWidth / 2 + ((tMs - centerMs) / 1000) * pps
}

function xToTime(x: number, barWidth: number, centerMs: number, pps: number): number {
  return centerMs + ((x - barWidth / 2) / pps) * 1000
}

function clampPixelsPerSec(pps: number, barWidth: number, totalRangeSec: number): number {
  const minPps = barWidth / Math.max(totalRangeSec, 3600) // full range fits
  const maxPps = barWidth / 120                           // 2 minutes fills the bar
  return Math.max(minPps, Math.min(maxPps, pps))
}

function clampCenter(centerMs: number, minMs: number, maxMs: number): number {
  return Math.max(minMs, Math.min(maxMs, centerMs))
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
  minMs: number,
  maxMs: number,
): Array<{ ms: number; x: number; label: string; isDate: boolean }> {
  if (pixelsPerSec === 0) return []
  const intervalSec = getLabelIntervalSec(pixelsPerSec)
  const intervalMs = intervalSec * 1000
  const firstMs = Math.ceil(minMs / intervalMs) * intervalMs
  const result = []
  for (let ms = firstMs; ms <= maxMs; ms += intervalMs) {
    const x = timeToX(ms, barWidth, centerMs, pixelsPerSec)
    if (x < -40 || x > barWidth + 40) continue
    const dt = new Date(ms)
    const h = dt.getHours()
    const m = dt.getMinutes()
    const isDate = h === 0 && m === 0
    const label = isDate
      ? dt.toLocaleDateString([], { month: 'short', day: 'numeric' })
      : dt.getHours().toString().padStart(2, '0') + ':' + dt.getMinutes().toString().padStart(2, '0')
    result.push({ ms, x, label, isDate })
  }
  return result
}

// ── Component ───────────────────────────────────────────────────────────────

export default function Timeline({
  segments,
  minMs,
  maxMs,
  jumpToMs,
  currentTime,
  onSeek,
  onScrubChange,
  onViewCenterChange,
  isLive,
  headerContent,
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

  // Stable refs to props used inside RAF/event handlers (avoid stale closures)
  const minMsRef         = useRef(minMs)
  const maxMsRef         = useRef(maxMs)
  const segmentsRef      = useRef(segments)
  const onScrubChangeRef = useRef(onScrubChange)
  const onSeekRef        = useRef(onSeek)
  useEffect(() => { minMsRef.current = minMs }, [minMs])
  useEffect(() => { maxMsRef.current = maxMs }, [maxMs])
  useEffect(() => { segmentsRef.current = segments }, [segments])
  useEffect(() => { onScrubChangeRef.current = onScrubChange }, [onScrubChange])
  useEffect(() => { onSeekRef.current = onSeek }, [onSeek])

  const onViewCenterChangeRef = useRef(onViewCenterChange)
  useEffect(() => { onViewCenterChangeRef.current = onViewCenterChange }, [onViewCenterChange])

  const isLiveRef = useRef(isLive)
  useEffect(() => { isLiveRef.current = isLive }, [isLive])

  // State — synced from refs via RAF flush
  const [viewCenterMs, setViewCenterMs] = useState<number>(Date.now())
  const [pixelsPerSec, setPixelsPerSec] = useState<number>(0)
  const [, setInteracting]   = useState(false)

  const barRef = useRef<HTMLDivElement>(null)

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
      onViewCenterChangeRef.current?.(centerMs)

      // Only notify parent when scrub state actually changes, not on every live tick.
      if (isInteracting !== wasInteractingRef.current || isInteracting) {
        wasInteractingRef.current = isInteracting
        onScrubChangeRef.current(isInteracting, scrubSeg, scrubFrame, centerMs)
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
      viewCenterMsRef.current = Date.now()
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

    // Entering live mode: clear the panned flag and snap live edge to center.
    userHasPannedRef.current = false
    viewCenterMsRef.current = Date.now()
    scheduleFlush()

    liveTickRef.current = setInterval(() => {
      // Don't override user's manually scrolled position.
      if (userInteractingRef.current || userHasPannedRef.current) return
      viewCenterMsRef.current = Date.now()
      scheduleFlush()
    }, 1000)
    return () => { if (liveTickRef.current) clearInterval(liveTickRef.current) }
  }, [isLive])

  // ── Jump to timestamp (e.g. date picker) ─────────────────────────────────

  useEffect(() => {
    if (jumpToMs === undefined) return
    viewCenterMsRef.current = clampCenter(jumpToMs, minMsRef.current, maxMsRef.current)
    // In live mode, mark as panned so the live tick doesn't snap back.
    // In playback mode, leave it clear so auto-scroll can follow currentTime.
    userHasPannedRef.current = isLiveRef.current
    scheduleFlush()
  }, [jumpToMs])

  // ── Auto-scroll during playback ──────────────────────────────────────────

  useEffect(() => {
    if (isLive || !currentTime || userInteractingRef.current || userHasPannedRef.current) return
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
      const minMs    = minMsRef.current
      const maxMs    = maxMsRef.current
      const totalRangeSec = (maxMs - minMs) / 1000

      if (e.shiftKey) {
        const delta      = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
        const zoomFactor = Math.pow(1.002, delta)
        const newPps     = clampPixelsPerSec(pixelsPerSecRef.current * zoomFactor, barWidth, totalRangeSec)
        const mouseTimeMs = xToTime(mouseX, barWidth, viewCenterMsRef.current, pixelsPerSecRef.current)
        pixelsPerSecRef.current = newPps
        viewCenterMsRef.current = clampCenter(
          mouseTimeMs - ((mouseX - barWidth / 2) / newPps) * 1000,
          minMs, maxMs,
        )
      } else {
        const delta    = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY
        const deltaSec = delta / pixelsPerSecRef.current
        viewCenterMsRef.current = clampCenter(
          viewCenterMsRef.current + deltaSec * 1000,
          minMs, maxMs,
        )
      }

      scheduleFlush()

      interactTimerRef.current = setTimeout(() => {
        userInteractingRef.current = false
        if (!isLiveRef.current) userHasPannedRef.current = false
        scheduleFlush()
        onSeekRef.current(new Date(viewCenterMsRef.current))
      }, 500)
    }

    bar.addEventListener('wheel', onWheel, { passive: false })
    return () => bar.removeEventListener('wheel', onWheel)
  }, []) // stable — reads minMs/maxMs from refs

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
      minMs, maxMs,
    )
    scheduleFlush()
  }

  function handlePointerUp(_e: React.PointerEvent<HTMLDivElement>) {
    if (!userInteractingRef.current) return
    lastPointerXRef.current = null
    if (interactTimerRef.current) clearTimeout(interactTimerRef.current)
    userInteractingRef.current = false
    // In playback mode, clear the panned flag so auto-scroll resumes following
    // currentTime after the seek. In live mode, keep it set so the live tick
    // doesn't snap the view back while the user is exploring.
    if (!isLiveRef.current) userHasPannedRef.current = false
    scheduleFlush()
    onSeek(new Date(viewCenterMsRef.current))
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
    <div className={`px-3 pb-3 pt-1 ${className ?? ''}`}>
      {/* Timeline */}
      <div className="flex flex-col" style={{ overflow: 'visible' }}>

        {/* Header slot — same width as bar, rendered above it */}
        {headerContent}

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
                  width: Math.max(2, Math.min(barWidth, x2) - Math.max(0, x1)),
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
          {pixelsPerSec > 0 && (() => {
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

        </div>

        {/* Dynamic time labels */}
        <div className="relative h-5 overflow-hidden">
          {getVisibleLabels(viewCenterMs, pixelsPerSec, barWidth, minMs, maxMs).map(({ ms, x, label, isDate }) => (
            <span
              key={ms}
              className={`absolute -translate-x-1/2 whitespace-nowrap ${
                isDate
                  ? 'text-xs text-zinc-200 font-medium'
                  : 'text-xs text-zinc-400'
              }`}
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
    </div>
  )
}
