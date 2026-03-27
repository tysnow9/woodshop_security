import { useRef, useState } from 'react'
import { Settings as SettingsIcon, Wifi, WifiOff, HardDrive, Clock, GripVertical, Layers } from 'lucide-react'
import { CAM_NAMES, getDualSettings, OTHER_CAM } from '../lib/dualSettings'

const CAM_IPS: Record<string, string> = {
  cam1: '11.200.0.101',
  cam2: '11.200.0.102',
}

function getInitialRowOrder(): string[] {
  try {
    const saved = localStorage.getItem('nvr_card_order')
    if (saved) {
      const parsed: string[] = JSON.parse(saved)
      const valid = new Set(['cam1', 'cam2', 'combined'])
      const filtered = parsed.filter((id) => valid.has(id))
      for (const id of ['cam1', 'cam2', 'combined']) {
        if (!filtered.includes(id)) filtered.push(id)
      }
      return filtered
    }
  } catch {}
  return ['cam1', 'cam2', 'combined']
}

function getEnabledState(): Record<string, boolean> {
  try {
    const saved = localStorage.getItem('nvr_enabled')
    if (saved) return JSON.parse(saved)
  } catch {}
  return { cam1: true, cam2: true, combined: true }
}

function saveEnabledState(state: Record<string, boolean>) {
  try { localStorage.setItem('nvr_enabled', JSON.stringify(state)) } catch {}
  // Keep the legacy combined key in sync for CameraGrid compatibility.
  try { localStorage.setItem('nvr_combined_enabled', String(state.combined ?? true)) } catch {}
}

function DraggableRow({
  id,
  isDragOver,
  onDragStart,
  onDrop,
  onDragOver,
  onDragLeave,
  children,
}: {
  id: string
  isDragOver: boolean
  onDragStart: (id: string) => void
  onDrop: (targetId: string) => void
  onDragOver: (id: string) => void
  onDragLeave: () => void
  children: React.ReactNode
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={wrapperRef}
      className={`flex items-center bg-zinc-900 transition-colors ${isDragOver ? 'bg-zinc-800' : ''}`}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(id)
      }}
      onDragEnd={() => {
        wrapperRef.current?.setAttribute('draggable', 'false')
        onDragLeave()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onDragOver(id)
      }}
      onDragLeave={(e) => {
        if (!wrapperRef.current?.contains(e.relatedTarget as Node)) onDragLeave()
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop(id)
      }}
    >
      <div
        className="flex items-center justify-center w-9 self-stretch cursor-grab text-zinc-700 hover:text-zinc-400 shrink-0 transition-colors"
        onPointerDown={(e) => {
          e.stopPropagation()
          wrapperRef.current?.setAttribute('draggable', 'true')
        }}
        onPointerUp={() => wrapperRef.current?.setAttribute('draggable', 'false')}
      >
        <GripVertical size={14} />
      </div>
      {children}
    </div>
  )
}

