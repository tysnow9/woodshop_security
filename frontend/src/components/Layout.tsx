import { Outlet, NavLink } from 'react-router-dom'
import { Shield, Settings, LayoutGrid } from 'lucide-react'

export default function Layout() {
  return (
    <div className="flex flex-col h-full min-h-screen bg-[#111113]">
      <header className="flex items-center justify-between px-5 h-14 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <Shield size={18} className="text-sky-400" />
          <span className="text-sm font-semibold tracking-wide text-zinc-100">
            Woodshop Security
          </span>
        </div>

        <nav className="flex items-center gap-1">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`
            }
          >
            <LayoutGrid size={14} />
            Cameras
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                isActive
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`
            }
          >
            <Settings size={14} />
            Settings
          </NavLink>
        </nav>
      </header>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
