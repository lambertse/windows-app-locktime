import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../contexts/ThemeContext'

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'

  return (
    <div className="flex items-center gap-2.5">
      {/* LIGHT label */}
      <span
        className="text-[10px] font-semibold uppercase tracking-wider transition-colors duration-200 select-none"
        style={{ color: isDark ? 'var(--text-muted)' : 'var(--accent)' }}
      >
        Light
      </span>

      {/* Toggle pill */}
      <button
        onClick={toggleTheme}
        aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
        className="relative shrink-0 focus:outline-none focus-visible:ring-2 rounded-full cursor-pointer"
        style={{
          width: 52,
          height: 28,
          borderRadius: 14,
          background: isDark ? '#313135' : '#EDE4CE',
          transition: 'background 0.3s ease',
          // @ts-expect-error CSS custom property
          '--tw-ring-color': 'var(--accent)',
        }}
      >
        {/* Sliding thumb */}
        <span
          className="absolute top-[4px] flex items-center justify-center rounded-full"
          style={{
            width: 20,
            height: 20,
            left: isDark ? 28 : 4,
            background: isDark ? '#8aebff' : '#B87333',
            boxShadow: isDark
              ? '0 0 8px rgba(138, 235, 255, 0.45)'
              : '0 0 6px rgba(184, 115, 51, 0.35)',
            transition: 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1), background 0.3s ease, box-shadow 0.3s ease',
          }}
        >
          {isDark ? (
            <Moon style={{ width: 11, height: 11, color: '#202023' }} />
          ) : (
            <Sun style={{ width: 11, height: 11, color: '#FDF6E8' }} />
          )}
        </span>
      </button>

      {/* DARK label */}
      <span
        className="text-[10px] font-semibold uppercase tracking-wider transition-colors duration-200 select-none"
        style={{ color: isDark ? 'var(--accent)' : 'var(--text-muted)' }}
      >
        Dark
      </span>
    </div>
  )
}
