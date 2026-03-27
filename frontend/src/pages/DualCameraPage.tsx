import Hls from 'hls.js'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ArrowLeftRight, Radio, SlidersHorizontal,
  Volume2, VolumeX, Maximize2, Minimize2, Loader, WifiOff,
} from 'lucide-react'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import { hlsUrl } from '../lib/api'
import { getDualSettings, saveDualSettings, CAM_NAMES, OTHER_CAM } from '../lib/dualSettings'

type Status = 'loading' | 'playing' | 'error'

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
  const topVideoRef = useRef<HTMLVideoElement>(null)
  const bottomVideoRef = useRef<HTMLVideoElement>(null)
  const videoAreaRef = useRef<HTMLDivElement>(null)

  // Web Audio graph refs — populated on first Unmute.
  const audioCtxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const panTopRef = useRef<StereoPannerNode | null>(null)
  const panBottomRef = useRef<StereoPannerNode | null>(null)
  const leftChGainRef = useRef<GainNode | null>(null)
  const rightChGainRef = useRef<GainNode | null>(null)
  const audioConnected = useRef(false)

  // Settings read once at mount — determines which cam loads into top vs bottom.
  const settings = useRef(getDualSettings())
  const leftCamId = settings.current.leftCam
  const rightCamId = OTHER_CAM[leftCamId] ?? 'cam1'
  const camTop = { id: leftCamId, name: CAM_NAMES[leftCamId] ?? leftCamId }
  const camBottom = { id: rightCamId, name: CAM_NAMES[rightCamId] ?? rightCamId }

  const [topStatus, setTopStatus] = useState<Status>('loading')
  const [bottomStatus, setBottomStatus] = useState<Status>('loading')
  const [muted, setMuted] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fullscreenSupported = !!(document.fullscreenEnabled)
  const [showSettings, setShowSettings] = useState(false)
  const [balance, setBalanceState] = useState(settings.current.balance)
  const [swapped, setSwapped] = useState(false) // true = top video sends to R channel

  useEffect(() => {
    function onFsc() { setIsFullscreen(!!document.fullscreenElement) }
    document.addEventListener('fullscreenchange', onFsc)
    return () => document.removeEventListener('fullscreenchange', onFsc)
  }, [])

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen()
    else videoAreaRef.current?.requestFullscreen()
  }

  // Top video = initial leftCam; bottom = initial rightCam.
  // Swap flips audio routing only, not video position.
  useEffect(() => {
    const videos = [
      { el: topVideoRef.current, src: hlsUrl(camTop.id, 'main'), setStatus: setTopStatus },
      { el: bottomVideoRef.current, src: hlsUrl(camBottom.id, 'main'), setStatus: setBottomStatus },
    ]
    const destroyers: Array<() => void> = []

    for (const { el: video, src, setStatus } of videos) {
      if (!video) continue
      setStatus('loading')
      video.muted = true

      if (Hls.isSupported()) {
        const hls = new Hls({ liveSyncDurationCount: 1, liveMaxLatencyDurationCount: 4, maxBufferLength: 6, backBufferLength: 0 })
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().then(() => setStatus('playing')).catch(() => setStatus('playing'))
        })
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) setStatus('error') })
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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Must be called from a click handler: createMediaElementSource requires a user gesture
  // and can only be called once per element (StrictMode would permanently taint them).
  function connectAudio(topVideo: HTMLVideoElement, bottomVideo: HTMLVideoElement) {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' })
    const masterGain = ctx.createGain()
    masterGain.gain.value = 0
    masterGain.connect(ctx.destination)

    // Gain nodes are wired to topVideo/bottomVideo (fixed), not physical L/R — see applyBalance().
    const eff = swapped ? -balance : balance
    const leftChGain = ctx.createGain()
    leftChGain.gain.value = Math.min(1, 1 - eff)
    const rightChGain = ctx.createGain()
    rightChGain.gain.value = Math.min(1, 1 + eff)
    leftChGainRef.current = leftChGain
    rightChGainRef.current = rightChGain

    // StereoPanner handles any channel count; ChannelMerger silently breaks when
    // hls.js/MSE presents mono tracks as 2-channel internally.
    const panTop = ctx.createStereoPanner()
    panTop.pan.value = swapped ? 1 : -1
    const panBottom = ctx.createStereoPanner()
    panBottom.pan.value = swapped ? -1 : 1
    panTopRef.current = panTop
    panBottomRef.current = panBottom

    ctx.createMediaElementSource(topVideo).connect(panTop).connect(leftChGain).connect(masterGain)
    ctx.createMediaElementSource(bottomVideo).connect(panBottom).connect(rightChGain).connect(masterGain)

    topVideo.muted = false
    bottomVideo.muted = false

    if (ctx.state === 'suspended') ctx.resume()
    masterGain.gain.setValueAtTime(0, ctx.currentTime)
    masterGain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.08)

    audioCtxRef.current = ctx
    gainRef.current = masterGain
    audioConnected.current = true
  }

  useEffect(() => {
    return () => {
      audioCtxRef.current?.close()
      audioCtxRef.current = null
      gainRef.current = null
      panTopRef.current = null
      panBottomRef.current = null
      leftChGainRef.current = null
      rightChGainRef.current = null
      audioConnected.current = false
    }
  }, [])

  async function toggleMute() {
    const newMuted = !muted
    const topVideo = topVideoRef.current
    const bottomVideo = bottomVideoRef.current

    if (!audioConnected.current && !newMuted) {
      if (topVideo && bottomVideo) {
        try { connectAudio(topVideo, bottomVideo) }
        catch (e) { console.error('[DualCameraPage] Web Audio setup failed:', e) }
      }
    }

    // Toggle video.muted synchronously (before any await) to keep the user-gesture context.
    // Safari's createMediaElementSource() doesn't fully disconnect native audio output,
    // so this is required for mute to work reliably on Safari/iOS.
    if (audioConnected.current) {
      if (topVideo) topVideo.muted = newMuted
      if (bottomVideo) bottomVideo.muted = newMuted
    }

    const ctx = audioCtxRef.current
    const gain = gainRef.current
    if (ctx && gain) {
      if (ctx.state === 'suspended') await ctx.resume()
      gain.gain.cancelScheduledValues(0)
      if (newMuted) {
        gain.gain.value = 0
      } else {
        gain.gain.setValueAtTime(0, ctx.currentTime)
        gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 0.08)
      }
    }
    setMuted(newMuted)
    try { localStorage.setItem('nvr_muted', String(newMuted)) } catch {}
  }

  // The gain nodes are wired to topVideo/bottomVideo (not physical L/R). When swapped,
  // topVideo feeds the RIGHT speaker, so we negate the balance to keep the slider's
  // meaning consistent: slider-left = LEFT speaker louder, always.
  function applyBalance(bal: number, isSwapped: boolean) {
    const eff = isSwapped ? -bal : bal
    if (leftChGainRef.current) leftChGainRef.current.gain.value = Math.min(1, 1 - eff)
    if (rightChGainRef.current) rightChGainRef.current.gain.value = Math.min(1, 1 + eff)
  }

  function handleBalanceChange(newBalance: number) {
    setBalanceState(newBalance)
    applyBalance(newBalance, swapped)
    saveDualSettings({ ...getDualSettings(), balance: newBalance })
  }

  function handleSwap() {
    const nextSwapped = !swapped
    setSwapped(nextSwapped)
    if (panTopRef.current) panTopRef.current.pan.value = nextSwapped ? 1 : -1
    if (panBottomRef.current) panBottomRef.current.pan.value = nextSwapped ? -1 : 1
    applyBalance(balance, nextSwapped)
    saveDualSettings({ ...getDualSettings(), leftCam: nextSwapped ? camBottom.id : camTop.id })
  }

  const currentLeftName = swapped ? camBottom.name : camTop.name
  const currentRightName = swapped ? camTop.name : camBottom.name

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
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-indigo-950/60 text-indigo-400 border border-indigo-900/50">
            Stereo
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSettings((s) => !s)}
            title="Audio settings"
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors
              ${showSettings ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'}`}
          >
            <SlidersHorizontal size={14} />
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

      {/* Inline audio settings panel */}
      {showSettings && (
        <div className="border-b border-zinc-800 bg-zinc-950 px-4 py-3 flex flex-wrap items-center gap-x-10 gap-y-3 shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-500 w-14 shrink-0">Balance</span>
            <span className="text-[11px] font-bold text-indigo-400">L</span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={balance}
              onChange={(e) => handleBalanceChange(parseFloat(e.target.value))}
              className="w-36 h-1.5 rounded-full appearance-none cursor-pointer bg-zinc-700
                         [&::-webkit-slider-thumb]:appearance-none
                         [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
                         [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-400
                         [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5
                         [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-indigo-400
                         [&::-moz-range-thumb]:border-0"
            />
            <span className="text-[11px] font-bold text-indigo-400">R</span>
            <span className="text-[10px] text-zinc-600 w-10">
              {balance === 0 ? 'Center' : balance < 0 ? `${Math.round(-balance * 100)}%L` : `${Math.round(balance * 100)}%R`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 w-14 shrink-0">Channels</span>
            <span className="text-xs text-zinc-300">{currentLeftName}</span>
            <span className="text-[11px] font-bold text-indigo-400 px-0.5">L</span>
            <button
              onClick={handleSwap}
              title="Swap L/R channels"
              className="p-1 rounded text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              <ArrowLeftRight size={12} />
            </button>
            <span className="text-[11px] font-bold text-indigo-400 px-0.5">R</span>
            <span className="text-xs text-zinc-300">{currentRightName}</span>
          </div>
        </div>
      )}

      {/* Dual video area — stacked, letterboxed */}
      <div
        ref={videoAreaRef}
        className="flex-1 flex flex-col min-h-0 overflow-hidden"
      >
        <TransformWrapper minScale={1} maxScale={8} limitToBounds={true}>
          <TransformComponent
            wrapperStyle={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }}
            contentStyle={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
          >
            <VideoPanel
              videoRef={topVideoRef}
              status={topStatus}
              label={camTop.name}
              channel={swapped ? 'R' : 'L'}
              borderBottom
            />
            <VideoPanel
              videoRef={bottomVideoRef}
              status={bottomStatus}
              label={camBottom.name}
              channel={swapped ? 'L' : 'R'}
            />
          </TransformComponent>
        </TransformWrapper>
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
