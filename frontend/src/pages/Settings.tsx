import { Settings as SettingsIcon, Wifi, HardDrive, Clock } from 'lucide-react'

const CAMERAS = [
  { id: 'cam1', name: 'Front Yard', ip: '11.200.0.101', enabled: true },
  { id: 'cam2', name: 'Back Yard', ip: '11.200.0.102', enabled: true },
]

export default function Settings() {
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
          {CAMERAS.map((cam) => (
            <div key={cam.id} className="flex items-center justify-between px-4 py-3.5 bg-zinc-900">
              <div>
                <p className="text-sm font-medium text-zinc-100">{cam.name}</p>
                <p className="text-xs text-zinc-500 mt-0.5 font-mono">{cam.ip}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                  <Wifi size={12} />
                  Online
                </span>
                {/* Toggle placeholder */}
                <button className="w-9 h-5 rounded-full bg-sky-600 relative transition-colors">
                  <span className="absolute right-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow" />
                </button>
              </div>
            </div>
          ))}
        </div>
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
