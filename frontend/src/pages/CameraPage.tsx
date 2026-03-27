import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, Settings, Radio, Volume2, VolumeX, Maximize2, Minimize2 } from 'lucide-react'
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch'
import { api, hlsUrl } from '../lib/api'
import type { Camera } from '../lib/types'
import HlsPlayer, { type HlsPlayerHandle } from '../components/HlsPlayer'

export default function CameraPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [camera, setCamera] = useState<Camera | null>(null)
  const [muted, setMuted] = useState(() => {
    try { return localStorage.getItem('nvr_muted') !== 'false' } catch { return true }
  })
  const playerRef = useRef<HlsPlayerHandle>(null)
  const videoAreaRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const fullscreenSupported = !!(document.fullscreenEnabled)

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

  function toggleMute() {
    const newMuted = !muted
    playerRef.current?.setMuted(newMuted)
    setMuted(newMuted)
    try { localStorage.setItem('nvr_muted', String(newMuted)) } catch {}
  }

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
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-red-950/60 text-red-400 border border-red-900/50">
            <Radio size={8} className="animate-pulse" />
            Live
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

      {/* Main stream video */}
      <div ref={videoAreaRef} className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <TransformWrapper minScale={1} maxScale={8} limitToBounds={true}>
          <TransformComponent
            wrapperStyle={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }}
            contentStyle={{ width: '100%', height: '100%' }}
          >
            <HlsPlayer
              ref={playerRef}
              src={hlsUrl(camera.id, 'main')}
              startMuted={muted}
              objectFit="contain"
              className="w-full h-full bg-black"
              onMuteBlocked={() => setMuted(true)}
            />
          </TransformComponent>
        </TransformWrapper>

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
    </div>
  )
}
