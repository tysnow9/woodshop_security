import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Camera } from '../lib/types'
import CameraGrid from '../components/CameraGrid'

export default function Dashboard() {
  const [cameras, setCameras] = useState<Camera[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.cameras
      .list()
      .then(setCameras)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Failed to load cameras'
        setError(msg)
        // Fall back to placeholder cameras when backend isn't running
        setCameras([
          { id: 'cam1', name: 'Front Yard', ip: '11.200.0.101', status: 'online' },
          { id: 'cam2', name: 'Back Yard', ip: '11.200.0.102', status: 'online' },
        ])
      })
  }, [])

  return (
    <div>
      {error && (
        <div className="mx-6 mt-4 px-4 py-2.5 rounded-lg bg-amber-950/40 border border-amber-800/50 text-amber-400 text-xs">
          Backend offline — showing placeholder cameras. ({error})
        </div>
      )}
      <CameraGrid cameras={cameras} />
    </div>
  )
}
