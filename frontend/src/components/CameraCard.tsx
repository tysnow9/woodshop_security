import { useNavigate } from 'react-router-dom'
import { Settings } from 'lucide-react'
import type { Camera } from '../lib/types'
import HlsPlayer from './HlsPlayer'
import { hlsUrl } from '../lib/api'

interface Props {
  camera: Camera
}

export default function CameraCard({ camera }: Props) {
  const navigate = useNavigate()

  function openAmcrestUI(e: React.MouseEvent) {
    e.stopPropagation()
    window.open(`http://${camera.ip}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <div
      onClick={() => navigate(`/camera/${camera.id}`)}
      className="group relative bg-zinc-900 rounded-xl overflow-hidden cursor-pointer
                 border border-zinc-800 hover:border-zinc-600
                 transition-all duration-200 hover:shadow-xl hover:shadow-black/40"
    >
      {/* Video thumbnail — sub stream, muted autoplay */}
      <div className="relative w-full" style={{ aspectRatio: '704/480' }}>
        <HlsPlayer
          src={hlsUrl(camera.id, 'thumb')}
          startMuted
          objectFit="cover"
          className="absolute inset-0 w-full h-full"
        />

        {/* Gear icon — top right, visible on hover */}
        <button
          onClick={openAmcrestUI}
          title="Open Amcrest web UI"
          className="absolute top-2.5 right-2.5 z-10
                     p-1.5 rounded-md
                     bg-black/40 text-zinc-400
                     opacity-0 group-hover:opacity-100
                     hover:bg-black/70 hover:text-zinc-100
                     transition-all duration-150"
        >
          <Settings size={14} />
        </button>

        {/* LIVE badge — top left */}
        <div className="absolute top-2.5 left-2.5 z-10">
          {camera.status === 'online' ? (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-black/50 text-red-400">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              Live
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-black/50 text-zinc-500">
              Offline
            </span>
          )}
        </div>
      </div>

      {/* Card footer */}
      <div className="px-3 py-2.5 flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-200">{camera.name}</span>
        <span className="text-xs text-zinc-500">{camera.ip}</span>
      </div>
    </div>
  )
}
