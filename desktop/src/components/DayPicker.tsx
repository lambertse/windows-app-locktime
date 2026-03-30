import { cn } from '../lib/utils'

const DAYS = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
]

interface DayPickerProps {
  value: number[]
  onChange: (days: number[]) => void
  className?: string
}

export function DayPicker({ value, onChange, className }: DayPickerProps) {
  const toggle = (day: number) => {
    if (value.includes(day)) {
      onChange(value.filter(d => d !== day))
    } else {
      onChange([...value, day].sort((a, b) => a - b))
    }
  }

  return (
    <div className={cn('flex gap-1', className)}>
      {DAYS.map(day => {
        const selected = value.includes(day.value)
        return (
          <button
            key={day.value}
            type="button"
            onClick={() => toggle(day.value)}
            className={cn(
              'px-2.5 py-1 rounded text-xs font-semibold transition-colors select-none',
              selected
                ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
                : 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-300'
            )}
          >
            {day.label}
          </button>
        )
      })}
    </div>
  )
}
