import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'

export function BlockedPopup() {
  const [params] = useSearchParams()
  const appName = params.get('app') ?? 'Application'
  const ruleName = params.get('rule') ?? ''
  const reason = params.get('reason') ?? ''
  const nextUnlock = params.get('unlock') ?? ''

  // Sync theme from the main app's localStorage preference
  useEffect(() => {
    const theme = localStorage.getItem('locktime-theme') ?? 'dark'
    document.documentElement.setAttribute('data-theme', theme)
  }, [])

  function formatReason(r: string): string {
    if (r === 'daily_limit') return 'Daily time limit has been reached'
    if (r === 'schedule') return 'Outside of the allowed schedule'
    return r || 'This application is currently restricted'
  }

  return (
    <div
      className="flex items-start gap-3 p-4 select-none"
      style={{
        background: 'var(--surface)',
        height: '100vh',
        overflow: 'hidden',
        // Make the whole window draggable so users can reposition it
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {/* Warning icon */}
      <div className="flex-shrink-0 mt-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <AlertTriangle size={18} style={{ color: 'var(--accent-amber)' }} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>
          Application Blocked
        </p>
        <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {ruleName ? (
            <>
              <span style={{ color: 'var(--text-primary)' }}>{ruleName}</span>
              {' rule is active. '}
            </>
          ) : null}
          {formatReason(reason)}
          {nextUnlock ? (
            <>
              {' Available from '}
              <span style={{ color: 'var(--text-primary)' }}>{nextUnlock}</span>.
            </>
          ) : (
            '.'
          )}
        </p>
        {appName && appName !== 'Application' && (
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)', opacity: 0.6 }}>
            {appName}
          </p>
        )}
      </div>

      {/* Close button — must opt out of drag region */}
      <button
        onClick={() => window.electronAPI.closePopup()}
        className="flex-shrink-0 text-xs font-semibold uppercase transition-opacity hover:opacity-60"
        style={{
          color: 'var(--accent)',
          letterSpacing: '0.08em',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 4px',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        Close
      </button>
    </div>
  )
}