export default function Settings() {
  const [rowOrder, setRowOrder] = useState<string[]>(getInitialRowOrder)
  const [enabled, setEnabled] = useState<Record<string, boolean>>(getEnabledState)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const draggingId = useRef<string | null>(null)

  function saveRowOrder(next: string[]) {
    setRowOrder(next)
    try { localStorage.setItem('nvr_card_order', JSON.stringify(next)) } catch {}
  }

  function toggleEnabled(id: string) {
    const next = { ...enabled, [id]: !enabled[id] }
    setEnabled(next)
    saveEnabledState(next)
  }

  function handleDragStart(id: string) { draggingId.current = id }

  function handleDrop(targetId: string) {
    const fromId = draggingId.current
    draggingId.current = null
    setDragOverId(null)
    if (!fromId || fromId === targetId) return
    const from = rowOrder.indexOf(fromId)
    const to = rowOrder.indexOf(targetId)
    if (from === -1 || to === -1) return
    const next = [...rowOrder]
    next.splice(from, 1)
    next.splice(to, 0, fromId)
    saveRowOrder(next)
  }

  const { leftCam } = getDualSettings()
  const leftName = CAM_NAMES[leftCam] ?? leftCam
  const rightName = CAM_NAMES[OTHER_CAM[leftCam] ?? 'cam1'] ?? 'cam1'

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
      <div className="flex items-center gap-2 text-zinc-100">
        <SettingsIcon size={18} className="text-zinc-400" />
        <h1 className="text-base font-semibold">Settings</h1>
      </div>

      {/* Cameras */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Cameras
        </h2>
        <div className="rounded-xl border border-zinc-800 divide-y divide-zinc-800 overflow-hidden">
          {rowOrder.map((id) => {
            const isCombined = id === 'combined'
            const isOn = enabled[id] ?? true

            if (isCombined) {
              return (
                <DraggableRow
                  key="combined"
                  id="combined"
                  isDragOver={dragOverId === 'combined'}
                  onDragStart={handleDragStart}
                  onDrop={handleDrop}
                  onDragOver={setDragOverId}
                  onDragLeave={() => setDragOverId(null)}
                >
                  <div className="flex flex-1 items-center justify-between pr-4 py-3.5 gap-3 min-w-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-zinc-100 flex items-center gap-1.5">
                        Combined
                        <Layers size={11} className="text-indigo-400 shrink-0" />
                      </p>
                      <p className="text-xs text-zinc-500 mt-0.5 truncate">
                        <span className="text-indigo-500">L</span> {leftName} · {rightName} <span className="text-indigo-500">R</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {isOn ? (
                        <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                          <Wifi size={12} />
                          Active
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-xs text-zinc-600">
                          <WifiOff size={12} />
                          Hidden
                        </span>
                      )}
                      <button
                        onClick={() => toggleEnabled('combined')}
                        className={`w-9 h-5 rounded-full relative transition-colors ${isOn ? 'bg-sky-600' : 'bg-zinc-700'}`}
                      >
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${isOn ? 'right-0.5' : 'left-0.5'}`} />
                      </button>
                    </div>
                  </div>
                </DraggableRow>
              )
            }

            const name = CAM_NAMES[id] ?? id
            const ip = CAM_IPS[id] ?? ''
            return (
              <DraggableRow
                key={id}
                id={id}
                isDragOver={dragOverId === id}
                onDragStart={handleDragStart}
                onDrop={handleDrop}
                onDragOver={setDragOverId}
                onDragLeave={() => setDragOverId(null)}
              >
                <div className="flex flex-1 items-center justify-between pr-4 py-3.5 min-w-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-100">{name}</p>
                    <p className="text-xs text-zinc-500 mt-0.5 font-mono">{ip}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {isOn ? (
                      <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                        <Wifi size={12} />
                        Online
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-xs text-zinc-600">
                        <WifiOff size={12} />
                        Hidden
                      </span>
                    )}
                    <button
                      onClick={() => toggleEnabled(id)}
                      className={`w-9 h-5 rounded-full relative transition-colors ${isOn ? 'bg-sky-600' : 'bg-zinc-700'}`}
                    >
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${isOn ? 'right-0.5' : 'left-0.5'}`} />
                    </button>
                  </div>
                </div>
              </DraggableRow>
            )
          })}
        </div>
        <p className="mt-2 text-[11px] text-zinc-600 pl-1">Drag to reorder · toggle to show/hide on dashboard.</p>
      </section>

      {/* Retention */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Recording
        </h2>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 divide-y divide-zinc-800 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <Clock size={15} className="text-zinc-400" />
              <div>
                <p className="text-sm font-medium text-zinc-100">Retention period</p>
                <p className="text-xs text-zinc-500 mt-0.5">Recordings older than this are deleted</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                defaultValue={7}
                min={1}
                max={60}
                className="w-14 px-2 py-1 rounded-md bg-zinc-800 border border-zinc-700 text-sm text-zinc-100 text-center focus:outline-none focus:border-sky-500"
              />
              <span className="text-sm text-zinc-400">days</span>
            </div>
          </div>
        </div>
      </section>

      {/* Storage */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">
          Storage
        </h2>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3.5">
          <div className="flex items-center gap-2.5 mb-3">
            <HardDrive size={15} className="text-zinc-400" />
            <p className="text-sm font-medium text-zinc-100">Disk usage</p>
          </div>
          <div className="h-2 rounded-full bg-zinc-800 mb-2">
            <div className="h-full w-[2%] rounded-full bg-sky-500" />
          </div>
          <div className="flex justify-between text-xs text-zinc-500">
            <span>15 GB used</span>
            <span>875 GB available</span>
          </div>
        </div>
      </section>
    </div>
  )
}
