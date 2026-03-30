import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { createRule } from '../api/client'
import { RuleForm } from '../components/RuleForm'
import type { RulePayload } from '../types/api'

export function AddRule() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (payload: RulePayload) => createRule(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rules'] })
      queryClient.invalidateQueries({ queryKey: ['status'] })
      toast.success('Rule created successfully')
      navigate('/rules')
    },
    onError: (err: Error) => {
      toast.error(`Failed to create rule: ${err.message}`)
    },
  })

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <div className="px-8 py-6 border-b border-zinc-800">
        <h1 className="text-xl font-semibold text-zinc-100">Add Rule</h1>
        <p className="text-sm text-zinc-500 mt-0.5">Create a new application lock rule</p>
      </div>

      <div className="flex-1 p-8 max-w-2xl">
        <RuleForm
          onSubmit={async (payload) => { await mutation.mutateAsync(payload) }}
          onCancel={() => navigate('/rules')}
          submitLabel="Create Rule"
          isSubmitting={mutation.isPending}
        />
      </div>
    </div>
  )
}
