import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { Loader2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { getRule, updateRule, deleteRule } from '../api/client'
import { RuleForm } from '../components/RuleForm'
import type { RulePayload } from '../types/api'

export function EditRule() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const { data: rule, isLoading, error } = useQuery({
    queryKey: ['rule', id],
    queryFn: () => getRule(id!),
    enabled: !!id,
  })

  const updateMutation = useMutation({
    mutationFn: (payload: RulePayload) => updateRule(id!, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      queryClient.invalidateQueries({ queryKey: ['rule', id] })
      queryClient.invalidateQueries({ queryKey: ['status'] })
      toast.success('Rule updated successfully')
      navigate('/rules')
    },
    onError: (err: Error) => {
      toast.error(`Failed to update rule: ${err.message}`)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteRule(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      queryClient.invalidateQueries({ queryKey: ['status'] })
      toast.success('Rule deleted')
      navigate('/rules')
    },
    onError: () => {
      toast.error('Failed to delete rule')
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-6 h-6 animate-spin text-zinc-400" />
      </div>
    )
  }

  if (error || !rule) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <AlertTriangle className="w-8 h-8 text-red-400" />
        <p className="text-zinc-400">Rule not found</p>
        <button
          onClick={() => navigate('/rules')}
          className="text-sm text-cyan-400 hover:text-cyan-300"
        >
          ← Back to Rules
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <div className="px-8 py-6 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Edit Rule</h1>
          <p className="text-sm text-zinc-500 mt-0.5 font-mono">{rule.name}</p>
        </div>
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-red-400 hover:text-red-300 border border-red-500/20 hover:border-red-500/40 rounded transition-colors"
        >
          Delete Rule
        </button>
      </div>

      <div className="flex-1 p-8 max-w-2xl">
        <RuleForm
          initialRule={rule}
          onSubmit={async (payload) => { await updateMutation.mutateAsync(payload) }}
          onCancel={() => navigate('/rules')}
          submitLabel="Save Changes"
          isSubmitting={updateMutation.isPending}
        />
      </div>

      {/* Delete confirm dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-[#18181b] border border-zinc-700 rounded-lg p-6 max-w-sm w-full mx-4">
            <div className="flex items-center gap-3 mb-3">
              <AlertTriangle className="w-5 h-5 text-red-400" />
              <h3 className="font-semibold text-zinc-100">Delete "{rule.name}"?</h3>
            </div>
            <p className="text-sm text-zinc-400 mb-5">
              This will permanently delete the rule and all its schedules. This action cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 text-sm text-zinc-300 hover:text-zinc-100 border border-zinc-700 rounded hover:border-zinc-500 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm bg-red-500 hover:bg-red-400 text-white rounded font-semibold transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {deleteMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
