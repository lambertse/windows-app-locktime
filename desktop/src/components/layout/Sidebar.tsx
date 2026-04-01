import { NavLink } from 'react-router-dom'
import { LayoutDashboard, BookOpen, BarChart2, Shield, Wifi, WifiOff } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { getStatus } from '../../api/client'
import { cn } from '../../lib/utils'
import { ThemeToggle } from '../ThemeToggle'

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
    <aside
      className="w-[220px] shrink-0 h-full flex flex-col"
      style={{
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        transition: 'background 0.25s ease, border-color 0.25s ease',
      }}
    >
      {/* Logo */}
      <div className="px-4 py-5" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2.5">
          <Shield className="w-5 h-5" style={{ color: 'var(--accent)' }} />
          <span className="font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
            AppLocker
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 flex flex-col gap-0.5">
        <div className="px-2 py-1 mb-1">
          <span
            className="text-[10px] font-semibold uppercase tracking-widest"
            style={{ color: 'var(--text-muted)' }}
          >
            Navigation
          </span>
        </div>
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 px-3 py-2 rounded text-sm font-medium transition-colors',
                isActive ? 'nav-item-active' : 'nav-item-inactive'
              )
            }
            style={({ isActive }) =>
              isActive
                ? {
                    background: 'var(--accent-dim)',
                    color: 'var(--accent)',
                    border: '1px solid var(--accent-border)',
                  }
                : {
                    color: 'var(--text-muted)',
                    border: '1px solid transparent',
                  }
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className="w-4 h-4"
                  style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}
                />
                <span style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}>
                  {item.label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Theme toggle */}
      <div className="px-4 pb-3" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div className="mb-2">
          <span
            className="text-[10px] font-semibold uppercase tracking-widest"
            style={{ color: 'var(--text-muted)' }}
          >
            Appearance
          </span>
        </div>
        <ThemeToggle />
      </div>

      {/* Footer — service status */}
      <div className="px-4 pb-4" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div className="flex items-center gap-2">
          {serviceRunning ? (
            <>
              <Wifi className="w-3.5 h-3.5" style={{ color: 'var(--green)' }} />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Service:{' '}
              </span>
              <span className="text-xs font-medium" style={{ color: 'var(--green)' }}>
                Running
              </span>
            </>
          ) : (
            <>
              <WifiOff className="w-3.5 h-3.5" style={{ color: 'var(--red)' }} />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Service:{' '}
              </span>
              <span className="text-xs font-medium" style={{ color: 'var(--red)' }}>
                Down
              </span>
            </>
          )}
        </div>
        {statusData?.service && (
          <div className="mt-1 text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            v{statusData.service.version}
          </div>
        )}
      </div>
    </aside>
  )
}
