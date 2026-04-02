/**
 * client.test.ts
 *
 * Tests for the renderer-side API client.
 *
 * Strategy: mock window.api (the Electron IPC bridge injected by preload) and
 * feed it proto-shaped responses (snake_case, optional fields).  Each test
 * verifies that the client function returns the correct domain type.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getStatus,
  getRules,
  getRule,
  createRule,
  updateRule,
  patchRule,
  deleteRule,
  grantOverride,
  cancelOverride,
  getUsageToday,
  getUsageWeek,
  getUsageAttempts,
  getProcesses,
} from './client'

// ─── Proto-shaped fixtures ────────────────────────────────────────────────────

const protoSchedule = {
  id: 'sched-1',
  rule_id: 'rule-1',
  days: [1, 2, 3],
  allow_start: '09:00',
  allow_end: '17:00',
  warn_before_minutes: 5,
}

const protoRule = {
  id: 'rule-1',
  name: 'Chrome',
  exe_name: 'chrome.exe',
  exe_path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe',
  match_mode: 'name',
  enabled: true,
  daily_limit_minutes: 120,
  schedules: [protoSchedule],
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-02T00:00:00Z',
}

// ─── Mock setup ───────────────────────────────────────────────────────────────

const mockApi = {
  getStatus: vi.fn(),
  listRules: vi.fn(),
  getRule: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  patchRule: vi.fn(),
  deleteRule: vi.fn(),
  grantOverride: vi.fn(),
  revokeOverride: vi.fn(),
  getUsageToday: vi.fn(),
  getUsageWeek: vi.fn(),
  getBlockAttempts: vi.fn(),
  getProcesses: vi.fn(),
  browseFile: vi.fn(),
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}

Object.defineProperty(global, 'window', {
  value: { api: mockApi },
  writable: true,
})

beforeEach(() => {
  vi.resetAllMocks()
})

// ─── mapRule / mapSchedule ────────────────────────────────────────────────────

describe('getRules — response mapping', () => {
  it('maps proto Rule fields to domain Rule', async () => {
    mockApi.listRules.mockResolvedValue({ rules: [protoRule] })
    const [rule] = await getRules()

    expect(rule.id).toBe('rule-1')
    expect(rule.exe_name).toBe('chrome.exe')
    expect(rule.exe_path).toBe('C:\\Program Files\\Google\\Chrome\\chrome.exe')
    expect(rule.match_mode).toBe('name')
    expect(rule.enabled).toBe(true)
    expect(rule.daily_limit_minutes).toBe(120)
    expect(rule.created_at).toBe('2024-01-01T00:00:00Z')
    expect(rule.updated_at).toBe('2024-01-02T00:00:00Z')
  })

  it('maps nested schedules', async () => {
    mockApi.listRules.mockResolvedValue({ rules: [protoRule] })
    const [rule] = await getRules()
    const [sched] = rule.schedules

    expect(sched.id).toBe('sched-1')
    expect(sched.rule_id).toBe('rule-1')
    expect(sched.days).toEqual([1, 2, 3])
    expect(sched.allow_start).toBe('09:00')
    expect(sched.allow_end).toBe('17:00')
    expect(sched.warn_before_minutes).toBe(5)
  })

  it('returns empty array when rules field is absent', async () => {
    mockApi.listRules.mockResolvedValue({})
    expect(await getRules()).toEqual([])
  })

  it('normalises null exe_path to null', async () => {
    mockApi.listRules.mockResolvedValue({
      rules: [{ ...protoRule, exe_path: null }],
    })
    const [rule] = await getRules()
    expect(rule.exe_path).toBeNull()
  })

  it('normalises zero daily_limit_minutes to null', async () => {
    mockApi.listRules.mockResolvedValue({
      rules: [{ ...protoRule, daily_limit_minutes: 0 }],
    })
    const [rule] = await getRules()
    expect(rule.daily_limit_minutes).toBeNull()
  })

  it('treats absent enabled as false (proto3 default omission)', async () => {
    // proto3 omits bool fields equal to false — absent must not become true
    const { enabled: _enabled, ...ruleWithoutEnabled } = protoRule
    mockApi.listRules.mockResolvedValue({ rules: [ruleWithoutEnabled] })
    const [rule] = await getRules()
    expect(rule.enabled).toBe(false)
  })
})

describe('getRule', () => {
  it('unwraps rule from GetRuleResponse', async () => {
    mockApi.getRule.mockResolvedValue({ rule: protoRule })
    const rule = await getRule('rule-1')
    expect(rule.id).toBe('rule-1')
    expect(mockApi.getRule).toHaveBeenCalledWith('rule-1')
  })
})

// ─── Request construction ─────────────────────────────────────────────────────

describe('createRule — request construction', () => {
  beforeEach(() => {
    mockApi.createRule.mockResolvedValue({ rule: protoRule })
  })

  it('sends the correct proto request fields', async () => {
    await createRule({
      name: 'Chrome',
      exe_name: 'chrome.exe',
      exe_path: 'C:\\chrome.exe',
      match_mode: 'name',
      enabled: true,
      daily_limit_minutes: 60,
      schedules: [{ days: [1], allow_start: '09:00', allow_end: '17:00', warn_before_minutes: 0 }],
    })

    expect(mockApi.createRule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Chrome',
        exe_name: 'chrome.exe',
        exe_path: 'C:\\chrome.exe',
        match_mode: 'name',
        enabled: true,
        daily_limit_minutes: 60,
      }),
    )
  })

  it('defaults exe_path to empty string when omitted', async () => {
    await createRule({ name: 'X', exe_name: 'x.exe', match_mode: 'name' })
    expect(mockApi.createRule).toHaveBeenCalledWith(expect.objectContaining({ exe_path: '' }))
  })

  it('defaults enabled to true when omitted', async () => {
    await createRule({ name: 'X', exe_name: 'x.exe', match_mode: 'name' })
    expect(mockApi.createRule).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }))
  })

  it('defaults daily_limit_minutes to 0 when omitted', async () => {
    await createRule({ name: 'X', exe_name: 'x.exe', match_mode: 'name' })
    expect(mockApi.createRule).toHaveBeenCalledWith(
      expect.objectContaining({ daily_limit_minutes: 0 }),
    )
  })
})

describe('updateRule — request construction', () => {
  it('includes id in the request', async () => {
    mockApi.updateRule.mockResolvedValue({ rule: protoRule })
    await updateRule('rule-1', { name: 'Chrome', exe_name: 'chrome.exe', match_mode: 'name' })
    expect(mockApi.updateRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rule-1', exe_name: 'chrome.exe' }),
    )
  })
})

describe('patchRule — request construction', () => {
  beforeEach(() => {
    mockApi.patchRule.mockResolvedValue({ rule: protoRule })
  })

  it('sets has_enabled and enabled when patching enabled', async () => {
    await patchRule('rule-1', { enabled: false })
    expect(mockApi.patchRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rule-1', has_enabled: true, enabled: false }),
    )
  })

  it('sets has_name and name when patching name', async () => {
    await patchRule('rule-1', { name: 'Firefox' })
    expect(mockApi.patchRule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rule-1', has_name: true, name: 'Firefox' }),
    )
  })

  it('sets has_enabled=false when enabled is not in patch', async () => {
    await patchRule('rule-1', { name: 'Firefox' })
    expect(mockApi.patchRule).toHaveBeenCalledWith(expect.objectContaining({ has_enabled: false }))
  })
})

describe('deleteRule', () => {
  it('calls IPC with the rule id', async () => {
    mockApi.deleteRule.mockResolvedValue({})
    await deleteRule('rule-1')
    expect(mockApi.deleteRule).toHaveBeenCalledWith('rule-1')
  })
})

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('getStatus — response mapping', () => {
  it('maps ServiceInfo fields', async () => {
    mockApi.getStatus.mockResolvedValue({
      service: {
        status: 'running',
        version: '1.0.0',
        uptime_seconds: 300,
        time_synced: true,
        ntp_offset_ms: 12,
      },
      rules: [],
    })
    const { service } = await getStatus()
    expect(service.status).toBe('running')
    expect(service.version).toBe('1.0.0')
    expect(service.uptime_seconds).toBe(300)
    expect(service.time_synced).toBe(true)
    expect(service.ntp_offset_ms).toBe(12)
  })

  it('maps RuleStatusEntry fields', async () => {
    mockApi.getStatus.mockResolvedValue({
      service: {},
      rules: [
        {
          rule_id: 'rule-1',
          rule_name: 'Chrome',
          exe_name: 'chrome.exe',
          enabled: true,
          status: 'locked',
          reason: 'outside_schedule',
          blocked_since: '2024-01-01T10:00:00Z',
          next_unlock_at: '2024-01-01T17:00:00Z',
          currently_running: false,
          pid: 0,
          session_started: null,
          minutes_elapsed: null,
        },
      ],
    })
    const { rules } = await getStatus()
    expect(rules[0].rule_id).toBe('rule-1')
    expect(rules[0].status).toBe('locked')
    expect(rules[0].reason).toBe('outside_schedule')
    expect(rules[0].blocked_since).toBe('2024-01-01T10:00:00Z')
    expect(rules[0].pid).toBeNull()
  })

  it('returns empty rules array when absent', async () => {
    mockApi.getStatus.mockResolvedValue({ service: {} })
    const { rules } = await getStatus()
    expect(rules).toEqual([])
  })

  it('converts int64 Long object for uptime_seconds', async () => {
    // protobufjs decodes int64 as a Long object when transmitted over IPC
    mockApi.getStatus.mockResolvedValue({
      service: { uptime_seconds: { low: 55, high: 0, unsigned: false } },
    })
    const { service } = await getStatus()
    expect(service.uptime_seconds).toBe(55)
  })

  it('treats absent enabled in RuleStatusEntry as false', async () => {
    mockApi.getStatus.mockResolvedValue({
      service: {},
      rules: [{ rule_id: 'r1', rule_name: 'X', exe_name: 'x.exe', status: 'disabled' }],
    })
    const { rules } = await getStatus()
    expect(rules[0].enabled).toBe(false)
  })
})

// ─── Overrides ────────────────────────────────────────────────────────────────

describe('grantOverride — request construction', () => {
  it('sends snake_case proto request fields', async () => {
    mockApi.grantOverride.mockResolvedValue({
      override_info: {
        rule_id: 'rule-1',
        granted_at: '2024-01-01T10:00:00Z',
        expires_at: '2024-01-01T11:00:00Z',
        duration_minutes: 60,
        reason: 'break',
      },
    })
    const ov = await grantOverride('rule-1', 60, 'break')
    expect(mockApi.grantOverride).toHaveBeenCalledWith({
      rule_id: 'rule-1',
      duration_minutes: 60,
      reason: 'break',
    })
    expect(ov.rule_id).toBe('rule-1')
    expect(ov.duration_minutes).toBe(60)
    expect(ov.reason).toBe('break')
  })

  it('defaults reason to empty string when omitted', async () => {
    mockApi.grantOverride.mockResolvedValue({ override_info: {} })
    await grantOverride('rule-1', 30)
    expect(mockApi.grantOverride).toHaveBeenCalledWith(expect.objectContaining({ reason: '' }))
  })
})

describe('cancelOverride', () => {
  it('calls revokeOverride with the rule id', async () => {
    mockApi.revokeOverride.mockResolvedValue({})
    await cancelOverride('rule-1')
    expect(mockApi.revokeOverride).toHaveBeenCalledWith('rule-1')
  })
})

// ─── Usage ────────────────────────────────────────────────────────────────────

describe('getUsageToday', () => {
  it('maps UsageEntry and sessions', async () => {
    mockApi.getUsageToday.mockResolvedValue({
      date: '2024-01-01',
      usage: [
        {
          rule_id: 'rule-1',
          rule_name: 'Chrome',
          exe_name: 'chrome.exe',
          minutes_used: 45,
          daily_limit_minutes: 120,
          minutes_remaining: 75,
          limit_reached: false,
          sessions: [
            {
              started_at: '2024-01-01T09:00:00Z',
              ended_at: '2024-01-01T09:30:00Z',
              duration_minutes: 30,
            },
          ],
        },
      ],
    })
    const result = await getUsageToday()
    expect(result.date).toBe('2024-01-01')
    expect(result.usage[0].minutes_used).toBe(45)
    expect(result.usage[0].minutes_remaining).toBe(75)
    expect(result.usage[0].sessions[0].duration_minutes).toBe(30)
  })
})

describe('getUsageWeek', () => {
  it('maps by_rule and by_day', async () => {
    mockApi.getUsageWeek.mockResolvedValue({
      range: 'week',
      from: '2024-01-01',
      to: '2024-01-07',
      by_rule: [
        {
          rule_id: 'rule-1',
          rule_name: 'Chrome',
          total_minutes: 300,
          daily_breakdown: [{ date: '2024-01-01', minutes_used: 60 }],
        },
      ],
      by_day: [
        {
          date: '2024-01-01',
          total_minutes: 90,
          rules: [{ rule_id: 'rule-1', rule_name: 'Chrome', minutes_used: 60 }],
        },
      ],
    })
    const result = await getUsageWeek()
    expect(result.by_rule[0].total_minutes).toBe(300)
    expect(result.by_rule[0].daily_breakdown[0].minutes_used).toBe(60)
    expect(result.by_day[0].total_minutes).toBe(90)
    expect(result.by_day[0].rules[0].rule_id).toBe('rule-1')
  })
})

describe('getUsageAttempts', () => {
  it('sends snake_case request and maps attempts', async () => {
    mockApi.getBlockAttempts.mockResolvedValue({
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-01T23:59:59Z',
      total: 1,
      attempts: [
        {
          id: 'att-1',
          rule_id: 'rule-1',
          rule_name: 'Chrome',
          exe_path: 'C:\\chrome.exe',
          reason: 'outside_schedule',
          attempted_at: '2024-01-01T08:00:00Z',
        },
      ],
    })
    const result = await getUsageAttempts({ range: 'today', rule_id: 'rule-1', limit: 50 })
    expect(mockApi.getBlockAttempts).toHaveBeenCalledWith(
      expect.objectContaining({ range: 'today', rule_id: 'rule-1', limit: 50 }),
    )
    expect(result.attempts[0].rule_id).toBe('rule-1')
    expect(result.attempts[0].attempted_at).toBe('2024-01-01T08:00:00Z')
  })

  it('defaults range, rule_id, limit when params omitted', async () => {
    mockApi.getBlockAttempts.mockResolvedValue({ attempts: [] })
    await getUsageAttempts()
    expect(mockApi.getBlockAttempts).toHaveBeenCalledWith({
      range: 'today',
      rule_id: '',
      limit: 100,
    })
  })
})

// ─── System ───────────────────────────────────────────────────────────────────

describe('getProcesses', () => {
  it('maps ProcessInfo fields', async () => {
    mockApi.getProcesses.mockResolvedValue({
      processes: [{ pid: 1234, name: 'chrome.exe', full_path: 'C:\\chrome.exe' }],
    })
    const procs = await getProcesses()
    expect(procs[0].pid).toBe(1234)
    expect(procs[0].name).toBe('chrome.exe')
    expect(procs[0].full_path).toBe('C:\\chrome.exe')
  })

  it('returns empty array when processes is absent', async () => {
    mockApi.getProcesses.mockResolvedValue({})
    expect(await getProcesses()).toEqual([])
  })
})
