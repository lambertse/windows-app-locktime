import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Lock, Unlock, Activity, AlertCircle, Clock } from 'lucide-react'
import { getStatus, getUsageToday } from '../api/client'
import { ServiceStatusBanner } from '../components/ServiceStatusBanner'
import { RuleStatusBadge } from '../components/RuleStatusBadge'
import { UsageBar } from '../components/UsageBar'
import { CountdownTimer } from '../components/CountdownTimer'

export function Dashboard() {
  const { data: statusData, isError: statusError } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 10000,
    staleTime: 5000,
    retry: 1,
  })

  const { data: usageData } = useQuery({
    queryKey: ['usage-today'],
    queryFn: getUsageToday,
    refetchInterval: 30000,
    staleTime: 15000,
  })

  const serviceStatus = statusError ? 'unreachable' : (statusData?.service?.status ?? 'unknown')
  const rules = statusData?.rules ?? []
  const lockedRules = rules.filter(r => r.status === 'locked')
  const activeRules = rules.filter(r => r.status === 'active' && r.next_lock_at)

  const today = format(new Date(), 'EEE d MMM')
  const time = format(new Date(), 'HH:mm')

  return (
    <div className="flex flex-col min-h-screen">
      <ServiceStatusBanner status={serviceStatus} />

      {/* Header */}
      <div className="px-8 py-6 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Dashboard</h1>
          <p className="text-sm text-zinc-500 mt-0.5">At-a-glance system status</p>
        </div>
        <div className="text-right">
          <div className="text-sm font-mono text-zinc-300">{today}</div>
          <div className="text-xs text-zinc-500 font-mono">{time}</div>
        </div>
      </div>

      <div className="flex-1 p-8 grid grid-cols-1 gap-6">
        {/* Active Locks Card */}
        <div className="rounded-lg border border-zinc-800 bg-[#18181b] p-5">
          <div className="flex items-center gap-2 mb-4">
            <Lock className="w-4 h-4 text-red-400" />
            <h2 className="text-sm font-semibold text-zinc-200 uppercase tracking-wider">Currently Active Locks</h2>
            {lockedRules.length > 0 && (
              <span className="ml-auto bg-red-500/20 text-red-400 text-xs font-bold px-2 py-0.5 rounded border border-red-500/30 animate-pulse">
                {lockedRules.length}
              </span>
            )}
          </div>

          {lockedRules.length === 0 ? (
            <div className="py-6 text-center">
              <Unlock className="w-8 h-8 text-green-500/40 mx-auto mb-2" />
              <p className="text-sm text-zinc-500">No locks active right now</p>
              <p className="text-xs text-zinc-600 mt-1">You're a free agent 🟢</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {lockedRules.map(rule => (
                <div
                  key={rule.rule_id}
                  className="flex items-center gap-3 p-3 rounded bg-red-500/5 border border-red-500/10"
                >
                  <Lock className="w-4 h-4 text-red-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-zinc-100">{rule.rule_name}</div>
                    <div className="text-xs text-zinc-500 font-mono">{rule.exe_name}</div>
                  </div>
                  <div className="text-right">
                    <RuleStatusBadge status="locked" />
                    {rule.next_unlock_at && (
                      <div className="text-xs text-zinc-500 mt-1">
                        <CountdownTimer
                          targetIso={rule.next_unlock_at}
                          prefix="Unlocks in "
                          className="text-zinc-400"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Today's Usage Card */}
        <div className="rounded-lg border border-zinc-800 bg-[#18181b] p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-zinc-200 uppercase tracking-wider">Today's Usage</h2>
          </div>

          {!usageData || usageData.usage.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-zinc-500">No usage recorded today yet</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {usageData.usage.map(entry => (
                <div key={entry.rule_id} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-zinc-200">{entry.rule_name}</span>
                    {entry.limit_reached && (
                      <span className="text-xs text-red-400 font-semibold">LIMIT REACHED</span>
                    )}
                  </div>
                  <UsageBar
                    minutesUsed={entry.minutes_used}
                    dailyLimitMinutes={entry.daily_limit_minutes || null}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming Events Card */}
        <div className="rounded-lg border border-zinc-800 bg-[#18181b] p-5">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-zinc-200 uppercase tracking-wider">Upcoming Lock Events</h2>
          </div>

          {activeRules.length === 0 && lockedRules.filter(r => r.next_unlock_at).length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-zinc-500">No upcoming lock events</p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-zinc-800">
              {/* Active rules with upcoming locks */}
              {activeRules.map(rule => (
                <div key={rule.rule_id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <span className="text-sm text-zinc-200">{rule.rule_name}</span>
                    <div className="text-xs text-zinc-500 font-mono">{rule.exe_name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-amber-400 font-medium">
                      Locks in{' '}
                      <CountdownTimer targetIso={rule.next_lock_at} className="font-semibold" />
                    </div>
                    {rule.next_lock_at && (
                      <div className="text-xs text-zinc-500 font-mono">
                        at {format(new Date(rule.next_lock_at), 'HH:mm')}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {/* Locked rules with unlock times */}
              {lockedRules.filter(r => r.next_unlock_at).map(rule => (
                <div key={rule.rule_id} className="py-2.5 flex items-center justify-between">
                  <div>
                    <span className="text-sm text-zinc-200">{rule.rule_name}</span>
                    <div className="text-xs text-zinc-500 font-mono">{rule.exe_name}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-green-400 font-medium">
                      Unlocks in{' '}
                      <CountdownTimer targetIso={rule.next_unlock_at} className="font-semibold" />
                    </div>
                    {rule.next_unlock_at && (
                      <div className="text-xs text-zinc-500 font-mono">
                        at {format(new Date(rule.next_unlock_at), 'HH:mm')}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Status row */}
        {statusData && (
          <div className="flex items-center gap-4 text-xs text-zinc-600">
            <AlertCircle className="w-3.5 h-3.5" />
            <span>Service v{statusData.service.version}</span>
            <span>·</span>
            <span>Uptime: {Math.floor(statusData.service.uptime_seconds / 3600)}h {Math.floor((statusData.service.uptime_seconds % 3600) / 60)}m</span>
            {statusData.service.time_synced && (
              <>
                <span>·</span>
                <span>NTP synced (±{statusData.service.ntp_offset_ms}ms)</span>
              </>
            )}
            <span>·</span>
            <span>{rules.length} rule{rules.length !== 1 ? 's' : ''} total</span>
          </div>
        )}
      </div>
    </div>
  )
}
