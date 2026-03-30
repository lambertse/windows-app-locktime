import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Plus, Edit2, Trash2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { getRules, getStatus, patchRule, deleteRule } from '../api/client'
import { RuleStatusBadge } from '../components/RuleStatusBadge'
import { CountdownTimer } from '../components/CountdownTimer'
import { ServiceStatusBanner } from '../components/ServiceStatusBanner'
import { schedulesToBlocks, formatTime } from '../lib/schedule-convert'
import type { Rule, RuleStatus, RuleStatusEntry } from '../types/api'

function StatusLabel({ statusEntry }: { statusEntry?: RuleStatusEntry }) {
  if (!statusEntry) return <span className="text-xs text-zinc-500">—</span>

  if (statusEntry.status === 'disabled') {
    return <span className="text-xs text-zinc-500">Disabled</span>
  }
  if (statusEntry.status === 'locked') {
    return (
      <div className="text-xs">
        <span className="text-red-400 font-semibold">LOCKED NOW</span>
        {statusEntry.next_unlock_at && (
          <CountdownTimer
            targetIso={statusEntry.next_unlock_at}
            prefix=" — unlocks in "
            className="text-zinc-400"
          />
        )}
      </div>
    )
  }
  if (statusEntry.status === 'active') {
    if (statusEntry.next_lock_at) {
      return (
        <div className="text-xs text-zinc-300">
          <span className="text-green-400">Active</span>
          <CountdownTimer
            targetIso={statusEntry.next_lock_at}
            prefix=" — locks in "
            className="text-amber-400"
          />
        </div>
      )
    }
    return <span className="text-xs text-green-400">Active (no upcoming lock)</span>
  }
  return <span className="text-xs text-zinc-500">—</span>
}

export function Rules() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['rules'],
    queryFn: getRules,
    staleTime: 10000,
  })

  const { data: statusData, isError: statusError } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 10000,
    staleTime: 5000,
    retry: 1,
  })

  const serviceStatus = statusError ? 'unreachable' : (statusData?.service?.status ?? 'unknown')

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      patchRule(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: ['rules'] })
      const prev = queryClient.getQueryData<Rule[]>(['rules'])
      queryClient.setQueryData<Rule[]>(['rules'], old =>
        old?.map(r => r.id === id ? { ...r, enabled } : r) ?? []
      )
      return { prev }
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) queryClient.setQueryData(['rules'], context.prev)
      toast.error('Failed to update rule')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      queryClient.invalidateQueries({ queryKey: ['status'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: deleteRule,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      queryClient.invalidateQueries({ queryKey: ['status'] })
      setDeleteConfirmId(null)
      toast.success('Rule deleted')
    },
    onError: () => toast.error('Failed to delete rule'),
  })

  const statusMap = new Map<string, RuleStatusEntry>()
  for (const entry of statusData?.rules ?? []) {
    statusMap.set(entry.rule_id, entry)
  }

  return (
    <div className="flex flex-col min-h-screen">
      <ServiceStatusBanner status={serviceStatus} />

      {/* Header */}
      <div className="px-8 py-6 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">App Rules</h1>
          <p className="text-sm text-zinc-500 mt-0.5">Manage your application lock rules</p>
        </div>
        <button
          onClick={() => navigate('/rules/new')}
          className="flex items-center gap-2 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-900 rounded font-semibold text-sm transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Rule
        </button>
      </div>

      <div className="flex-1 p-8">
        {isLoading && (
          <div className="text-center py-12 text-zinc-500">Loading rules...</div>
        )}

        {!isLoading && rules.length === 0 && (
          <div className="text-center py-16">
            <div className="text-5xl mb-4">🛡️</div>
            <p className="text-zinc-400 mb-2">No rules yet — add your first app</p>
            <button
              onClick={() => navigate('/rules/new')}
              className="mt-4 flex items-center gap-2 px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-zinc-900 rounded font-semibold text-sm transition-colors mx-auto"
            >
              <Plus className="w-4 h-4" />
              Add Rule
            </button>
          </div>
        )}

        {rules.length > 0 && (
          <div className="flex flex-col gap-3">
            {rules.map(rule => {
              const statusEntry = statusMap.get(rule.id)
              const ruleStatus: RuleStatus = statusEntry?.status ?? 'disabled'
              const blocks = schedulesToBlocks(rule.schedules)
              const blockStr = blocks.length > 0
                ? blocks.map(b => `${formatTime(b.block_start)} – ${formatTime(b.block_end)}`).join(', ')
                : 'All day'

              return (
                <div
                  key={rule.id}
                  className="rounded-lg border border-zinc-800 bg-[#18181b] p-4 flex items-start gap-4"
                >
                  {/* Status indicator dot */}
                  <div className="mt-1">
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      ruleStatus === 'locked' ? 'bg-red-500' :
                      ruleStatus === 'active' ? 'bg-green-500' :
                      'bg-zinc-600'
                    }`} />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-zinc-100">{rule.name}</span>
                      <RuleStatusBadge status={ruleStatus} />
                    </div>
                    <div className="text-xs text-zinc-500 font-mono mt-0.5">{rule.exe_name}</div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
                      <span>Blocked: <span className="text-zinc-300">{blockStr}</span></span>
                      {rule.daily_limit_minutes && rule.daily_limit_minutes > 0 && (
                        <span>Max: <span className="text-zinc-300">{Math.floor(rule.daily_limit_minutes / 60)}h {rule.daily_limit_minutes % 60}m/day</span></span>
                      )}
                      {statusEntry?.currently_running && (
                        <span className="text-green-400">● Running (PID {statusEntry.pid})</span>
                      )}
                    </div>
                    <div className="mt-1.5">
                      <StatusLabel statusEntry={statusEntry} />
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-3 shrink-0">
                    {/* Toggle */}
                    <button
                      role="switch"
                      aria-checked={rule.enabled}
                      onClick={() => toggleMutation.mutate({ id: rule.id, enabled: !rule.enabled })}
                      disabled={toggleMutation.isPending}
                      className={`relative w-10 h-5.5 rounded-full transition-colors outline-none focus:ring-2 focus:ring-cyan-500/50 ${
                        rule.enabled ? 'bg-cyan-500' : 'bg-zinc-700'
                      }`}
                      style={{ height: '22px' }}
                      title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                    >
                      <span
                        className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          rule.enabled ? 'translate-x-5' : 'translate-x-0.5'
                        }`}
                      />
                    </button>

                    <button
                      onClick={() => navigate(`/rules/${rule.id}/edit`)}
                      className="p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700 rounded transition-colors"
                      title="Edit rule"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>

                    <button
                      onClick={() => setDeleteConfirmId(rule.id)}
                      className="p-1.5 text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                      title="Delete rule"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Delete Confirm Dialog */}
        {deleteConfirmId && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-[#18181b] border border-zinc-700 rounded-lg p-6 max-w-sm w-full mx-4">
              <div className="flex items-center gap-3 mb-3">
                <AlertTriangle className="w-5 h-5 text-red-400" />
                <h3 className="font-semibold text-zinc-100">Delete Rule?</h3>
              </div>
              <p className="text-sm text-zinc-400 mb-5">
                This will permanently delete the rule and all its schedules. This action cannot be undone.
              </p>
              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="px-4 py-2 text-sm text-zinc-300 hover:text-zinc-100 border border-zinc-700 rounded hover:border-zinc-500 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deleteMutation.mutate(deleteConfirmId)}
                  disabled={deleteMutation.isPending}
                  className="px-4 py-2 text-sm bg-red-500 hover:bg-red-400 text-white rounded font-semibold transition-colors disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
