import { AlertTriangle } from 'lucide-react'

interface ServiceStatusBannerProps {
  status: string
}

export function ServiceStatusBanner({ status }: ServiceStatusBannerProps) {
  if (status === 'running') return null

  return (
    <div className="w-full bg-amber-500/20 border-b border-amber-500/40 px-4 py-2 flex items-center gap-2 text-amber-400 text-sm">
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span>
        <strong>Service unreachable</strong> — rules are <strong>NOT enforced</strong>. Check that the AppLocker service is running.
      </span>
    </div>
  )
}
