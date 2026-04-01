/**
 * locktime-rpc.ts
 *
 * Typed iBridger RPC client for the LockTime C++ backend.
 * Runs in the Electron main process (Node.js) — never in the renderer.
 *
 * Transport:
 *   Windows → Named pipe  \\.\pipe\locktime-svc
 *   macOS   → Unix socket /tmp/locktime-svc.sock
 */

import { IBridgerClient } from '@lambertse/ibridger'
import * as protobuf from 'protobufjs'
import path from 'path'
import fs from 'fs'
import { log } from './logger'

// ─── Transport endpoint ───────────────────────────────────────────────────────

export const RPC_ENDPOINT =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\locktime-svc'
    : '/tmp/locktime-svc.sock'

// ─── Proto loading ────────────────────────────────────────────────────────────

// Locate the proto file: in dev it's at repo root, in packaged app it's
// bundled alongside the binary as an extra resource.
function resolveProtoPath(): string {
  const candidates = [
    // Packaged: proto file copied into resources
    path.join(process.resourcesPath ?? '', 'proto', 'locktime', 'locktime.proto'),
    // Development: repo layout
    path.join(__dirname, '..', '..', '..', 'proto', 'locktime', 'locktime.proto'),
    path.join(__dirname, '..', '..', 'proto', 'locktime', 'locktime.proto'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  throw new Error(`locktime.proto not found. Tried:\n${candidates.join('\n')}`)
}

let _root: protobuf.Root | null = null

async function getRoot(): Promise<protobuf.Root> {
  if (_root) return _root
  const protoPath = resolveProtoPath()
  _root = await protobuf.load(protoPath)
  return _root
}

// ─── ProtoType adapter ────────────────────────────────────────────────────────
// protobufjs Type is compatible with iBridger's ProtoType<T> interface.
// We use 'any' here because the generated types are dynamic.

type DynType = protobuf.Type

function lookup(root: protobuf.Root, name: string): DynType {
  return root.lookupType(`locktime.rpc.${name}`)
}

// ─── Client class ─────────────────────────────────────────────────────────────

const SVC = 'locktime.rpc.LockTimeService'

export class LockTimeRPCClient {
  private client: IBridgerClient
  private root: protobuf.Root | null = null

  constructor(endpoint: string = RPC_ENDPOINT) {
    this.client = new IBridgerClient(
      { endpoint },
      { baseDelayMs: 200, maxDelayMs: 10_000, maxAttempts: Infinity,
        onReconnect: () => log.info('RPC client reconnected') },
    );
    this.client.onDisconnect = () => {
      log.warn('RPC client disconnected — will reconnect automatically')
    }
    log.info(`RPC client created — endpoint: ${endpoint}`)
  }

  async connect(): Promise<void> {
    this.root = await getRoot()
    await this.client.connect()
  }

  disconnect(): void {
    this.client.disconnect()
  }

  get isConnected(): boolean {
    return this.client.isConnected
  }

  // ─── Internal helper ─────────────────────────────────────────────────────

  private async call<T extends object>(
    method: string,
    reqTypeName: string,
    respTypeName: string,
    request: object,
  ): Promise<T> {
    if (!this.root) throw new Error('RPC client not connected')
    const reqType = lookup(this.root, reqTypeName)
    const respType = lookup(this.root, respTypeName)

    // Validate and encode request
    const errMsg = reqType.verify(request)
    if (errMsg) throw new Error(`Invalid ${reqTypeName}: ${errMsg}`)
    const reqMsg = reqType.create(request)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const respMsg = await this.client.call(SVC, method, reqMsg, reqType as any, respType as any)

    return respMsg as unknown as T
  }

  // ─── Status ──────────────────────────────────────────────────────────────

  getStatus() {
    return this.call<GetStatusResponse>('GetStatus', 'GetStatusRequest', 'GetStatusResponse', {})
  }

  // ─── Rules ───────────────────────────────────────────────────────────────

  listRules() {
    return this.call<ListRulesResponse>('ListRules', 'ListRulesRequest', 'ListRulesResponse', {})
  }

  getRule(id: string) {
    return this.call<GetRuleResponse>('GetRule', 'GetRuleRequest', 'GetRuleResponse', { id })
  }

  createRule(req: CreateRuleRequest) {
    return this.call<CreateRuleResponse>('CreateRule', 'CreateRuleRequest', 'CreateRuleResponse', req)
  }

  updateRule(req: UpdateRuleRequest) {
    return this.call<UpdateRuleResponse>('UpdateRule', 'UpdateRuleRequest', 'UpdateRuleResponse', req)
  }

  patchRule(req: PatchRuleRequest) {
    console.log('Patching rule:', req)
    return this.call<PatchRuleResponse>('PatchRule', 'PatchRuleRequest', 'PatchRuleResponse', req)
  }

  deleteRule(id: string) {
    return this.call<DeleteRuleResponse>('DeleteRule', 'DeleteRuleRequest', 'DeleteRuleResponse', { id })
  }

  // ─── Overrides ───────────────────────────────────────────────────────────

  grantOverride(req: GrantOverrideRequest) {
    return this.call<GrantOverrideResponse>('GrantOverride', 'GrantOverrideRequest', 'GrantOverrideResponse', req)
  }

  revokeOverride(ruleId: string) {
    return this.call<RevokeOverrideResponse>('RevokeOverride', 'RevokeOverrideRequest', 'RevokeOverrideResponse', {
      rule_id: ruleId,
    })
  }

  // ─── Usage ───────────────────────────────────────────────────────────────

  getUsageToday() {
    return this.call<GetUsageTodayResponse>(
      'GetUsageToday', 'GetUsageTodayRequest', 'GetUsageTodayResponse', {}
    )
  }

  getUsageWeek() {
    return this.call<GetUsageWeekResponse>(
      'GetUsageWeek', 'GetUsageWeekRequest', 'GetUsageWeekResponse', {}
    )
  }

  getBlockAttempts(req: GetBlockAttemptsRequest = {}) {
    return this.call<GetBlockAttemptsResponse>(
      'GetBlockAttempts', 'GetBlockAttemptsRequest', 'GetBlockAttemptsResponse', req
    )
  }

  // ─── System ──────────────────────────────────────────────────────────────

  getProcesses() {
    return this.call<GetProcessesResponse>(
      'GetProcesses', 'GetProcessesRequest', 'GetProcessesResponse', {}
    )
  }

  // ─── Config ──────────────────────────────────────────────────────────────

  getConfig() {
    return this.call<GetConfigResponse>('GetConfig', 'GetConfigRequest', 'GetConfigResponse', {})
  }

  updateConfig(config: Record<string, string>) {
    return this.call<UpdateConfigResponse>(
      'UpdateConfig', 'UpdateConfigRequest', 'UpdateConfigResponse', { config }
    )
  }
}

// ─── Request / Response Types (mirror locktime.proto) ─────────────────────────
// These are plain object types used on the TypeScript side.
// They map 1-to-1 with the proto message fields (snake_case).

export interface SchedulePayload {
  days: number[]
  allow_start: string
  allow_end: string
  warn_before_minutes: number
}

export interface CreateRuleRequest {
  name: string
  exe_name: string
  exe_path?: string
  match_mode: string
  enabled?: boolean
  daily_limit_minutes?: number
  schedules?: SchedulePayload[]
}

export interface UpdateRuleRequest extends CreateRuleRequest {
  id: string
}

export interface PatchRuleRequest {
  id: string
  hasEnabled?: boolean
  enabled?: boolean
  hasName?: boolean
  name?: string
}

export interface GrantOverrideRequest {
  rule_id: string
  duration_minutes: number
  reason?: string
}

export interface GetBlockAttemptsRequest {
  range?: string
  rule_id?: string
  limit?: number
}

// Response types (subset — full shape comes from backend proto)
export type GetStatusResponse      = Record<string, unknown>
export type ListRulesResponse      = Record<string, unknown>
export type GetRuleResponse        = Record<string, unknown>
export type CreateRuleResponse     = Record<string, unknown>
export type UpdateRuleResponse     = Record<string, unknown>
export type PatchRuleResponse      = Record<string, unknown>
export type DeleteRuleResponse     = Record<string, unknown>
export type GrantOverrideResponse  = Record<string, unknown>
export type RevokeOverrideResponse = Record<string, unknown>
export type GetUsageTodayResponse  = Record<string, unknown>
export type GetUsageWeekResponse   = Record<string, unknown>
export type GetBlockAttemptsResponse = Record<string, unknown>
export type GetProcessesResponse   = Record<string, unknown>
export type GetConfigResponse      = Record<string, unknown>
export type UpdateConfigResponse   = Record<string, unknown>
