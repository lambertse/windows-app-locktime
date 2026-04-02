/**
 * client.ts — Renderer-side API client
 *
 * Replaces HTTP fetch calls with Electron IPC calls.
 * The preload bridge (window.api) forwards each call to the Electron main
 * process, which calls the C++ backend via iBridger RPC.
 *
 * All functions preserve the same signatures as the old HTTP client so that
 * existing page/component code needs no changes.
 *
 * Types come from the generated locktime_pb.d.ts (src/generated/).
 * `import type` is erased at compile time — zero runtime cost in the renderer.
 * Field names are snake_case throughout (--keep-case), matching both the proto
 * file and the app's domain types in src/types/api.ts.
 */

import type * as pb from '../generated/locktime_pb'
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
      getStatus(): Promise<unknown>
      listRules(): Promise<unknown>
      getRule(id: string): Promise<unknown>
      createRule(req: unknown): Promise<unknown>
      updateRule(req: unknown): Promise<unknown>
      patchRule(req: unknown): Promise<unknown>
      deleteRule(id: string): Promise<unknown>
      grantOverride(req: unknown): Promise<unknown>
      revokeOverride(ruleId: string): Promise<unknown>
      getUsageToday(): Promise<unknown>
      getUsageWeek(): Promise<unknown>
      getBlockAttempts(req?: unknown): Promise<unknown>
      getProcesses(): Promise<unknown>
      browseFile(): Promise<unknown>
      getConfig(): Promise<unknown>
      updateConfig(cfg: unknown): Promise<unknown>
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// proto3 omits fields equal to their default value from the wire:
//   bool   → false is omitted  (absent means false, NOT true)
//   int64  → 0 is omitted; protobufjs decodes int64 as a Long object when the
//             value is non-zero, so we must handle both number and Long.
function longToNumber(v: unknown): number {
  if (typeof v === 'number') return v
  if (v !== null && typeof v === 'object' && 'low' in v) {
    const { low, high } = v as { low: number; high: number }
    return high * 0x100000000 + (low >>> 0)
  }
  return 0
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────
// Proto field names are snake_case (--keep-case), matching the app's domain
// types directly.  Mapping only normalises optional/nullable proto fields to
// the required fields the components expect.

function mapRule(r: pb.locktime.rpc.IRule): Rule {
  return {
    id: r.id ?? '',
    name: r.name ?? '',
    exe_name: r.exe_name ?? '',
    exe_path: r.exe_path || null,
    match_mode: (r.match_mode as Rule['match_mode']) ?? 'name',
    // proto3: absent bool means false (the default) — never default to true
    enabled: r.enabled ?? false,
    daily_limit_minutes: r.daily_limit_minutes || null,
    schedules: (r.schedules ?? []).map(mapSchedule),
    created_at: r.created_at ?? '',
    updated_at: r.updated_at ?? '',
  }
}

function mapSchedule(s: pb.locktime.rpc.ISchedule) {
  return {
    id: s.id ?? '',
    rule_id: s.rule_id ?? '',
    allow_start: s.allow_start ?? '',
    allow_end: s.allow_end ?? '',
    days: s.days ?? [],
    warn_before_minutes: s.warn_before_minutes ?? 0,
  }
}

function mapOverride(o: pb.locktime.rpc.IGrantOverrideResponse): Override {
  const ov = o.override_info ?? {}
  return {
    rule_id: ov.rule_id ?? '',
    granted_at: ov.granted_at ?? '',
    expires_at: ov.expires_at ?? '',
    duration_minutes: ov.duration_minutes ?? 0,
    reason: ov.reason ?? '',
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function getStatus(): Promise<StatusResponse> {
  const raw = (await window.api.getStatus()) as pb.locktime.rpc.IGetStatusResponse
  console.log('[Client] Fetched status via IPC:', raw)

  const svc = raw.service ?? {}
  return {
    service: {
      status: svc.status ?? 'running',
      version: svc.version ?? '',
      uptime_seconds: longToNumber(svc.uptime_seconds),
      time_synced: svc.time_synced ?? false,
      ntp_offset_ms: longToNumber(svc.ntp_offset_ms),
    },
    rules: (raw.rules ?? []).map((r) => ({
      rule_id: r.rule_id ?? '',
      rule_name: r.rule_name ?? '',
      exe_name: r.exe_name ?? '',
      enabled: r.enabled ?? false,
      status: (r.status as 'locked' | 'active' | 'disabled') ?? 'disabled',
      reason: r.reason || null,
      blocked_since: r.blocked_since || null,
      next_lock_at: r.next_lock_at || null,
      next_unlock_at: r.next_unlock_at || null,
      currently_running: r.currently_running ?? false,
      pid: r.pid || null,
      session_started: r.session_started || null,
      minutes_elapsed: r.minutes_elapsed || null,
    })),
  }
}

// ─── Rules ────────────────────────────────────────────────────────────────────

export async function getRules(): Promise<Rule[]> {
  const raw = (await window.api.listRules()) as pb.locktime.rpc.IListRulesResponse
  console.log('[Client] Fetched rules via IPC:', raw)
  return (raw.rules ?? []).map(mapRule)
}

export async function getRule(id: string): Promise<Rule> {
  const raw = (await window.api.getRule(id)) as pb.locktime.rpc.IGetRuleResponse
  console.log(`[Client] Fetched rule ${id} via IPC:`, raw)
  return mapRule(raw.rule ?? {})
}

export async function createRule(payload: RulePayload): Promise<Rule> {
  const req: pb.locktime.rpc.ICreateRuleRequest = {
    name: payload.name,
    exe_name: payload.exe_name,
    exe_path: payload.exe_path ?? '',
    match_mode: payload.match_mode,
    enabled: payload.enabled ?? true,
    daily_limit_minutes: payload.daily_limit_minutes ?? 0,
    schedules: payload.schedules,
  }
  const raw = (await window.api.createRule(req)) as pb.locktime.rpc.ICreateRuleResponse
  return mapRule(raw.rule ?? {})
}

export async function updateRule(id: string, payload: RulePayload): Promise<Rule> {
  const req: pb.locktime.rpc.IUpdateRuleRequest = {
    id,
    name: payload.name,
    exe_name: payload.exe_name,
    exe_path: payload.exe_path ?? '',
    match_mode: payload.match_mode,
    enabled: payload.enabled ?? true,
    daily_limit_minutes: payload.daily_limit_minutes ?? 0,
    schedules: payload.schedules,
  }
  const raw = (await window.api.updateRule(req)) as pb.locktime.rpc.IUpdateRuleResponse
  return mapRule(raw.rule ?? {})
}

export async function patchRule(id: string, patch: RulePatchPayload): Promise<Rule> {
  const req: pb.locktime.rpc.IPatchRuleRequest = {
    id,
    has_enabled: patch.enabled !== undefined,
    enabled: patch.enabled ?? false,
    has_name: patch.name !== undefined,
    name: patch.name ?? '',
  }
  console.log('[Client] Patching rule via IPC with payload:', req)
  const raw = (await window.api.patchRule(req)) as pb.locktime.rpc.IPatchRuleResponse
  return mapRule(raw.rule ?? {})
}

export async function deleteRule(id: string): Promise<void> {
  await window.api.deleteRule(id)
}

// ─── Usage ────────────────────────────────────────────────────────────────────

export async function getUsageToday(): Promise<UsageTodayResponse> {
  const raw = (await window.api.getUsageToday()) as pb.locktime.rpc.IGetUsageTodayResponse
  return {
    date: raw.date ?? '',
    usage: (raw.usage ?? []).map((u) => ({
      rule_id: u.rule_id ?? '',
      rule_name: u.rule_name ?? '',
      exe_name: u.exe_name ?? '',
      minutes_used: u.minutes_used ?? 0,
      daily_limit_minutes: u.daily_limit_minutes ?? 0,
      minutes_remaining: u.minutes_remaining ?? 0,
      limit_reached: u.limit_reached ?? false,
      sessions: (u.sessions ?? []).map((s) => ({
        started_at: s.started_at ?? '',
        ended_at: s.ended_at || null,
        duration_minutes: s.duration_minutes ?? 0,
      })),
    })),
  }
}

export async function getUsageWeek(): Promise<UsageWeekResponse> {
  const raw = (await window.api.getUsageWeek()) as pb.locktime.rpc.IGetUsageWeekResponse
  return {
    range: raw.range ?? 'week',
    from: raw.from ?? '',
    to: raw.to ?? '',
    by_rule: (raw.by_rule ?? []).map((r) => ({
      rule_id: r.rule_id ?? '',
      rule_name: r.rule_name ?? '',
      total_minutes: r.total_minutes ?? 0,
      daily_breakdown: (r.daily_breakdown ?? []).map((d) => ({
        date: d.date ?? '',
        minutes_used: d.minutes_used ?? 0,
      })),
    })),
    by_day: (raw.by_day ?? []).map((d) => ({
      date: d.date ?? '',
      total_minutes: d.total_minutes ?? 0,
      rules: (d.rules ?? []).map((r) => ({
        rule_id: r.rule_id ?? '',
        rule_name: r.rule_name ?? '',
        minutes_used: r.minutes_used ?? 0,
      })),
    })),
  }
}

export async function getUsageAttempts(params?: {
  range?: string
  rule_id?: string
  limit?: number
}): Promise<AttemptsResponse> {
  const req: pb.locktime.rpc.IGetBlockAttemptsRequest = {
    range: params?.range ?? 'today',
    rule_id: params?.rule_id ?? '',
    limit: params?.limit ?? 100,
  }
  const raw = (await window.api.getBlockAttempts(req)) as pb.locktime.rpc.IGetBlockAttemptsResponse
  return {
    from: raw.from ?? '',
    to: raw.to ?? '',
    total: raw.total ?? 0,
    attempts: (raw.attempts ?? []).map((a) => ({
      id: a.id ?? '',
      rule_id: a.rule_id || null,
      rule_name: a.rule_name || null,
      exe_path: a.exe_path || null,
      reason: a.reason || null,
      attempted_at: a.attempted_at ?? '',
    })),
  }
}

// ─── System ──────────────────────────────────────────────────────────────────

export async function getProcesses(): Promise<ProcessInfo[]> {
  const raw = (await window.api.getProcesses()) as pb.locktime.rpc.IGetProcessesResponse
  return (raw.processes ?? []).map((p) => ({
    pid: p.pid ?? 0,
    name: p.name ?? '',
    full_path: p.full_path ?? '',
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
  const req: pb.locktime.rpc.IGrantOverrideRequest = {
    rule_id: id,
    duration_minutes: minutes,
    reason: reason ?? '',
  }
  const raw = (await window.api.grantOverride(req)) as pb.locktime.rpc.IGrantOverrideResponse
  return mapOverride(raw)
}

export async function cancelOverride(id: string): Promise<void> {
  await window.api.revokeOverride(id)
}
