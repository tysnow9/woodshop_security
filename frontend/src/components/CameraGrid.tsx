import type { Camera } from '../lib/types'
import CameraCard from './CameraCard'
import DualCard from './DualCard'

interface Props {
  cameras: Camera[]
}

export default function CameraGrid({ cameras }: Props) {
  if (cameras.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        No cameras configured.
      </div>
    )
  }

  return (
    <div className="grid gap-4 p-6"
      style={{
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))',
      }}
    >
      {cameras.map((cam) => (
        <CameraCard key={cam.id} camera={cam} />
      ))}
      {cameras.length >= 2 && <DualCard cameras={cameras} />}
    </div>
  )
}
