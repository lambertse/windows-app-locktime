import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Loader2, Monitor } from 'lucide-react'
import { getProcesses } from '../api/client'
import type { ProcessInfo } from '../types/api'
import { cn } from '../lib/utils'

interface ProcessPickerProps {
  onSelect: (process: ProcessInfo) => void
  selectedName?: string
}

export function ProcessPicker({ onSelect, selectedName }: ProcessPickerProps) {
  const [search, setSearch] = useState('')

  const { data: processes, isLoading, error } = useQuery({
    queryKey: ['processes'],
    queryFn: getProcesses,
    refetchInterval: 5000,
    staleTime: 3000,
  })

  const filtered = (processes ?? []).filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.full_path.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
        <input
          type="text"
          placeholder="Search running processes..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30"
        />
      </div>

      <div className="max-h-52 overflow-y-auto rounded border border-zinc-700 bg-zinc-900">
        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-zinc-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading processes...
          </div>
        )}
        {error && (
          <div className="py-4 text-center text-sm text-red-400">
            Failed to load processes
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="py-4 text-center text-sm text-zinc-500">
            No processes match "{search}"
          </div>
        )}
        {filtered.map(p => (
          <button
            key={p.pid}
            type="button"
            onClick={() => onSelect(p)}
            className={cn(
              'w-full px-3 py-2.5 flex items-start gap-3 text-left hover:bg-zinc-800 transition-colors border-b border-zinc-800 last:border-0',
              selectedName === p.name && 'bg-cyan-500/10 border-l-2 border-l-cyan-500'
            )}
          >
            <Monitor className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-zinc-100 truncate">{p.name}</div>
              <div className="text-xs text-zinc-500 truncate">{p.full_path}</div>
            </div>
            <div className="ml-auto text-xs text-zinc-600 font-mono shrink-0">PID {p.pid}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
