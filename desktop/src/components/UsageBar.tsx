import { cn } from '../lib/utils'

interface UsageBarProps {
  minutesUsed: number
  dailyLimitMinutes: number | null
  className?: string
  showLabel?: boolean
}

function formatMinutes(m: number): string {
  const h = Math.floor(m / 60)
  const min = m % 60
  if (h === 0) return `${min}m`
  if (min === 0) return `${h}h`
  return `${h}h ${min}m`
}

export function UsageBar({ minutesUsed, dailyLimitMinutes, className, showLabel = true }: UsageBarProps) {
  if (!dailyLimitMinutes || dailyLimitMinutes === 0) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
          <div className="h-full bg-cyan-500/40 rounded-full" style={{ width: `${Math.min((minutesUsed / 120) * 100, 100)}%` }} />
        </div>
        {showLabel && (
          <span className="text-xs text-zinc-400 font-mono w-24 shrink-0 text-right">
            {formatMinutes(minutesUsed)} / —
          </span>
        )}
      </div>
    )
  }

  const pct = Math.min((minutesUsed / dailyLimitMinutes) * 100, 100)
  const exceeded = minutesUsed >= dailyLimitMinutes

  const barColor =
    exceeded
      ? 'bg-red-500'
      : pct >= 90
      ? 'bg-red-400'
      : pct >= 75
      ? 'bg-amber-400'
      : 'bg-green-500'

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-300', barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className={cn('text-xs font-mono w-24 shrink-0 text-right', exceeded ? 'text-red-400' : 'text-zinc-400')}>
          {exceeded ? 'LIMIT REACHED' : `${formatMinutes(minutesUsed)} / ${formatMinutes(dailyLimitMinutes)}`}
        </span>
      )}
    </div>
  )
}

export { formatMinutes }
