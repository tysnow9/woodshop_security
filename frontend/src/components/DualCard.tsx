import { useNavigate } from 'react-router-dom'
import HlsPlayer from './HlsPlayer'
import { hlsUrl } from '../lib/api'
import { getDualSettings, CAM_NAMES, OTHER_CAM } from '../lib/dualSettings'
import type { Camera } from '../lib/types'

interface Props {
  cameras: Camera[]
}

export default function DualCard({ cameras }: Props) {
  const navigate = useNavigate()
  const { leftCam } = getDualSettings()
  const rightCam = OTHER_CAM[leftCam] ?? 'cam1'

  const left = cameras.find((c) => c.id === leftCam)
  const right = cameras.find((c) => c.id === rightCam)

  if (!left || !right) return null

  const bothOnline = left.status === 'online' && right.status === 'online'

  const leftName = CAM_NAMES[left.id] ?? left.name
  const rightName = CAM_NAMES[right.id] ?? right.name

  return (
    <div
      onClick={() => navigate('/dual')}
      className="group relative bg-zinc-900 rounded-xl overflow-hidden cursor-pointer
                 border border-zinc-800 hover:border-zinc-600
                 transition-all duration-200 hover:shadow-xl hover:shadow-black/40"
    >
      {/* Stacked thumbnails — two 704/240 strips = same total height as a 704/480 card */}
      <div className="relative w-full" style={{ aspectRatio: '704/240' }}>
        <HlsPlayer
          src={hlsUrl(left.id, 'thumb')}
          startMuted
          objectFit="cover"
          className="absolute inset-0 w-full h-full"
        />
      </div>

      <div className="h-px bg-zinc-800" />

      <div className="relative w-full" style={{ aspectRatio: '704/240' }}>
        <HlsPlayer
          src={hlsUrl(right.id, 'thumb')}
          startMuted
          objectFit="cover"
          className="absolute inset-0 w-full h-full"
        />
      </div>

      {/* LIVE badge — top left. border-transparent matches the 1px border on Stereo, equalising badge heights. */}
      <div className="absolute top-2.5 left-2.5 z-10">
        {bothOnline ? (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-black/50 text-red-400 border border-transparent">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            Live
          </span>
        ) : (
          <span className="flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-black/50 text-zinc-500 border border-transparent">
            Offline
          </span>
        )}
      </div>

      {/* Stereo badge — top right */}
      <div className="absolute top-2.5 right-2.5 z-10">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-indigo-950/70 text-indigo-400 border border-indigo-800/50">
          Stereo
        </span>
      </div>

      {/* Card footer */}
      <div className="px-3 py-2.5 flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-200">Combined</span>
        <span className="text-xs text-zinc-500">
          <span className="text-indigo-500">L</span> · {leftName}&nbsp;·&nbsp;{rightName} · <span className="text-indigo-500">R</span>
        </span>
      </div>
    </div>
  )
}
