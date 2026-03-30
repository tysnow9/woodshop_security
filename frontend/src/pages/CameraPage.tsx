import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Settings, Volume2, VolumeX, Maximize2, Minimize2 } from 'lucide-react'
import { api, hlsUrl } from '../lib/api'
import type { Camera, RecordingSegment } from '../lib/types'
import HlsPlayer, { type HlsPlayerHandle } from '../components/HlsPlayer'
import Timeline from '../components/Timeline'

type Mode = 'live' | 'playback'

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
  const [selectedDate, setSelectedDate]   = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [segments, setSegments]           = useState<RecordingSegment[]>([])
  const [currentSegment, setCurrentSegment] = useState<RecordingSegment | null>(null)
  const [seekOffset, setSeekOffset]       = useState(0)
  const [playbackTime, setPlaybackTime]   = useState<Date | null>(null)
  const [playbackRate, setPlaybackRate]   = useState(1)

  // Scrub thumbnail state — updated by Timeline's onScrubChange each RAF tick
  const [scrubbing, setScrubbing]             = useState(false)
  const [scrubSegment, setScrubSegment]       = useState<RecordingSegment | null>(null)
  const [scrubFrameIndex, setScrubFrameIndex] = useState(0)

  const playbackVideoRef = useRef<HTMLVideoElement>(null)
  const preloadRef       = useRef<HTMLVideoElement | null>(null)

  // ── Fullscreen ────────────────────────────────────────────────────────────

  useEffect(() => {
    function onFsc() { setIsFullscreen(!!document.fullscreenElement) }
    document.addEventListener('fullscreenchange', onFsc)
    return () => document.removeEventListener('fullscreenchange', onFsc)
  }, [])

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
      const fallback: Record<string, Camera> = {
        cam1: { id: 'cam1', name: 'SE-Driveway', ip: '11.200.0.101', status: 'online' },
        cam2: { id: 'cam2', name: 'NW-Front', ip: '11.200.0.102', status: 'online' },
      }
      setCamera(fallback[id] ?? null)
    })
  }, [id])

  // ── Recordings effects ────────────────────────────────────────────────────

  // On camera load, default to the most recent date that has recordings if
  // today has none yet (e.g. backend just started and hasn't indexed today's files).
  useEffect(() => {
    if (!camera) return
    const today = new Date().toISOString().slice(0, 10)
    api.recordings.listDates(camera.id).then(r => {
      if (r.dates.length > 0 && !r.dates.includes(today)) {
        setSelectedDate(r.dates[0])
      }
    }).catch(() => {})
  }, [camera])

  // Reset to live when date changes
  useEffect(() => {
    setMode('live')
    setCurrentSegment(null)
    setPlaybackTime(null)
    setSegments([])
  }, [selectedDate])

  // Load segments when date or camera changes
  useEffect(() => {
    if (!camera || !selectedDate) return
    api.recordings.listByDate(camera.id, selectedDate)
      .then(r => setSegments(r.segments))
      .catch(() => setSegments([]))
  }, [camera, selectedDate])

  // Poll for new segments every 60s when viewing today
  useEffect(() => {
    if (!camera) return
    const today = new Date().toISOString().slice(0, 10)
    if (selectedDate !== today) return
    const interval = setInterval(() => {
      api.recordings.listByDate(camera.id, selectedDate)
        .then(r => setSegments(r.segments))
        .catch(() => {})
    }, 60_000)
    return () => clearInterval(interval)
  }, [camera, selectedDate])

  // Load playback video when segment/offset changes
  useEffect(() => {
    if (mode !== 'playback' || !currentSegment || !playbackVideoRef.current) return
    const video = playbackVideoRef.current
    const targetOffset = seekOffset

    function onCanPlay() {
      video.currentTime = targetOffset
      video.playbackRate = playbackRate
      video.play().catch(() => {})
      video.removeEventListener('canplay', onCanPlay)
    }

    video.src = currentSegment.videoUrl
    video.load()
    video.addEventListener('canplay', onCanPlay)
    return () => video.removeEventListener('canplay', onCanPlay)
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
    const idx = segments.findIndex(s => s.id === currentSegment.id)

    function onTimeUpdate() {
      const remaining = currentSegment!.durationSec - video.currentTime
      if (remaining < 30 && !preloadRef.current && idx >= 0) {
        const next = segments[idx + 1]
        if (next) {
          const el = document.createElement('video')
          el.src = next.videoUrl
          el.preload = 'auto'
          preloadRef.current = el
        }
      }
    }
    function onEnded() {
      const next = idx >= 0 ? segments[idx + 1] : undefined
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
  }, [mode, currentSegment, segments])

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          if (mode === 'playback' && playbackVideoRef.current) {
            playbackVideoRef.current.paused
              ? playbackVideoRef.current.play().catch(() => {})
              : playbackVideoRef.current.pause()
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
        case 'ArrowRight':
          if (mode === 'playback' && currentSegment) {
            const idx = segments.findIndex(s => s.id === currentSegment.id)
            const next = segments[idx + 1]
            if (next) { setCurrentSegment(next); setSeekOffset(0) }
          }
          break
        case 'ArrowLeft':
          if (mode === 'playback' && currentSegment) {
            const idx = segments.findIndex(s => s.id === currentSegment.id)
            const prev = segments[idx - 1]
            if (prev) { setCurrentSegment(prev); setSeekOffset(0) }
          }
          break
        case 'Home':
          if (segments.length > 0) { setCurrentSegment(segments[0]); setSeekOffset(0); setMode('playback') }
          break
        case 'End':
          handleGoLive()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, currentSegment, segments])

  // ── Handlers ──────────────────────────────────────────────────────────────

  function handleSeek(time: Date) {
    const seg = segments.find(s =>
      new Date(s.startTime).getTime() <= time.getTime() &&
      new Date(s.endTime).getTime()   >= time.getTime()
    )
    if (!seg) return
    const offset = (time.getTime() - new Date(seg.startTime).getTime()) / 1000
    setCurrentSegment(seg)
    setSeekOffset(offset)
    setMode('playback')
    setPlaybackTime(time)
    setPlaybackRate(1)
  }

  function handleGoLive() {
    setMode('live')
    setCurrentSegment(null)
    setPlaybackTime(null)
    setPlaybackRate(1)
    preloadRef.current = null
  }

  function handleScrubChange(
    isScrubbing: boolean,
    seg: RecordingSegment | null,
    frameIndex: number,
  ) {
    setScrubbing(isScrubbing)
    setScrubSegment(seg)
    setScrubFrameIndex(frameIndex)
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

          <input
            type="date"
            value={selectedDate}
            max={new Date().toISOString().slice(0, 10)}
            onChange={e => setSelectedDate(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-200 px-2 py-1 focus:outline-none focus:border-sky-500"
          />

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
        <div className="relative flex-1 min-h-0 bg-black">
          {/* Live HLS stream */}
          <div className={`absolute inset-0 ${mode === 'live' ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
            <HlsPlayer
              ref={playerRef}
              src={hlsUrl(camera.id, 'main')}
              startMuted={muted}
              objectFit="contain"
              className="w-full h-full"
              onMuteBlocked={() => setMuted(true)}
            />
          </div>

          {/* Playback video — opacity:0 while scrubbing keeps last frame visible */}
          <video
            ref={playbackVideoRef}
            playsInline
            muted={muted}
            className="absolute inset-0 w-full h-full object-contain"
            style={{ opacity: mode === 'playback' && !scrubbing ? 1 : 0 }}
          />

          {/* Sprite thumbnail overlay — shown while scrubbing */}
          {scrubbing && scrubSegment?.hasSprite && (
            <div
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
                         rounded overflow-hidden border border-zinc-600 shadow-2xl z-30"
            >
              <div style={{
                width: 160, height: 90,
                backgroundImage: `url(${scrubSegment.spriteUrl})`,
                backgroundPosition: `-${scrubFrameIndex * 160}px 0px`,
                backgroundRepeat: 'no-repeat',
                backgroundSize: 'auto 90px',
              }} />
              <div className="bg-zinc-900 text-[11px] text-zinc-300 text-center py-0.5 px-1">
                {new Date(playbackTime?.getTime() ?? Date.now()).toLocaleTimeString([], {
                  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                })}
                {scrubSegment.motion && <span className="ml-1.5 text-amber-400">Motion</span>}
              </div>
            </div>
          )}
        </div>

        {/* Playback speed controls */}
        {mode === 'playback' && (
          <div className="flex items-center justify-center gap-1 py-1 shrink-0 border-t border-zinc-800/50">
            {[0.5, 1, 2, 4].map(rate => (
              <button
                key={rate}
                onClick={() => setPlaybackRate(rate)}
                className={`px-2 py-0.5 rounded text-[11px] font-mono border transition-colors ${
                  playbackRate === rate
                    ? 'bg-sky-900/60 text-sky-300 border-sky-700'
                    : 'bg-zinc-900 text-zinc-500 border-zinc-800 hover:text-zinc-300'
                }`}
              >
                {rate}×
              </button>
            ))}
            <span className="ml-2 text-[10px] text-zinc-600">
              J/K/L to jog · Space to pause · ←/→ segments
            </span>
          </div>
        )}

        {/* Timeline */}
        <div className="shrink-0 border-t border-zinc-800">
          <Timeline
            segments={segments}
            date={selectedDate}
            currentTime={playbackTime}
            onSeek={handleSeek}
            onLive={handleGoLive}
            onScrubChange={handleScrubChange}
            isLive={mode === 'live'}
          />
        </div>
      </div>
    </div>
  )
}
