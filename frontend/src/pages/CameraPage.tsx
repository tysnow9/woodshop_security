import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Settings, Volume2, VolumeX, Maximize2, Minimize2, VideoOff, Rewind, FastForward, Play, Pause, HelpCircle } from 'lucide-react'
import { api, hlsUrl } from '../lib/api'
import type { Camera, RecordingSegment } from '../lib/types'
import HlsPlayer, { type HlsPlayerHandle } from '../components/HlsPlayer'
import Timeline from '../components/Timeline'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'

type Mode = 'live' | 'playback'

function localDateStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function CameraPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [camera, setCamera] = useState<Camera | null>(null)
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem('nvr_muted') !== 'false' } catch { return true }
  })
  const playerRef    = useRef<HlsPlayerHandle>(null)
  const videoAreaRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fullscreenSupported = !!(document.fullscreenEnabled)

  // Playback state
  const [mode, setMode]                   = useState<Mode>('live')
  const [selectedDate, setSelectedDate]   = useState<string>(() => localDateStr())
  const [playbackReady, setPlaybackReady] = useState(false)
  const [allSegments, setAllSegments]     = useState<RecordingSegment[]>([])
  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [jumpToMs, setJumpToMs]           = useState<number | undefined>(undefined)
  const [currentSegment, setCurrentSegment] = useState<RecordingSegment | null>(null)
  const [seekOffset, setSeekOffset]       = useState(0)
  const [playbackTime, setPlaybackTime]   = useState<Date | null>(null)
  const [playbackRate, setPlaybackRate]   = useState(1)

  // Scrub thumbnail state — updated by Timeline's onScrubChange each RAF tick
  const [scrubbing, setScrubbing]             = useState(false)
  const [scrubSegment, setScrubSegment]       = useState<RecordingSegment | null>(null)
  const [scrubFrameIndex, setScrubFrameIndex] = useState(0)
  const [scrubTimeMs, setScrubTimeMs]         = useState(0)

  // Timeline needle time — broadcast from Timeline via onViewCenterChange
  const [timelineCenterMs, setTimelineCenterMs] = useState(() => Date.now())
  const [editingTime, setEditingTime]            = useState(false)
  const [timeInput, setTimeInput]                = useState('')
  const timeInputRef                             = useRef<HTMLInputElement>(null)

  const playbackVideoRef = useRef<HTMLVideoElement>(null)
  const preloadRef       = useRef<HTMLVideoElement | null>(null)

  // Playback controls state
  const [isPaused,      setIsPaused]      = useState(true)
  const [isReversing,   setIsReversing]   = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const reverseIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const holdPlayingRef      = useRef<'forward' | 'reverse' | null>(null)
  // Refs for stale-closure–safe access inside intervals/effects
  const playbackTimeRef     = useRef<Date | null>(null)   // kept in sync with playbackTime
  const currentSegmentRef   = useRef<RecordingSegment | null>(null)
  const allSegmentsRef      = useRef<RecordingSegment[]>([])
  const pendingReverseRef   = useRef(false)               // true = resume reversing after load

  // ── Fullscreen ────────────────────────────────────────────────────────────

  useEffect(() => {
    function onFsc() { setIsFullscreen(!!document.fullscreenElement) }
    document.addEventListener('fullscreenchange', onFsc)
    return () => document.removeEventListener('fullscreenchange', onFsc)
  }, [])

  useEffect(() => { playbackTimeRef.current   = playbackTime   }, [playbackTime])
  useEffect(() => { currentSegmentRef.current = currentSegment }, [currentSegment])
  useEffect(() => { allSegmentsRef.current    = allSegments    }, [allSegments])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      videoAreaRef.current?.requestFullscreen()
    }
  }

  // ── Camera load ───────────────────────────────────────────────────────────

  useEffect(() => {
    api.cameras.list().then((cams) => {
      setCamera(cams.find((c) => c.id === id) ?? null)
    }).catch(() => {
      setCamera(null)
    })
  }, [id])

  // ── Recordings effects ────────────────────────────────────────────────────

  // Load all available dates' segments once on camera mount.
  useEffect(() => {
    if (!camera) return
    api.recordings.listDates(camera.id).then(r => {
      setAvailableDates(r.dates)
      if (r.dates.length === 0) return
      // Default selected date to most recent if today has no recordings.
      const today = localDateStr()
      if (!r.dates.includes(today)) {
        setSelectedDate(r.dates[0])
      }
      // Fetch segments for every date in parallel.
      return Promise.all(r.dates.map(d =>
        api.recordings.listByDate(camera.id, d)
          .then(res => res.segments)
          .catch(() => [] as RecordingSegment[])
      ))
    }).then(results => {
      if (!results) return
      const sorted = results.flat().sort((a, b) =>
        a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
      )
      setAllSegments(sorted)
    }).catch(() => {})
  }, [camera])

  // Poll every 60s to pick up new segments recorded today.
  useEffect(() => {
    if (!camera) return
    const interval = setInterval(() => {
      const today = localDateStr()
      api.recordings.listByDate(camera.id, today)
        .then(r => {
          if (r.segments.length > 0) {
            setAvailableDates(dates => dates.includes(today) ? dates : [today, ...dates])
          }
          setAllSegments(prev => {
            const existing = new Set(prev.map(s => s.id))
            const newSegs = r.segments.filter(s => !existing.has(s.id))
            if (newSegs.length === 0) return prev
            return [...prev, ...newSegs].sort((a, b) =>
              a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0
            )
          })
        })
        .catch(() => {})
    }, 60_000)
    return () => clearInterval(interval)
  }, [camera])

  // Pause/resume HLS and sync mute based on mode.
  // During playback the HLS player is opacity-0 but still decoding — pause it
  // to eliminate the CPU/GPU contention that causes choppy playback.
  useEffect(() => {
    if (mode === 'playback') {
      playerRef.current?.pause()
      playerRef.current?.setMuted(true)
    } else {
      playerRef.current?.resume()
      playerRef.current?.setMuted(muted)
      setIsReversing(false)
    }
  }, [mode])

  // Load playback video when segment/offset changes
  useEffect(() => {
    if (mode !== 'playback' || !currentSegment || !playbackVideoRef.current) return
    const video = playbackVideoRef.current
    const targetOffset = seekOffset
    setPlaybackReady(false)

    function onCanPlay() {
      video.currentTime = targetOffset
      video.playbackRate = playbackRate
      setPlaybackReady(true)
      if (pendingReverseRef.current) {
        // Segment loaded for a reverse-boundary transition — resume reversing.
        pendingReverseRef.current = false
        setIsReversing(true)
      } else {
        video.play().catch(() => {})
      }
      cleanup()
    }
    // If canplay never fires (e.g. corrupt file), show whatever the video
    // element has after 5 seconds rather than spinning indefinitely.
    const timeoutId = setTimeout(() => { setPlaybackReady(true); cleanup() }, 5000)
    function cleanup() {
      video.removeEventListener('canplay', onCanPlay)
      clearTimeout(timeoutId)
    }

    video.src = currentSegment.videoUrl
    video.load()
    video.addEventListener('canplay', onCanPlay)
    return () => cleanup()
  }, [currentSegment, seekOffset, mode])

  // Sync playbackRate to video element
  useEffect(() => {
    if (playbackVideoRef.current && mode === 'playback') {
      playbackVideoRef.current.playbackRate = playbackRate
    }
  }, [playbackRate, mode])

  // Track playback time for timeline auto-scroll
  useEffect(() => {
    if (mode !== 'playback' || !playbackVideoRef.current) return
    const video = playbackVideoRef.current
    function onTimeUpdate() {
      if (!currentSegment) return
      setPlaybackTime(new Date(new Date(currentSegment.startTime).getTime() + video.currentTime * 1000))
    }
    video.addEventListener('timeupdate', onTimeUpdate)
    return () => video.removeEventListener('timeupdate', onTimeUpdate)
  }, [mode, currentSegment])

  // Preload next segment + auto-advance on ended
  useEffect(() => {
    if (mode !== 'playback' || !currentSegment || !playbackVideoRef.current) return
    const video = playbackVideoRef.current
    const idx = allSegments.findIndex(s => s.id === currentSegment.id)

    function onTimeUpdate() {
      // Advance early when we reach the trimmed end of this segment.
      // Handles R clips whose EndTime was trimmed to the next M clip's StartTime:
      // the video file still contains the original (longer) recording, but we
      // cut away early so playback transitions cleanly without jumping backward.
      if (video.currentTime >= currentSegment!.durationSec - 0.1 && idx >= 0) {
        const next = allSegments[idx + 1]
        if (next) {
          setCurrentSegment(next)
          setSeekOffset(0)
          preloadRef.current = null
          return
        }
      }
      const remaining = currentSegment!.durationSec - video.currentTime
      if (remaining < 30 && !preloadRef.current && idx >= 0) {
        const next = allSegments[idx + 1]
        if (next) {
          const el = document.createElement('video')
          el.src = next.videoUrl
          el.preload = 'auto'
          preloadRef.current = el
        }
      }
    }
    function onEnded() {
      const next = idx >= 0 ? allSegments[idx + 1] : undefined
      if (next) {
        setCurrentSegment(next)
        setSeekOffset(0)
        preloadRef.current = null
      }
    }

    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('ended', onEnded)
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('ended', onEnded)
      preloadRef.current = null
    }
  }, [mode, currentSegment, allSegments])

  // Track play/pause state for the controls button icon
  useEffect(() => {
    const video = playbackVideoRef.current
    if (!video) return
    const onPlay  = () => setIsPaused(false)
    const onPause = () => setIsPaused(true)
    video.addEventListener('play',  onPlay)
    video.addEventListener('pause', onPause)
    return () => {
      video.removeEventListener('play',  onPlay)
      video.removeEventListener('pause', onPause)
    }
  }, [])

  // Reverse playback: step currentTime backwards on a fixed interval.
  // Each tick steps back (playbackRate × 0.2)s so reverse tracks the speed setting.
  // At the start of a segment, transitions to the previous segment's end.
  useEffect(() => {
    if (reverseIntervalRef.current) {
      clearInterval(reverseIntervalRef.current)
      reverseIntervalRef.current = null
    }
    if (!isReversing || mode !== 'playback') return
    const video = playbackVideoRef.current
    if (!video) return
    video.pause()
    const stepSec = Math.max(playbackRate, 1) * 0.2
    reverseIntervalRef.current = setInterval(() => {
      const v = playbackVideoRef.current
      if (!v) return
      if (v.currentTime <= stepSec) {
        // Reached start — jump to end of previous segment and keep reversing.
        const seg  = currentSegmentRef.current
        const segs = allSegmentsRef.current
        const idx  = seg ? segs.findIndex(s => s.id === seg.id) : -1
        const prev = idx > 0 ? segs[idx - 1] : null
        if (prev) {
          pendingReverseRef.current = true
          setIsReversing(false)           // stops this interval; load effect will restart it
          setCurrentSegment(prev)
          setSeekOffset(prev.durationSec)
        } else {
          v.currentTime = 0
          setIsReversing(false)
        }
      } else {
        v.currentTime -= stepSec
      }
    }, 200)
    return () => {
      if (reverseIntervalRef.current) {
        clearInterval(reverseIntervalRef.current)
        reverseIntervalRef.current = null
      }
    }
  }, [isReversing, mode, playbackRate])

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          if (mode === 'playback') {
            if (isReversing) {
              setIsReversing(false)
              playbackVideoRef.current?.play().catch(() => {})
            } else if (playbackVideoRef.current?.paused) {
              playbackVideoRef.current.play().catch(() => {})
            } else {
              playbackVideoRef.current?.pause()
            }
          }
          break
        case 'l': case 'L':
          if (mode === 'playback') setPlaybackRate(r => Math.min(r * 2 || 2, 8))
          break
        case 'j': case 'J':
          if (mode === 'playback' && playbackVideoRef.current) {
            playbackVideoRef.current.currentTime = Math.max(0, playbackVideoRef.current.currentTime - 10)
          }
          break
        case 'k': case 'K':
          if (mode === 'playback') setPlaybackRate(1)
          break
        case 'ArrowRight': {
          e.preventDefault()
          if (mode !== 'playback' || !playbackVideoRef.current) break
          const video = playbackVideoRef.current
          if (e.shiftKey) {
            // Snap to next motion clip midpoint.
            // Use playbackTimeRef (set synchronously by handleSeek) so rapid presses
            // work correctly even when video.currentTime hasn't seeked yet.
            const currentMs = playbackTimeRef.current?.getTime()
              ?? (currentSegment ? new Date(currentSegment.startTime).getTime() : 0)
            const next = allSegments.find(s => {
              if (!s.motion) return false
              const mid = (new Date(s.startTime).getTime() + new Date(s.endTime).getTime()) / 2
              return mid > currentMs
            })
            if (next) {
              const mid = (new Date(next.startTime).getTime() + new Date(next.endTime).getTime()) / 2
              handleSeek(new Date(mid))
              setJumpToMs(mid)
            }
          } else if (e.repeat) {
            // Hold: play forward
            if (!holdPlayingRef.current) {
              holdPlayingRef.current = 'forward'
              setIsReversing(false)
              video.play().catch(() => {})
            }
          } else {
            // Tap: step 1 frame forward (camera is 20fps)
            setIsReversing(false)
            video.currentTime = Math.min(
              video.currentTime + 1 / 20,
              currentSegment ? currentSegment.durationSec : video.duration,
            )
          }
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          if (mode !== 'playback' || !playbackVideoRef.current) break
          const video = playbackVideoRef.current
          if (e.shiftKey) {
            // Snap to previous motion clip midpoint.
            // Use playbackTimeRef (set synchronously by handleSeek) so rapid presses
            // work correctly even when video.currentTime hasn't seeked yet.
            const currentMs = playbackTimeRef.current?.getTime()
              ?? (currentSegment ? new Date(currentSegment.startTime).getTime() : 0)
            const prev = [...allSegments].reverse().find(s => {
              if (!s.motion) return false
              if (s.id === currentSegment?.id) return false  // already here — skip to the one before
              const mid = (new Date(s.startTime).getTime() + new Date(s.endTime).getTime()) / 2
              return mid < currentMs
            })
            if (prev) {
              const mid = (new Date(prev.startTime).getTime() + new Date(prev.endTime).getTime()) / 2
              handleSeek(new Date(mid))
              setJumpToMs(mid)
            }
          } else if (e.repeat) {
            // Hold: play in reverse
            if (!holdPlayingRef.current) {
              holdPlayingRef.current = 'reverse'
              video.pause()
              setIsReversing(true)
            }
          } else {
            // Tap: step 1 frame backward
            setIsReversing(false)
            video.currentTime = Math.max(0, video.currentTime - 1 / 20)
          }
          break
        }
        case 'Home':
          if (allSegments.length > 0) { setCurrentSegment(allSegments[0]); setSeekOffset(0); setMode('playback') }
          break
        case 'End':
          handleGoLive()
          break
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (mode !== 'playback') return
      if (e.key === 'ArrowRight' && holdPlayingRef.current === 'forward') {
        holdPlayingRef.current = null
        playbackVideoRef.current?.pause()
      } else if (e.key === 'ArrowLeft' && holdPlayingRef.current === 'reverse') {
        holdPlayingRef.current = null
        setIsReversing(false)
      }
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [mode, currentSegment, allSegments, isReversing])

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleSeek(time: Date) {
    setIsReversing(false)
    if (allSegments.length === 0) return
    const tMs = time.getTime()

    // Try exact match first (needle is inside a recorded segment).
    let seg = allSegments.find(s =>
      new Date(s.startTime).getTime() <= tMs &&
      new Date(s.endTime).getTime()   >= tMs
    )

    // Fall back to nearest segment — but only if within 30 seconds.
    // A larger gap means the user is pointing at a genuine recording gap;
    // entering playback with no segment shows "No recording" instead of
    // jumping to a random segment far away.
    if (!seg) {
      const nearest = allSegments.reduce((best, s) => {
        const d    = Math.abs(new Date(s.startTime).getTime() - tMs)
        const dBest = Math.abs(new Date(best.startTime).getTime() - tMs)
        return d < dBest ? s : best
      })
      const nearestDistMs = Math.min(
        Math.abs(new Date(nearest.startTime).getTime() - tMs),
        Math.abs(new Date(nearest.endTime).getTime() - tMs),
      )
      if (nearestDistMs <= 30_000) seg = nearest
    }

    if (!seg) {
      // Genuine gap — enter playback mode but show "No recording" overlay.
      setCurrentSegment(null)
      setMode('playback')
      setPlaybackTime(time)
      setPlaybackRate(1)
      setPlaybackReady(false)
      return
    }

    const segStartMs = new Date(seg.startTime).getTime()
    const offset = Math.max(0, Math.min((tMs - segStartMs) / 1000, seg.durationSec))
    setCurrentSegment(seg)
    setSeekOffset(offset)
    setMode('playback')
    setPlaybackTime(time)
    playbackTimeRef.current = time  // sync for keyboard handler rapid presses
    setPlaybackRate(1)
  }

  function handleGoLive() {
    setIsReversing(false)
    pendingReverseRef.current = false
    setMode('live')
    setCurrentSegment(null)
    setPlaybackTime(null)
    playbackTimeRef.current = null
    setPlaybackRate(1)
    setPlaybackReady(false)
    preloadRef.current = null
  }

  function handleScrubChange(
    isScrubbing: boolean,
    seg: RecordingSegment | null,
    frameIndex: number,
    timeMs: number,
  ) {
    setScrubbing(isScrubbing)
    setScrubSegment(seg)
    setScrubFrameIndex(frameIndex)
    setScrubTimeMs(timeMs)
  }

  function handleBackward() {
    if (mode !== 'playback') return
    if (isReversing) {
      setIsReversing(false)
      playbackVideoRef.current?.pause()
    } else {
      setIsReversing(true)
    }
  }

  function handlePlayPause() {
    if (mode !== 'playback') return
    if (isReversing) {
      setIsReversing(false)
      playbackVideoRef.current?.play().catch(() => {})
    } else if (playbackVideoRef.current?.paused) {
      playbackVideoRef.current.play().catch(() => {})
    } else {
      playbackVideoRef.current?.pause()
    }
  }

  function handleForward() {
    if (mode !== 'playback') return
    setIsReversing(false)
    playbackVideoRef.current?.play().catch(() => {})
  }

  function toggleMute() {
    const newMuted = !muted
    if (mode === 'live') {
      playerRef.current?.setMuted(newMuted)
    } else if (playbackVideoRef.current) {
      playbackVideoRef.current.muted = newMuted
    }
    setMuted(newMuted)
    try { localStorage.setItem('nvr_muted', String(newMuted)) } catch {}
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!camera) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        Camera not found.
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 3.5rem)' }}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <span className="text-sm font-medium text-zinc-100">{camera.name}</span>

          <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border ${
            mode === 'live'
              ? 'bg-red-950/60 text-red-400 border-red-900/50'
              : 'bg-sky-950/60 text-sky-400 border-sky-900/50'
          }`}>
            {mode === 'live' ? '● Live' : '▶ Playback'}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => window.open(`http://${camera.ip}`, '_blank', 'noopener,noreferrer')}
            title="Open Amcrest web UI"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <Settings size={13} />
            Camera Settings
          </button>

          <button
            onClick={toggleMute}
            title={muted ? 'Enable audio' : 'Mute'}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
          >
            {muted
              ? <><VolumeX size={14} /><span>Unmute</span></>
              : <><Volume2 size={14} /><span>Mute</span></>
            }
          </button>

          {fullscreenSupported && (
            <button
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              <span>{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Video area + timeline */}
      <div ref={videoAreaRef} className="flex-1 flex flex-col min-h-0 overflow-hidden">

        {/* Layered video area */}
        <TransformWrapper minScale={1} maxScale={8} limitToBounds={true}>
        <TransformComponent
          wrapperStyle={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }}
          contentStyle={{ width: '100%', height: '100%', position: 'relative', background: 'black' }}
        >
        <div className="absolute inset-0">
          {/* Live HLS stream — hidden immediately when user seeks into playback.
              Kept mounted so switching back to live is instant (no rebuffering). */}
          <div className={`absolute inset-0 transition-opacity duration-200 ${
            mode === 'live' ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}>
            <HlsPlayer
              ref={playerRef}
              src={hlsUrl(camera.id, 'main')}
              startMuted={muted}
              objectFit="contain"
              className="w-full h-full"
              onMuteBlocked={() => setMuted(true)}
            />
          </div>

          {/* Playback video — shown once canplay fires; opacity:0 while scrubbing
              keeps the last decoded frame visible so the sprite overlay has context. */}
          <video
            ref={playbackVideoRef}
            playsInline
            muted={muted}
            className="absolute inset-0 w-full h-full object-contain transition-opacity duration-200"
            style={{ opacity: mode === 'playback' && playbackReady && !scrubbing ? 1 : 0 }}
          />

          {/* Loading indicator while playback video is buffering */}
          {mode === 'playback' && !playbackReady && !scrubbing && currentSegment && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-8 h-8 border-2 border-zinc-600 border-t-sky-400 rounded-full animate-spin" />
            </div>
          )}

          {/* Gap overlay — shown while scrubbing in a gap OR stopped in a gap */}
          {((scrubbing && !scrubSegment) || (!scrubbing && mode === 'playback' && !currentSegment)) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-30 bg-black/60">
              <VideoOff size={36} className="text-zinc-600" />
              <span className="text-xs text-zinc-500 mt-2">No recording</span>
            </div>
          )}

          {/* Sprite thumbnail overlay — shown while scrubbing over a segment */}
          {scrubbing && scrubSegment?.hasSprite && (
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
                         rounded overflow-hidden border border-zinc-600 shadow-2xl z-30"
            >
              <div style={{
                width: 320, height: 180,
                backgroundImage: `url(${scrubSegment.spriteUrl})`,
                backgroundPosition: `-${scrubFrameIndex * 320}px 0px`,
                backgroundRepeat: 'no-repeat',
                backgroundSize: 'auto 180px',
              }} />
              <div className="bg-zinc-900 text-[11px] text-zinc-300 text-center py-0.5 px-1">
                {new Date(scrubTimeMs).toLocaleTimeString([], {
                  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                })}
                {scrubSegment.motion && <span className="ml-1.5 text-amber-400">Motion</span>}
              </div>
            </div>
          )}
        </div>
        </TransformComponent>
        </TransformWrapper>

        {/* Timeline — controls are rendered as headerContent above the bar,
            scoped to bar width so the time field aligns exactly with the needle */}
        <div className="shrink-0 border-t border-zinc-800">
          <Timeline
            segments={allSegments}
            minMs={allSegments.length > 0
              ? new Date(allSegments[0].startTime).getTime()
              : Date.now() - 24 * 3600 * 1000}
            maxMs={Date.now()}
            jumpToMs={jumpToMs}
            currentTime={playbackTime}
            onSeek={handleSeek}
            onScrubChange={handleScrubChange}
            onViewCenterChange={setTimelineCenterMs}
            isLive={mode === 'live'}
            headerContent={
              <div className="flex items-center py-1 mb-0.5">
                {/* Left: date picker + playback controls, right-aligned */}
                <div className="flex-1 flex items-center gap-2 justify-end pr-3">
                  <select
                    value={selectedDate}
                    onChange={e => {
                      const d = e.target.value
                      if (!d) return
                      setSelectedDate(d)
                      const [y, mo, dd] = d.split('-').map(Number)
                      const targetMs = new Date(y, mo - 1, dd).getTime()
                      setJumpToMs(targetMs)
                      if (mode === 'playback') {
                        const dayStartMs = new Date(y, mo - 1, dd, 0, 0, 0).getTime()
                        const dayEndMs   = new Date(y, mo - 1, dd, 23, 59, 59).getTime()
                        const daySeg = allSegments.find(s => {
                          const t = new Date(s.startTime).getTime()
                          return t >= dayStartMs && t <= dayEndMs
                        })
                        if (daySeg) handleSeek(new Date(daySeg.startTime))
                      }
                    }}
                    className="bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-500 px-2 py-1 focus:outline-none focus:border-zinc-600"
                  >
                    {availableDates.map(d => {
                      const dt = new Date(d + 'T12:00:00')
                      return (
                        <option key={d} value={d}>
                          {dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
                        </option>
                      )
                    })}
                  </select>

                  {/* Playback controls */}
                  <div className="flex items-center gap-1">
                    {/* Backward */}
                    <button
                      onClick={handleBackward}
                      disabled={mode === 'live'}
                      title="Play reverse (click again to pause)"
                      className={`px-2 py-1 rounded text-xs border transition-colors ${
                        mode === 'live'
                          ? 'bg-zinc-900/40 text-zinc-700 border-zinc-800/50 cursor-default'
                          : isReversing
                            ? 'bg-sky-900/60 text-sky-300 border-sky-700'
                            : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
                      }`}
                    >
                      <Rewind size={12} />
                    </button>

                    {/* Play / Pause */}
                    <button
                      onClick={handlePlayPause}
                      disabled={mode === 'live'}
                      title={isPaused || isReversing ? 'Play' : 'Pause'}
                      className={`px-2 py-1 rounded text-xs border transition-colors ${
                        mode === 'live'
                          ? 'bg-zinc-900/40 text-zinc-700 border-zinc-800/50 cursor-default'
                          : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
                      }`}
                    >
                      {isPaused || isReversing ? <Play size={12} /> : <Pause size={12} />}
                    </button>

                    {/* Forward */}
                    <button
                      onClick={handleForward}
                      disabled={mode === 'live'}
                      title="Play forward"
                      className={`px-2 py-1 rounded text-xs border transition-colors ${
                        mode === 'live'
                          ? 'bg-zinc-900/40 text-zinc-700 border-zinc-800/50 cursor-default'
                          : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
                      }`}
                    >
                      <FastForward size={12} />
                    </button>

                    {/* Keyboard shortcuts */}
                    <div className="relative">
                      <button
                        onClick={() => setShowShortcuts(s => !s)}
                        title="Keyboard shortcuts"
                        className={`px-2 py-1 rounded text-xs border transition-colors ${
                          showShortcuts
                            ? 'bg-zinc-800 text-zinc-300 border-zinc-600'
                            : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
                        }`}
                      >
                        <HelpCircle size={12} />
                      </button>
                      {showShortcuts && (
                        <div className="absolute bottom-full right-0 mb-1 w-56 bg-zinc-900 border border-zinc-700 rounded shadow-xl p-2 z-50 text-[11px] text-zinc-400">
                          <table className="w-full">
                            <tbody>
                              {([
                                ['Space', 'Play / pause'],
                                ['J', '−10 seconds'],
                                ['K', 'Reset speed to 1×'],
                                ['L', 'Speed up'],
                                ['← →', 'Step frame / hold to play'],
                                ['⇧← ⇧→', 'Prev / next motion clip'],
                                ['Home', 'First recording'],
                                ['End', 'Go live'],
                              ] as [string, string][]).map(([key, desc]) => (
                                <tr key={key}>
                                  <td className="pr-3 py-0.5 text-zinc-300 font-mono whitespace-nowrap">{key}</td>
                                  <td className="py-0.5">{desc}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Center: time display — aligns with needle at 50% of bar */}
                {editingTime ? (
                  <input
                    ref={timeInputRef}
                    className="bg-zinc-800 border border-sky-600 rounded px-2 py-1 text-xs text-zinc-100 w-24 text-center outline-none shrink-0"
                    value={timeInput}
                    placeholder="HH:MM:SS"
                    onChange={e => setTimeInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        const parts = timeInput.split(':').map(Number)
                        if (parts.length >= 2 && !parts.some(isNaN)) {
                          const base = new Date(timelineCenterMs)
                          const seekDate = new Date(
                            base.getFullYear(), base.getMonth(), base.getDate(),
                            parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0,
                          )
                          handleSeek(seekDate)
                          setJumpToMs(seekDate.getTime())
                        }
                        setEditingTime(false)
                      } else if (e.key === 'Escape') {
                        setEditingTime(false)
                      }
                    }}
                    onBlur={() => setEditingTime(false)}
                  />
                ) : (
                  <button
                    onClick={() => {
                      const t = new Date(timelineCenterMs)
                      setTimeInput(
                        `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`
                      )
                      setEditingTime(true)
                      setTimeout(() => timeInputRef.current?.select(), 0)
                    }}
                    className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-300 hover:border-zinc-600 hover:text-zinc-100 transition-colors w-24 text-center shrink-0"
                    title="Click to jump to a time"
                  >
                    {new Date(timelineCenterMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                  </button>
                )}

                {/* Right: playback speed + Go Live, left-aligned */}
                <div className="flex-1 flex items-center gap-1 pl-3">
                  {[0.5, 1, 2, 4, 8].map(rate => (
                    <button
                      key={rate}
                      onClick={() => { if (mode === 'playback') setPlaybackRate(rate) }}
                      disabled={mode === 'live'}
                      className={`px-2 py-1 rounded text-xs font-mono border transition-colors ${
                        mode === 'live'
                          ? 'bg-zinc-900/40 text-zinc-700 border-zinc-800/50 cursor-default'
                          : playbackRate === rate
                            ? 'bg-sky-900/60 text-sky-300 border-sky-700'
                            : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
                      }`}
                    >
                      {rate}×
                    </button>
                  ))}
                  <button
                    onClick={handleGoLive}
                    disabled={mode === 'live'}
                    className={`ml-2 px-2 py-1 rounded text-xs font-semibold border transition-colors ${
                      mode === 'live'
                        ? 'bg-red-950/60 text-red-400 border-red-900/50 cursor-default'
                        : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:border-sky-600 hover:text-sky-400'
                    }`}
                  >
                    {mode === 'live' ? '● Live' : 'Go Live'}
                  </button>
                </div>
              </div>
            }
          />
        </div>
      </div>
    </div>
  )
}
