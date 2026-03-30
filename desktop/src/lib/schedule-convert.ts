import type { Schedule, SchedulePayload } from '../types/api'

/**
 * Block window — what the user sees in the UI.
 * "Block from 10 PM to 8 AM" = "allow from 8 AM to 10 PM" in the API.
 */
export interface BlockWindow {
  block_start: string // "HH:MM" — start of blocked period (what user sees)
  block_end: string   // "HH:MM" — end of blocked period
  days: number[]      // 0=Sunday, 6=Saturday
  warn_before_minutes: number
}

/**
 * Convert API allow windows → UI block windows.
 * "Allowed 08:00–22:00" → "Blocked 22:00–08:00"
 */
export function schedulesToBlocks(schedules: Schedule[]): BlockWindow[] {
  return schedules.map(s => ({
    block_start: s.allow_end,   // end of allow = start of block
    block_end: s.allow_start,   // start of allow = end of block
    days: s.days,
    warn_before_minutes: s.warn_before_minutes,
  }))
}

/**
 * Convert UI block windows → API allow windows (for POST/PUT payloads).
 * "Blocked 22:00–08:00" → allow_start="08:00", allow_end="22:00"
 */
export function blocksToSchedules(blocks: BlockWindow[]): Omit<SchedulePayload, never>[] {
  return blocks.map(b => ({
    allow_start: b.block_end,   // end of block = start of allow
    allow_end: b.block_start,   // start of block = end of allow
    days: b.days,
    warn_before_minutes: b.warn_before_minutes,
  }))
}

/**
 * Check if a block window crosses midnight (start > end in 24h).
 * e.g. 22:00 → 08:00 crosses midnight.
 */
export function crossesMidnight(block: BlockWindow): boolean {
  const [startH, startM] = block.block_start.split(':').map(Number)
  const [endH, endM] = block.block_end.split(':').map(Number)
  const startTotal = startH * 60 + startM
  const endTotal = endH * 60 + endM
  return startTotal > endTotal
}

/**
 * Format HH:MM in 24h to a readable 12h string (e.g. "10:00 PM").
 */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const period = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${m.toString().padStart(2, '0')} ${period}`
}
