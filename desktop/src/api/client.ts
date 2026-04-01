/**
 * client.ts — Renderer-side API client
 *
 * Replaces HTTP fetch calls with Electron IPC calls.
 * The preload bridge (window.api) forwards each call to the Electron main
 * process, which calls the C++ backend via iBridger RPC.
 *
 * All functions preserve the same signatures as the old HTTP client so that
 * existing page/component code needs no changes.
 */

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

// ─── IPC bridge (injected by preload) ─────────────────────────────────────────

declare global {
  interface Window {
    api: {
      getStatus():                                  Promise<unknown>
      listRules():                                  Promise<unknown>
      getRule(id: string):                          Promise<unknown>
      createRule(req: unknown):                     Promise<unknown>
      updateRule(req: unknown):                     Promise<unknown>
      patchRule(req: unknown):                      Promise<unknown>
      deleteRule(id: string):                       Promise<unknown>
      grantOverride(req: unknown):                  Promise<unknown>
      revokeOverride(ruleId: string):               Promise<unknown>
      getUsageToday():                              Promise<unknown>
      getUsageWeek():                               Promise<unknown>
      getBlockAttempts(req?: unknown):              Promise<unknown>
      getProcesses():                               Promise<unknown>
      browseFile():                                 Promise<unknown>
      getConfig():                                  Promise<unknown>
      updateConfig(cfg: unknown):                   Promise<unknown>
    }
  }
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────
// The proto response uses snake_case field names that match the existing
// TypeScript types, so most responses can be returned as-is.

// Map proto Rule message → TypeScript Rule
// Proto omits null fields (uses empty string / 0 instead), so normalise here.
function mapRule(r: Record<string, unknown>): Rule {
  return {
    id:                   String(r.id ?? ''),
    name:                 String(r.name ?? ''),
    exe_name:             String(r.exe_name ?? ''),
    exe_path:             r.exe_path ? String(r.exe_path) : null,
    match_mode:           (r.match_mode as Rule['match_mode']) ?? 'name',
    enabled:              Boolean(r.enabled ?? true),
    daily_limit_minutes:  Number(r.daily_limit_minutes ?? 0) || null,
    schedules:            Array.isArray(r.schedules)
      ? (r.schedules as Array<Record<string, unknown>>).map(mapSchedule)
      : [],
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  }
}

function mapSchedule(s: Record<string, unknown>) {
  return {
    id:                  String(s.id ?? ''),
    rule_id:             String(s.rule_id ?? ''),
    allow_start:         String(s.allow_start ?? ''),
    allow_end:           String(s.allow_end ?? ''),
    days:                Array.isArray(s.days) ? (s.days as number[]) : [],
    warn_before_minutes: Number(s.warn_before_minutes ?? 0),
  }
}

function mapOverride(o: Record<string, unknown>): Override {
  // Proto uses override_info as the field name in GrantOverrideResponse
  const ov = (o.override_info ?? o) as Record<string, unknown>
  return {
    rule_id:          String(ov.rule_id ?? ''),
    granted_at:       String(ov.granted_at ?? ''),
    expires_at:       String(ov.expires_at ?? ''),
    duration_minutes: Number(ov.duration_minutes ?? 0),
    reason:           String(ov.reason ?? ''),
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function getStatus(): Promise<StatusResponse> {
  console.log('[Client] Fetching status via IPC...')
  const raw = (await window.api.getStatus()) as Record<string, unknown>
  console.log('[Client] Raw status response:', raw)

  const svc = (raw.service ?? {}) as Record<string, unknown>
  const rules = Array.isArray(raw.rules) ? raw.rules as Array<Record<string, unknown>> : []

  return {
    service: {
      status:         String(svc.status ?? 'running'),
      version:        String(svc.version ?? ''),
      uptime_seconds: Number(svc.uptime_seconds ?? 0),
      time_synced:    Boolean(svc.time_synced ?? true),
      ntp_offset_ms:  Number(svc.ntp_offset_ms ?? 0),
    },
    rules: rules.map((r) => ({
      rule_id:          String(r.rule_id ?? ''),
      rule_name:        String(r.rule_name ?? ''),
      exe_name:         String(r.exe_name ?? ''),
      enabled:          Boolean(r.enabled ?? true),
      status:           (r.status as 'locked' | 'active' | 'disabled') ?? 'disabled',
      reason:           r.reason ? String(r.reason) : null,
      blocked_since:    r.blocked_since ? String(r.blocked_since) : null,
      next_lock_at:     r.next_lock_at ? String(r.next_lock_at) : null,
      next_unlock_at:   r.next_unlock_at ? String(r.next_unlock_at) : null,
      currently_running: Boolean(r.currently_running ?? false),
      pid:              r.pid ? Number(r.pid) : null,
      session_started:  r.session_started ? String(r.session_started) : null,
      minutes_elapsed:  r.minutes_elapsed ? Number(r.minutes_elapsed) : null,
    })),
  }
}

// ─── Rules ────────────────────────────────────────────────────────────────────

export async function getRules(): Promise<Rule[]> {
  const raw = (await window.api.listRules()) as Record<string, unknown>
  const rules = Array.isArray(raw.rules) ? raw.rules as Array<Record<string, unknown>> : []
  return rules.map(mapRule)
}

export async function getRule(id: string): Promise<Rule> {
  const raw = (await window.api.getRule(id)) as Record<string, unknown>
  return mapRule((raw.rule ?? raw) as Record<string, unknown>)
}

export async function createRule(payload: RulePayload): Promise<Rule> {
  const req = {
    name:                payload.name,
    exe_name:            payload.exe_name,
    exe_path:            payload.exe_path ?? '',
    match_mode:          payload.match_mode,
    enabled:             payload.enabled ?? true,
    daily_limit_minutes: payload.daily_limit_minutes ?? 0,
    schedules:           payload.schedules ?? [],
  }
  const raw = (await window.api.createRule(req)) as Record<string, unknown>
  return mapRule((raw.rule ?? raw) as Record<string, unknown>)
}

export async function updateRule(id: string, payload: RulePayload): Promise<Rule> {
  const req = {
    id,
    name:                payload.name,
    exe_name:            payload.exe_name,
    exe_path:            payload.exe_path ?? '',
    match_mode:          payload.match_mode,
    enabled:             payload.enabled ?? true,
    daily_limit_minutes: payload.daily_limit_minutes ?? 0,
    schedules:           payload.schedules ?? [],
  }
  const raw = (await window.api.updateRule(req)) as Record<string, unknown>
  return mapRule((raw.rule ?? raw) as Record<string, unknown>)
}

export async function patchRule(id: string, patch: RulePatchPayload): Promise<Rule> {
  const req = {
    id,
    has_enabled: patch.enabled !== undefined,
    enabled:     patch.enabled ?? false,
    has_name:    patch.name !== undefined,
    name:        patch.name ?? '',
  }
  const raw = (await window.api.patchRule(req)) as Record<string, unknown>
  return mapRule((raw.rule ?? raw) as Record<string, unknown>)
}

export async function deleteRule(id: string): Promise<void> {
  await window.api.deleteRule(id)
}

// ─── Usage ────────────────────────────────────────────────────────────────────

export async function getUsageToday(): Promise<UsageTodayResponse> {
  const raw = (await window.api.getUsageToday()) as Record<string, unknown>
  const usage = Array.isArray(raw.usage) ? raw.usage as Array<Record<string, unknown>> : []
  return {
    date: String(raw.date ?? ''),
    usage: usage.map((u) => ({
      rule_id:             String(u.rule_id ?? ''),
      rule_name:           String(u.rule_name ?? ''),
      exe_name:            String(u.exe_name ?? ''),
      minutes_used:        Number(u.minutes_used ?? 0),
      daily_limit_minutes: Number(u.daily_limit_minutes ?? 0),
      minutes_remaining:   Number(u.minutes_remaining ?? 0),
      limit_reached:       Boolean(u.limit_reached ?? false),
      sessions: Array.isArray(u.sessions)
        ? (u.sessions as Array<Record<string, unknown>>).map((s) => ({
            started_at:       String(s.started_at ?? ''),
            ended_at:         s.ended_at ? String(s.ended_at) : null,
            duration_minutes: Number(s.duration_minutes ?? 0),
          }))
        : [],
    })),
  }
}

export async function getUsageWeek(): Promise<UsageWeekResponse> {
  const raw = (await window.api.getUsageWeek()) as Record<string, unknown>
  const byRule = Array.isArray(raw.by_rule) ? raw.by_rule as Array<Record<string, unknown>> : []
  const byDay  = Array.isArray(raw.by_day)  ? raw.by_day  as Array<Record<string, unknown>> : []

  return {
    range: String(raw.range ?? 'week'),
    from:  String(raw.from ?? ''),
    to:    String(raw.to ?? ''),
    by_rule: byRule.map((r) => ({
      rule_id:       String(r.rule_id ?? ''),
      rule_name:     String(r.rule_name ?? ''),
      total_minutes: Number(r.total_minutes ?? 0),
      daily_breakdown: Array.isArray(r.daily_breakdown)
        ? (r.daily_breakdown as Array<Record<string, unknown>>).map((d) => ({
            date:         String(d.date ?? ''),
            minutes_used: Number(d.minutes_used ?? 0),
          }))
        : [],
    })),
    by_day: byDay.map((d) => ({
      date:          String(d.date ?? ''),
      total_minutes: Number(d.total_minutes ?? 0),
      rules: Array.isArray(d.rules)
        ? (d.rules as Array<Record<string, unknown>>).map((r) => ({
            rule_id:     String(r.rule_id ?? ''),
            rule_name:   String(r.rule_name ?? ''),
            minutes_used: Number(r.minutes_used ?? 0),
          }))
        : [],
    })),
  }
}

export async function getUsageAttempts(params?: {
  range?: string
  rule_id?: string
  limit?: number
}): Promise<AttemptsResponse> {
  const req = {
    range:   params?.range ?? 'today',
    rule_id: params?.rule_id ?? '',
    limit:   params?.limit ?? 100,
  }
  const raw = (await window.api.getBlockAttempts(req)) as Record<string, unknown>
  const attempts = Array.isArray(raw.attempts) ? raw.attempts as Array<Record<string, unknown>> : []

  return {
    from:  String(raw.from ?? ''),
    to:    String(raw.to ?? ''),
    total: Number(raw.total ?? attempts.length),
    attempts: attempts.map((a) => ({
      id:           String(a.id ?? ''),
      rule_id:      a.rule_id ? String(a.rule_id) : null,
      rule_name:    a.rule_name ? String(a.rule_name) : null,
      exe_path:     a.exe_path ? String(a.exe_path) : null,
      reason:       a.reason ? String(a.reason) : null,
      attempted_at: String(a.attempted_at ?? ''),
    })),
  }
}

// ─── System ──────────────────────────────────────────────────────────────────

export async function getProcesses(): Promise<ProcessInfo[]> {
  const raw = (await window.api.getProcesses()) as Record<string, unknown>
  const procs = Array.isArray(raw.processes) ? raw.processes as Array<Record<string, unknown>> : []
  return procs.map((p) => ({
    pid:       Number(p.pid ?? 0),
    name:      String(p.name ?? ''),
    full_path: String(p.full_path ?? ''),
  }))
}

export async function browseFile(): Promise<BrowseResponse> {
  return (await window.api.browseFile()) as BrowseResponse
}

// ─── Overrides ────────────────────────────────────────────────────────────────

export async function grantOverride(
  id: string,
  minutes: number,
  reason?: string,
): Promise<Override> {
  const req = { rule_id: id, duration_minutes: minutes, reason: reason ?? '' }
  const raw = (await window.api.grantOverride(req)) as Record<string, unknown>
  return mapOverride(raw)
}

export async function cancelOverride(id: string): Promise<void> {
  await window.api.revokeOverride(id)
}
