import Hls from 'hls.js'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Radio, Volume2, VolumeX, Maximize2, Minimize2, Loader, WifiOff } from 'lucide-react'
import { hlsUrl } from '../lib/api'

type Status = 'loading' | 'playing' | 'error'

// NW-Front (cam2) → left audio channel; SE-Driveway (cam1) → right audio channel.
const CAM_LEFT = { id: 'cam2', name: 'NW-Front' }
const CAM_RIGHT = { id: 'cam1', name: 'SE-Driveway' }

function VideoPanel({
  videoRef,
  status,
  label,
  channel,
  borderBottom,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  status: Status
  label: string
  channel: 'L' | 'R'
  borderBottom?: boolean
}) {
  return (
    <div className={`relative flex-1 bg-black min-h-0 ${borderBottom ? 'border-b border-zinc-800' : ''}`}>
      <video
        ref={videoRef as React.RefObject<HTMLVideoElement>}
        playsInline
        className="absolute inset-0 w-full h-full object-contain"
      />

      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-zinc-950">
          <Loader size={20} className="text-zinc-600 animate-spin" />
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-zinc-950">
          <WifiOff size={22} className="text-zinc-600" />
          <span className="text-xs text-zinc-600">Stream unavailable</span>
        </div>
      )}

      {/* Channel label */}
      <div className="absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none">
        <span className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/60 text-[10px] font-medium text-zinc-300">
          <span className="text-indigo-400 font-bold">{channel}</span>
          {label}
        </span>
      </div>
    </div>
  )
}

