import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { BarChart2, Shield, AlertOctagon, Loader2 } from 'lucide-react'
import { getUsageToday, getUsageWeek, getUsageAttempts } from '../api/client'
import { UsageBar } from '../components/UsageBar'

// Colors for rule bars (cycle through these)
const RULE_COLORS = [
  '#22d3ee', // cyan
  '#f59e0b', // amber
  '#a78bfa', // violet
  '#34d399', // emerald
  '#f87171', // red
  '#60a5fa', // blue
  '#fb923c', // orange
]

function formatMinutes(m: number): string {
  const h = Math.floor(m / 60)
  const min = m % 60
  if (h === 0) return `${min}m`
  if (min === 0) return `${h}h`
  return `${h}h ${min}m`
}

const reasonLabels: Record<string, string> = {
  outside_schedule: 'Outside schedule',
  daily_limit_reached: 'Daily limit reached',
  both: 'Schedule + limit',
}

export function Stats() {
  const { data: todayData, isLoading: todayLoading } = useQuery({
    queryKey: ['usage-today'],
    queryFn: getUsageToday,
    refetchInterval: 30000,
    staleTime: 15000,
  })

  const { data: weekData, isLoading: weekLoading } = useQuery({
    queryKey: ['usage-week'],
    queryFn: getUsageWeek,
    staleTime: 60000,
  })

  const { data: attemptsData, isLoading: attemptsLoading } = useQuery({
    queryKey: ['attempts-today'],
    queryFn: () => getUsageAttempts({ range: 'today' }),
    refetchInterval: 30000,
    staleTime: 15000,
  })

  // Build Recharts data from by_day[]
  const chartData = (weekData?.by_day ?? []).map(day => {
    const entry: Record<string, string | number> = {
      date: format(parseISO(day.date), 'EEE'),
      total: day.total_minutes,
    }
    for (const r of day.rules) {
      entry[r.rule_name] = r.minutes_used
    }
    return entry
  })

  // Collect unique rule names for stacked bars
  const ruleNames = Array.from(
    new Set((weekData?.by_day ?? []).flatMap(d => d.rules.map(r => r.rule_name)))
  )

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    return (
      <div className="bg-zinc-900 border border-zinc-700 rounded p-2.5 text-xs">
        <div className="font-semibold text-zinc-200 mb-1.5">{label}</div>
        {payload.map((p: any) => (
          <div key={p.name} className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full" style={{ background: p.fill }} />
            <span className="text-zinc-400">{p.name}:</span>
            <span className="text-zinc-100 font-mono">{formatMinutes(p.value)}</span>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <div className="px-8 py-6 border-b border-zinc-800">
        <h1 className="text-xl font-semibold text-zinc-100">Usage Stats</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Track how much time you spend in locked apps</p>
      </div>

      <div className="flex-1 p-8 flex flex-col gap-8">

        {/* TODAY'S USAGE */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <BarChart2 className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-zinc-200 uppercase tracking-wider">
              Today — {format(new Date(), 'EEE d MMM')}
            </h2>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-[#18181b] p-5">
            {todayLoading && (
              <div className="flex justify-center py-6">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
              </div>
            )}
            {!todayLoading && (!todayData || todayData.usage.length === 0) && (
              <p className="text-sm text-zinc-500 text-center py-6">No usage recorded today</p>
            )}
            {todayData?.usage.map(entry => (
              <div key={entry.rule_id} className="flex flex-col gap-2 mb-4 last:mb-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-zinc-200">{entry.rule_name}</span>
                  <span className="text-xs text-zinc-500 font-mono">{entry.exe_name}</span>
                </div>
                <UsageBar
                  minutesUsed={entry.minutes_used}
                  dailyLimitMinutes={entry.daily_limit_minutes || null}
                />
                <div className="text-xs text-zinc-600">
                  {entry.sessions.length} session{entry.sessions.length !== 1 ? 's' : ''} today
                  {entry.limit_reached && (
                    <span className="ml-2 text-red-400 font-semibold">• LIMIT REACHED</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* WEEKLY CHART */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <BarChart2 className="w-4 h-4 text-violet-400" />
            <h2 className="text-sm font-semibold text-zinc-200 uppercase tracking-wider">
              This Week
              {weekData && (
                <span className="text-zinc-500 font-normal ml-2 text-xs normal-case">
                  ({weekData.from} – {weekData.to})
                </span>
              )}
            </h2>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-[#18181b] p-5">
            {weekLoading && (
              <div className="flex justify-center py-6">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
              </div>
            )}
            {!weekLoading && chartData.length === 0 && (
              <p className="text-sm text-zinc-500 text-center py-6">No data for this week</p>
            )}
            {chartData.length > 0 && (
              <>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#71717a', fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tickFormatter={(v) => `${Math.floor(v / 60)}h`}
                      tick={{ fill: '#71717a', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                      width={30}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend
                      wrapperStyle={{ fontSize: '12px', color: '#71717a', paddingTop: '8px' }}
                    />
                    {ruleNames.map((name, i) => (
                      <Bar
                        key={name}
                        dataKey={name}
                        stackId="a"
                        fill={RULE_COLORS[i % RULE_COLORS.length]}
                        radius={i === ruleNames.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>

                {/* Per-rule weekly totals */}
                <div className="mt-4 pt-4 border-t border-zinc-800 flex flex-col gap-2">
                  {weekData?.by_rule.map((r, i) => (
                    <div key={r.rule_id} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-sm shrink-0"
                          style={{ background: RULE_COLORS[i % RULE_COLORS.length] }}
                        />
                        <span className="text-zinc-300">{r.rule_name}</span>
                      </div>
                      <span className="font-mono text-zinc-400">{formatMinutes(r.total_minutes)} this week</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>

        {/* BLOCKED ATTEMPTS */}
        <section>
          <div className="flex items-center gap-2 mb-4">
            <Shield className="w-4 h-4 text-red-400" />
            <h2 className="text-sm font-semibold text-zinc-200 uppercase tracking-wider">Blocked Attempts</h2>
            {attemptsData && attemptsData.total > 0 && (
              <span className="bg-red-500/20 text-red-400 border border-red-500/30 text-xs font-bold px-2 py-0.5 rounded animate-pulse">
                {attemptsData.total}
              </span>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-[#18181b] p-5">
            {attemptsLoading && (
              <div className="flex justify-center py-6">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
              </div>
            )}
            {!attemptsLoading && (!attemptsData || attemptsData.total === 0) && (
              <p className="text-sm text-zinc-500 text-center py-6">No blocked attempts today 🟢</p>
            )}
            {attemptsData && attemptsData.attempts.length > 0 && (
              <div className="flex flex-col divide-y divide-zinc-800">
                {attemptsData.attempts.map(attempt => (
                  <div key={attempt.id} className="py-2.5 flex items-center gap-3">
                    <AlertOctagon className="w-4 h-4 text-red-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-zinc-200 font-medium">
                        {attempt.rule_name ?? <span className="text-zinc-500 italic">Unknown rule</span>}
                      </div>
                      <div className="text-xs text-zinc-500 font-mono truncate">
                        {attempt.exe_path ?? <span className="text-zinc-600 italic">—</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs text-red-400">
                        {attempt.reason ? (reasonLabels[attempt.reason] ?? attempt.reason) : '—'}
                      </div>
                      <div className="text-xs text-zinc-600 font-mono">
                        {format(parseISO(attempt.attempted_at), 'HH:mm:ss')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

      </div>
    </div>
  )
}
