import { NavLink } from 'react-router-dom'
import { LayoutDashboard, BookOpen, BarChart2, Shield, Wifi, WifiOff } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { getStatus } from '../../api/client'
import { cn } from '../../lib/utils'

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/rules', label: 'App Rules', icon: BookOpen },
  { to: '/stats', label: 'Usage Stats', icon: BarChart2 },
]

export function Sidebar() {
  const { data: statusData, isError } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 10000,
    staleTime: 5000,
    retry: 1,
  })

  const serviceRunning = !isError && statusData?.service?.status === 'running'

  return (
    <aside className="w-[220px] shrink-0 h-screen flex flex-col bg-[#18181b] border-r border-zinc-800 sticky top-0">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-zinc-800">
        <div className="flex items-center gap-2.5">
          <Shield className="w-5 h-5 text-cyan-400" />
          <span className="font-semibold text-zinc-100 tracking-tight">AppLocker</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 flex flex-col gap-0.5">
        <div className="px-2 py-1 mb-1">
          <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-widest">Navigation</span>
        </div>
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 px-3 py-2 rounded text-sm font-medium transition-colors',
                isActive
                  ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                  : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon className={cn('w-4 h-4', isActive ? 'text-cyan-400' : 'text-zinc-500')} />
                {item.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer — service status */}
      <div className="p-4 border-t border-zinc-800">
        <div className="flex items-center gap-2">
          {serviceRunning ? (
            <>
              <Wifi className="w-3.5 h-3.5 text-green-500" />
              <span className="text-xs text-zinc-400">Service: </span>
              <span className="text-xs text-green-400 font-medium">Running</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3.5 h-3.5 text-red-500" />
              <span className="text-xs text-zinc-400">Service: </span>
              <span className="text-xs text-red-400 font-medium">Down</span>
            </>
          )}
        </div>
        {statusData?.service && (
          <div className="mt-1 text-[10px] text-zinc-600 font-mono">
            v{statusData.service.version}
          </div>
        )}
      </div>
    </aside>
  )
}
