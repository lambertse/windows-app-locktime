import type {
  StatusResponse,
  Rule,
  RulePayload,
  RulePatchPayload,
  UsageTodayResponse,
  UsageWeekResponse,
  AttemptsResponse,
  ProcessInfo,
  BrowseResponse,
  Override,
} from '../types/api'

const BASE = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (res.status === 204) return undefined as unknown as T
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data?.error ?? `Request failed: ${res.status}`)
  }
  return data as T
}

// ─── Status ─────────────────────────────────────────────────────────────────

export async function getStatus(): Promise<StatusResponse> {
  return request<StatusResponse>('/status')
}

// ─── Rules ───────────────────────────────────────────────────────────────────

export async function getRules(): Promise<Rule[]> {
  const data = await request<{ rules: Rule[] }>('/rules')
  return data.rules
}

export async function getRule(id: string): Promise<Rule> {
  const data = await request<{ rule: Rule }>(`/rules/${id}`)
  return data.rule
}

export async function createRule(payload: RulePayload): Promise<Rule> {
  const data = await request<{ rule: Rule }>('/rules', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return data.rule
}

export async function updateRule(id: string, payload: RulePayload): Promise<Rule> {
  const data = await request<{ rule: Rule }>(`/rules/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  return data.rule
}

export async function patchRule(id: string, patch: RulePatchPayload): Promise<Rule> {
  const data = await request<{ rule: Rule }>(`/rules/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return data.rule
}

export async function deleteRule(id: string): Promise<void> {
  await request<void>(`/rules/${id}`, { method: 'DELETE' })
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export async function getUsageToday(): Promise<UsageTodayResponse> {
  return request<UsageTodayResponse>('/usage?range=today')
}

export async function getUsageWeek(): Promise<UsageWeekResponse> {
  return request<UsageWeekResponse>('/usage?range=week')
}

export async function getUsageAttempts(params?: {
  range?: string
  rule_id?: string
  limit?: number
}): Promise<AttemptsResponse> {
  const q = new URLSearchParams()
  if (params?.range) q.set('range', params.range)
  if (params?.rule_id) q.set('rule_id', params.rule_id)
  if (params?.limit) q.set('limit', String(params.limit))
  const qs = q.toString() ? `?${q.toString()}` : ''
  return request<AttemptsResponse>(`/usage/attempts${qs}`)
}

// ─── System ──────────────────────────────────────────────────────────────────

export async function getProcesses(): Promise<ProcessInfo[]> {
  const data = await request<{ processes: ProcessInfo[] }>('/system/processes')
  return data.processes
}

export async function browseFile(): Promise<BrowseResponse> {
  return request<BrowseResponse>('/system/browse', {
    method: 'POST',
    body: JSON.stringify({
      filter: 'Executable Files (*.exe)|*.exe|All Files (*.*)|*.*',
    }),
  })
}

// ─── Overrides ───────────────────────────────────────────────────────────────

export async function grantOverride(
  id: string,
  minutes: number,
  reason?: string
): Promise<Override> {
  const data = await request<{ override: Override }>(`/rules/${id}/override`, {
    method: 'POST',
    body: JSON.stringify({ duration_minutes: minutes, reason: reason ?? '' }),
  })
  return data.override
}

export async function cancelOverride(id: string): Promise<void> {
  await request<void>(`/rules/${id}/override`, { method: 'DELETE' })
}
