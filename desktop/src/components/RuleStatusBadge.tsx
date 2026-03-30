import type { RuleStatus } from '../types/api'
import { cn } from '../lib/utils'

interface RuleStatusBadgeProps {
  status: RuleStatus
  className?: string
}

const statusConfig: Record<RuleStatus, { label: string; className: string }> = {
  locked: {
    label: 'LOCKED',
    className: 'bg-red-500/20 text-red-400 border border-red-500/30',
  },
  active: {
    label: 'ACTIVE',
    className: 'bg-green-500/20 text-green-400 border border-green-500/30',
  },
  disabled: {
    label: 'DISABLED',
    className: 'bg-zinc-500/20 text-zinc-400 border border-zinc-500/30',
  },
}

export function RuleStatusBadge({ status, className }: RuleStatusBadgeProps) {
  const config = statusConfig[status]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold tracking-wider font-mono',
        config.className,
        className
      )}
    >
      {config.label}
    </span>
  )
}
