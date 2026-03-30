import { useState } from 'react'
import { Loader2, FolderOpen, ArrowRight, ArrowLeft, Save, Lock, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { browseFile } from '../api/client'
import { ProcessPicker } from './ProcessPicker'
import { DayPicker } from './DayPicker'
import { schedulesToBlocks, blocksToSchedules, crossesMidnight } from '../lib/schedule-convert'
import type { BlockWindow } from '../lib/schedule-convert'
import type { Rule, RulePayload, MatchMode } from '../types/api'

export interface RuleFormData {
  name: string
  exe_name: string
  exe_path: string
  match_mode: MatchMode
  enabled: boolean
  // Mode
  mode: 'time_window' | 'daily_limit' | 'both'
  // Time windows — all block windows from all schedules
  blockWindows: BlockWindow[]
  // Daily limit
  daily_limit_hours: number
  daily_limit_mins: number
}

interface RuleFormProps {
  initialRule?: Rule
  onSubmit: (payload: RulePayload) => Promise<void>
  onCancel: () => void
  submitLabel?: string
  isSubmitting?: boolean
}

const DEFAULT_DAYS = [1, 2, 3, 4, 5] // Mon–Fri

const DEFAULT_BLOCK_WINDOW: BlockWindow = {
  block_start: '22:00',
  block_end: '08:00',
  days: DEFAULT_DAYS,
  warn_before_minutes: 0,
}

function defaultFormData(rule?: Rule): RuleFormData {
  if (!rule) {
    return {
      name: '',
      exe_name: '',
      exe_path: '',
      match_mode: 'name',
      enabled: true,
      mode: 'time_window',
      blockWindows: [{ ...DEFAULT_BLOCK_WINDOW }],
      daily_limit_hours: 2,
      daily_limit_mins: 0,
    }
  }

  // Convert ALL schedules → block windows (not just [0])
  const blocks = schedulesToBlocks(rule.schedules)
  const blockWindows = blocks.length > 0 ? blocks : [{ ...DEFAULT_BLOCK_WINDOW }]

  const hasSchedules = rule.schedules.length > 0
  const hasLimit = !!rule.daily_limit_minutes && rule.daily_limit_minutes > 0

  const mode =
    hasSchedules && hasLimit ? 'both' :
    hasLimit ? 'daily_limit' :
    'time_window'

  const totalMins = rule.daily_limit_minutes ?? 0
  return {
    name: rule.name,
    exe_name: rule.exe_name,
    exe_path: rule.exe_path ?? '',   // null guard for nullable exe_path
    match_mode: rule.match_mode,
    enabled: rule.enabled,
    mode,
    blockWindows,
    daily_limit_hours: Math.floor(totalMins / 60),
    daily_limit_mins: totalMins % 60,
  }
}

export function buildPayload(form: RuleFormData): RulePayload {
  const schedules =
    form.mode === 'daily_limit' ? [] : blocksToSchedules(form.blockWindows)

  const daily_limit_minutes =
    form.mode === 'time_window'
      ? 0
      : form.daily_limit_hours * 60 + form.daily_limit_mins

  return {
    name: form.name,
    exe_name: form.exe_name,
    exe_path: form.exe_path || undefined,
    match_mode: form.match_mode,
    enabled: form.enabled,
    daily_limit_minutes,
    schedules,
  }
}

export function RuleForm({ initialRule, onSubmit, onCancel, submitLabel = 'Save Rule', isSubmitting }: RuleFormProps) {
  const [step, setStep] = useState(1)
  const [form, setForm] = useState<RuleFormData>(() => defaultFormData(initialRule))
  const [isBrowsing, setIsBrowsing] = useState(false)

  const update = (patch: Partial<RuleFormData>) => setForm(prev => ({ ...prev, ...patch }))

  const updateBlockWindow = (index: number, patch: Partial<BlockWindow>) => {
    setForm(prev => {
      const updated = prev.blockWindows.map((bw, i) =>
        i === index ? { ...bw, ...patch } : bw
      )
      return { ...prev, blockWindows: updated }
    })
  }

  const addBlockWindow = () => {
    setForm(prev => ({
      ...prev,
      blockWindows: [...prev.blockWindows, { ...DEFAULT_BLOCK_WINDOW }],
    }))
  }

  const removeBlockWindow = (index: number) => {
    setForm(prev => ({
      ...prev,
      blockWindows: prev.blockWindows.filter((_, i) => i !== index),
    }))
  }

  const handleBrowse = async () => {
    setIsBrowsing(true)
    try {
      const result = await browseFile()
      if (!result.cancelled && result.path) {
        const parts = result.path.split(/[\\/]/)
        const exeName = parts[parts.length - 1]
        update({ exe_path: result.path, exe_name: exeName, match_mode: 'path' })
      }
    } catch {
      toast.error('Failed to open file browser')
    } finally {
      setIsBrowsing(false)
    }
  }

  const canProceed =
    form.exe_name.trim().length > 0 && form.name.trim().length > 0

  const handleSubmit = async () => {
    const payload = buildPayload(form)
    await onSubmit(payload)
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Step indicator */}
      <div className="flex items-center gap-3">
        {[1, 2].map(s => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center ${
              step === s
                ? 'bg-cyan-500 text-zinc-900'
                : s < step
                ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
            }`}>
              {s}
            </div>
            <span className={`text-sm ${step === s ? 'text-zinc-100 font-medium' : 'text-zinc-500'}`}>
              {s === 1 ? 'Choose Application' : 'Configure Limits'}
            </span>
            {s < 2 && <span className="text-zinc-700">→</span>}
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="flex flex-col gap-5">
          {/* Name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-300">Rule Name *</label>
            <input
              type="text"
              placeholder="e.g. League of Legends"
              value={form.name}
              onChange={e => update({ name: e.target.value })}
              maxLength={50}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30"
            />
          </div>

          {/* Process picker */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-300">Choose from running processes</label>
            <ProcessPicker
              selectedName={form.exe_name}
              onSelect={proc => update({
                exe_name: proc.name,
                exe_path: proc.full_path,
                match_mode: 'path',
              })}
            />
          </div>

          {/* Manual path */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-300">Or enter exe path manually</label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="e.g. LeagueOfLegends.exe or C:\...\game.exe"
                value={form.exe_path || form.exe_name}
                onChange={e => {
                  const val = e.target.value
                  const isFullPath = val.includes('\\') || val.includes('/')
                  if (isFullPath) {
                    const parts = val.split(/[\\/]/)
                    update({ exe_path: val, exe_name: parts[parts.length - 1], match_mode: 'path' })
                  } else {
                    update({ exe_name: val, exe_path: '', match_mode: 'name' })
                  }
                }}
                className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30 font-mono"
              />
              <button
                type="button"
                onClick={handleBrowse}
                disabled={isBrowsing}
                className="px-3 py-2 border border-zinc-700 rounded text-sm text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition-colors flex items-center gap-1.5"
              >
                {isBrowsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderOpen className="w-4 h-4" />}
                Browse
              </button>
            </div>
          </div>

          {form.exe_name && (
            <div className="flex items-center gap-2 text-xs text-zinc-400 bg-zinc-800/50 rounded p-2.5">
              <span className="text-zinc-500">Selected:</span>
              <span className="font-mono text-zinc-200">{form.exe_name}</span>
              <span className="text-zinc-600">({form.match_mode === 'path' ? 'full path match' : 'name match'})</span>
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-zinc-300 hover:text-zinc-100 border border-zinc-700 rounded hover:border-zinc-500 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canProceed}
              onClick={() => setStep(2)}
              className="px-4 py-2 text-sm bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-900 rounded font-semibold transition-colors flex items-center gap-2"
            >
              Next <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-5">
          <div className="text-sm text-zinc-400">
            Configuring: <span className="text-zinc-100 font-mono font-medium">{form.exe_name}</span>
          </div>

          {/* Mode selector */}
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-zinc-300">Blocking Mode</label>
            <div className="flex flex-col gap-1.5">
              {(['time_window', 'daily_limit', 'both'] as const).map(mode => (
                <label key={mode} className="flex items-start gap-2.5 cursor-pointer group">
                  <input
                    type="radio"
                    name="mode"
                    value={mode}
                    checked={form.mode === mode}
                    onChange={() => update({ mode })}
                    className="mt-0.5 accent-cyan-500"
                  />
                  <div>
                    <div className="text-sm text-zinc-200">
                      {mode === 'time_window' ? 'Time Window' : mode === 'daily_limit' ? 'Daily Limit' : 'Both'}
                    </div>
                    <div className="text-xs text-zinc-500">
                      {mode === 'time_window' ? 'Blocked during certain hours of the day' :
                       mode === 'daily_limit' ? 'Maximum playtime per day' :
                       'Time window restriction AND daily limit'}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Time Window config — list of block windows */}
          {(form.mode === 'time_window' || form.mode === 'both') && (
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-zinc-300">Time Windows (Blocked Hours)</h3>

              {form.blockWindows.map((bw, index) => {
                const midnight = crossesMidnight(bw)
                return (
                  <div key={index} className="flex flex-col gap-3 p-4 rounded-lg bg-zinc-900 border border-zinc-800">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-zinc-500 font-semibold uppercase tracking-wider">
                        Window {index + 1}
                      </span>
                      {form.blockWindows.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeBlockWindow(index)}
                          className="text-zinc-500 hover:text-red-400 transition-colors"
                          title="Remove this window"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-zinc-500">Block from</label>
                        <input
                          type="time"
                          value={bw.block_start}
                          onChange={e => updateBlockWindow(index, { block_start: e.target.value })}
                          className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 font-mono focus:outline-none focus:border-cyan-500/60"
                        />
                      </div>
                      <span className="text-zinc-500 mt-4">to</span>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-zinc-500">Block until</label>
                        <input
                          type="time"
                          value={bw.block_end}
                          onChange={e => updateBlockWindow(index, { block_end: e.target.value })}
                          className="px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 font-mono focus:outline-none focus:border-cyan-500/60"
                        />
                      </div>
                      {midnight && (
                        <span className="text-xs text-amber-400 mt-4">⚠️ Crosses midnight</span>
                      )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs text-zinc-500">Active on days</label>
                      <DayPicker
                        value={bw.days}
                        onChange={days => updateBlockWindow(index, { days })}
                      />
                    </div>

                    <div className="flex items-center gap-3">
                      <label className="text-xs text-zinc-500 shrink-0">Warn before lock (min)</label>
                      <input
                        type="number"
                        min="0"
                        max="60"
                        value={bw.warn_before_minutes}
                        onChange={e => updateBlockWindow(index, { warn_before_minutes: Number(e.target.value) })}
                        className="w-20 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 font-mono focus:outline-none focus:border-cyan-500/60"
                      />
                      <span className="text-xs text-zinc-600">(0 = no warning)</span>
                    </div>
                  </div>
                )
              })}

              <button
                type="button"
                onClick={addBlockWindow}
                className="flex items-center gap-2 px-3 py-2 text-sm text-cyan-400 border border-cyan-500/30 rounded hover:border-cyan-500/60 hover:bg-cyan-500/5 transition-colors self-start"
              >
                <Plus className="w-4 h-4" />
                Add another time window
              </button>
            </div>
          )}

          {/* Daily Limit config */}
          {(form.mode === 'daily_limit' || form.mode === 'both') && (
            <div className="flex flex-col gap-3 p-4 rounded-lg bg-zinc-900 border border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-300">Daily Limit</h3>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={form.daily_limit_hours}
                  onChange={e => update({ daily_limit_hours: Number(e.target.value) })}
                  className="w-16 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 font-mono focus:outline-none focus:border-cyan-500/60"
                />
                <span className="text-xs text-zinc-400">hrs</span>
                <input
                  type="number"
                  min="0"
                  max="59"
                  value={form.daily_limit_mins}
                  onChange={e => update({ daily_limit_mins: Number(e.target.value) })}
                  className="w-16 px-2 py-1.5 bg-zinc-800 border border-zinc-700 rounded text-sm text-zinc-100 font-mono focus:outline-none focus:border-cyan-500/60"
                />
                <span className="text-xs text-zinc-400">min per day</span>
              </div>
              <p className="text-xs text-zinc-600">Resets at midnight (00:00 local time)</p>
            </div>
          )}

          {/* PIN feature — disabled */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-900 border border-zinc-800 opacity-50">
            <Lock className="w-4 h-4 text-zinc-500" />
            <div className="flex-1">
              <div className="text-sm text-zinc-400">PIN override protection</div>
              <div className="text-xs text-zinc-600">Coming in v2</div>
            </div>
            <div className="relative w-10 h-[22px] bg-zinc-700 rounded-full cursor-not-allowed">
              <span className="absolute top-0.5 left-0.5 w-4 h-4 bg-zinc-500 rounded-full" />
            </div>
          </div>

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="px-4 py-2 text-sm text-zinc-300 hover:text-zinc-100 border border-zinc-700 rounded hover:border-zinc-500 transition-colors flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting}
              className="px-4 py-2 text-sm bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed text-zinc-900 rounded font-semibold transition-colors flex items-center gap-2"
            >
              {isSubmitting ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
              ) : (
                <><Save className="w-4 h-4" /> {submitLabel}</>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
