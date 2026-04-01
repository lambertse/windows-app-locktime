import { Minus, X } from 'lucide-react'

export function TitleBar() {
  return (
    <div
      className="flex items-center justify-between shrink-0 px-3"
      style={{
        height: 38,
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        // Make the whole bar draggable
        WebkitAppRegion: 'drag' as React.CSSProperties['WebkitAppRegion'],
      } as React.CSSProperties}
    >
      {/* Spacer — branding lives in the Sidebar */}
      <div />

      {/* Window controls — must opt out of drag so clicks register */}
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={() => window.electronAPI.minimize()}
          className="flex items-center justify-center rounded transition-colors"
          style={{
            width: 28,
            height: 22,
            color: 'var(--text-muted)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          title="Minimise"
        >
          <Minus style={{ width: 12, height: 12 }} />
        </button>

        <button
          onClick={() => window.electronAPI.hide()}
          className="flex items-center justify-center rounded transition-colors"
          style={{
            width: 28,
            height: 22,
            color: 'var(--text-muted)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--red)'
            e.currentTarget.style.color = '#fff'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.color = 'var(--text-muted)'
          }}
          title="Close to tray"
        >
          <X style={{ width: 12, height: 12 }} />
        </button>
      </div>
    </div>
  )
}