export default function DualCameraPage() {
  const navigate = useNavigate()
  const leftVideoRef = useRef<HTMLVideoElement>(null)
  const rightVideoRef = useRef<HTMLVideoElement>(null)
  const videoAreaRef = useRef<HTMLDivElement>(null)

  const audioCtxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const audioConnected = useRef(false)

  const [leftStatus, setLeftStatus] = useState<Status>('loading')
  const [rightStatus, setRightStatus] = useState<Status>('loading')
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem('nvr_muted') !== 'false' } catch { return true }
  })
  const [isFullscreen, setIsFullscreen] = useState(false)

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

  // Set up HLS streams for both video elements.
  useEffect(() => {
    const videos = [
      { el: leftVideoRef.current, src: hlsUrl(CAM_LEFT.id, 'main'), setStatus: setLeftStatus },
      { el: rightVideoRef.current, src: hlsUrl(CAM_RIGHT.id, 'main'), setStatus: setRightStatus },
    ]

    const destroyers: Array<() => void> = []

    for (const { el: video, src, setStatus } of videos) {
      if (!video) continue
      setStatus('loading')
      video.muted = true // always start muted so autoplay is allowed

      if (Hls.isSupported()) {
        const hls = new Hls({
          liveSyncDurationCount: 1,
          liveMaxLatencyDurationCount: 4,
          maxBufferLength: 6,
          backBufferLength: 0,
        })
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().then(() => setStatus('playing')).catch(() => setStatus('playing'))
        })
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setStatus('error')
        })
        hls.loadSource(src)
        hls.attachMedia(video)
        destroyers.push(() => hls.destroy())
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src
        const onMeta = () => video.play().then(() => setStatus('playing')).catch(() => setStatus('playing'))
        const onErr = () => setStatus('error')
        video.addEventListener('loadedmetadata', onMeta)
        video.addEventListener('error', onErr)
        destroyers.push(() => {
          video.removeEventListener('loadedmetadata', onMeta)
          video.removeEventListener('error', onErr)
          video.src = ''
        })
      } else {
        setStatus('error')
      }
    }

    return () => destroyers.forEach((d) => d())
  }, [])

  // Build the Web Audio stereo graph on first Unmute. Must only be called
  // from a click handler — createMediaElementSource requires a user gesture
  // and can only be called once per element (React StrictMode effect double-
  // invocation would permanently taint the elements if called in a useEffect).
  function connectAudio(leftVideo: HTMLVideoElement, rightVideo: HTMLVideoElement) {
    // 48 kHz matches the camera stream sample rate — avoids in-graph resampling crackle.
    const ctx = new AudioContext({ sampleRate: 48000 })
    const gain = ctx.createGain()
    gain.connect(ctx.destination)

    // StereoPanner handles any channel count; ChannelMerger silently breaks
    // when hls.js/MSE presents mono tracks as 2-channel internally.
    const panLeft = ctx.createStereoPanner()
    panLeft.pan.value = -1 // cam2 (NW-Front) → fully left
    ctx.createMediaElementSource(leftVideo).connect(panLeft).connect(gain)

    const panRight = ctx.createStereoPanner()
    panRight.pan.value = 1 // cam1 (SE-Driveway) → fully right
    ctx.createMediaElementSource(rightVideo).connect(panRight).connect(gain)

    // createMediaElementSource disconnects the video from the browser's native
    // audio output. Setting muted=false ensures Chrome doesn't silence the
    // source before it reaches the Web Audio graph.
    leftVideo.muted = false
    rightVideo.muted = false

    if (ctx.state === 'suspended') ctx.resume()

    audioCtxRef.current = ctx
    gainRef.current = gain
    audioConnected.current = true
  }

  // Clean up AudioContext on unmount.
  useEffect(() => {
    return () => {
      audioCtxRef.current?.close()
      audioCtxRef.current = null
      gainRef.current = null
      audioConnected.current = false
    }
  }, [])

  function toggleMute() {
    const newMuted = !muted

    // Build the audio graph on first Unmute (lazy — requires a user gesture).
    if (!audioConnected.current && !newMuted) {
      const leftVideo = leftVideoRef.current
      const rightVideo = rightVideoRef.current
      if (leftVideo && rightVideo) {
        try {
          connectAudio(leftVideo, rightVideo)
        } catch (e) {
          console.error('[DualCameraPage] Web Audio setup failed:', e)
        }
      }
    }

    const ctx = audioCtxRef.current
    const gain = gainRef.current
    if (ctx && gain) {
      if (ctx.state === 'suspended') ctx.resume()
      gain.gain.value = newMuted ? 0 : 1
    }

    setMuted(newMuted)
    try { localStorage.setItem('nvr_muted', String(newMuted)) } catch {}
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
          <span className="text-sm font-medium text-zinc-100">Combined</span>
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-red-950/60 text-red-400 border border-red-900/50">
            <Radio size={8} className="animate-pulse" />
            Live
          </span>
          <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-indigo-950/60 text-indigo-400 border border-indigo-900/50">
            Stereo
          </span>
        </div>

        <div className="flex items-center gap-1">
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

          <button
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            <span>{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
          </button>
        </div>
      </div>

      {/* Dual video area — stacked, letterboxed */}
      <div
        ref={videoAreaRef}
        onDoubleClick={toggleFullscreen}
        className="flex-1 flex flex-col min-h-0 overflow-hidden"
      >
        <VideoPanel
          videoRef={leftVideoRef}
          status={leftStatus}
          label={CAM_LEFT.name}
          channel="L"
          borderBottom
        />
        <VideoPanel
          videoRef={rightVideoRef}
          status={rightStatus}
          label={CAM_RIGHT.name}
          channel="R"
        />
      </div>

      {/* Timeline placeholder */}
      <div className="h-14 bg-zinc-900 border-t border-zinc-800 flex items-center px-4 gap-3 shrink-0">
        <span className="text-xs text-zinc-600 shrink-0">Timeline</span>
        <div className="flex-1 h-1.5 rounded-full bg-zinc-800 cursor-pointer">
          <div className="h-full w-full rounded-full bg-sky-700/50" />
        </div>
        <button className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-sky-600 hover:bg-sky-500 text-white transition-colors">
          Live
        </button>
      </div>
    </div>
  )
}
