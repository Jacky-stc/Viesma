export const PROTOCOL_VERSION = 4

export interface JoinVersion {
  readonly protocolVersion: number
  readonly balanceVersion: string
  readonly mapContentHash: string
}

export type JoinVersionResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: 'PROTOCOL_VERSION_MISMATCH' | 'BALANCE_VERSION_MISMATCH' | 'MAP_CONTENT_HASH_MISMATCH'
    }

/** 以 server 產生的版本為準，檢查尚未信任的 client join payload。 */
export function checkJoinVersion(expected: JoinVersion, offered: unknown): JoinVersionResult {
  if (typeof offered !== 'object' || offered === null || Array.isArray(offered)) {
    return { ok: false, code: 'PROTOCOL_VERSION_MISMATCH' }
  }
  const payload = offered as Partial<Record<keyof JoinVersion, unknown>>
  if (!Object.hasOwn(payload, 'protocolVersion') || payload.protocolVersion !== expected.protocolVersion) {
    return { ok: false, code: 'PROTOCOL_VERSION_MISMATCH' }
  }
  if (!Object.hasOwn(payload, 'balanceVersion') || payload.balanceVersion !== expected.balanceVersion) {
    return { ok: false, code: 'BALANCE_VERSION_MISMATCH' }
  }
  if (!Object.hasOwn(payload, 'mapContentHash') || payload.mapContentHash !== expected.mapContentHash) {
    return { ok: false, code: 'MAP_CONTENT_HASH_MISMATCH' }
  }
  return { ok: true }
}
