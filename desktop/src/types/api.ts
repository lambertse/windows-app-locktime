export type RuleStatus = 'locked' | 'active' | 'disabled'
export type MatchMode = 'name' | 'path'

export interface Schedule {
  id: string
  rule_id: string
  allow_start: string // "HH:MM" 24h
  allow_end: string   // "HH:MM" 24h
  days: number[]      // 0=Sunday, 1=Monday, ..., 6=Saturday
  warn_before_minutes: number
}

export interface Rule {
  id: string            // UUID
  name: string
  exe_name: string
  exe_path: string | null
  match_mode: MatchMode
  daily_limit_minutes: number | null
  enabled: boolean
  schedules: Schedule[]
  created_at: string
  updated_at: string
}

export interface RuleStatusEntry {
  rule_id: string
  rule_name: string
  exe_name: string
  enabled: boolean
  status: RuleStatus
  reason: string | null
  blocked_since: string | null
  next_lock_at: string | null
  next_unlock_at: string | null
  currently_running: boolean
  pid: number | null
  session_started: string | null
  minutes_elapsed: number | null
}

export interface ServiceInfo {
  status: string // "running" | "stopped"
  version: string
  uptime_seconds: number
  time_synced: boolean
  ntp_offset_ms: number
}

export interface StatusResponse {
  service: ServiceInfo
  rules: RuleStatusEntry[]
}

// Usage Today
export interface UsageSession {
  started_at: string
  ended_at: string | null
  duration_minutes: number
}

export interface UsageEntry {
  rule_id: string
  rule_name: string
  exe_name: string
  minutes_used: number
  daily_limit_minutes: number
  minutes_remaining: number
  limit_reached: boolean
  sessions: UsageSession[]
}

export interface UsageTodayResponse {
  date: string
  usage: UsageEntry[]
}

// Usage Week
export interface DailyBreakdown {
  date: string
  minutes_used: number
}

export interface ByRuleEntry {
  rule_id: string
  rule_name: string
  total_minutes: number
  daily_breakdown: DailyBreakdown[]
}

export interface ByDayRuleEntry {
  rule_id: string
  rule_name: string
  minutes_used: number
}

export interface ByDayEntry {
  date: string
  total_minutes: number
  rules: ByDayRuleEntry[]
}

export interface UsageWeekResponse {
  range: string
  from: string
  to: string
  by_rule: ByRuleEntry[]
  by_day: ByDayEntry[]
}

// Blocked Attempts
export interface BlockAttempt {
  id: string
  rule_id: string | null
  rule_name: string | null
  exe_path: string | null
  reason: string | null
  attempted_at: string
}

export interface AttemptsResponse {
  from: string
  to: string
  total: number
  attempts: BlockAttempt[]
}

// System processes
export interface ProcessInfo {
  pid: number
  name: string
  full_path: string
}

export interface ProcessesResponse {
  processes: ProcessInfo[]
}

export interface BrowseResponse {
  path: string | null
  cancelled: boolean
}

// Override
export interface Override {
  rule_id: string
  granted_at: string
  expires_at: string
  duration_minutes: number
  reason: string
}

// Rule create/update payload
export interface SchedulePayload {
  days: number[]
  allow_start: string
  allow_end: string
  warn_before_minutes: number
}

export interface RulePayload {
  name: string
  exe_name: string
  exe_path?: string
  match_mode: MatchMode
  enabled?: boolean
  daily_limit_minutes?: number
  schedules?: SchedulePayload[]
}

export interface RulePatchPayload {
  enabled?: boolean
  name?: string
}
