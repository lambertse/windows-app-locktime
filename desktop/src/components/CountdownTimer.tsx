import { useState, useEffect } from 'react'

interface CountdownTimerProps {
  targetIso: string | null
  prefix?: string
  suffix?: string
  className?: string
}

function formatCountdown(targetIso: string): string {
  const target = new Date(targetIso).getTime()
  const now = Date.now()
  const diffMs = target - now

  if (diffMs <= 0) return 'now'

  const totalMinutes = Math.floor(diffMs / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

export function CountdownTimer({ targetIso, prefix = '', suffix = '', className }: CountdownTimerProps) {
  const [display, setDisplay] = useState<string>('')

  useEffect(() => {
    if (!targetIso) {
      setDisplay('')
      return
    }

    const update = () => setDisplay(formatCountdown(targetIso))
    update()

    const id = setInterval(update, 60000) // update every minute
    return () => clearInterval(id)
  }, [targetIso])

  if (!targetIso || !display) return null

  return (
    <span className={className}>
      {prefix}{display}{suffix}
    </span>
  )
}

export { formatCountdown }
