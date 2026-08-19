/**
 * Pure, session-safe implementation of SillyTavern World Info timed effects.
 *
 * The state is deliberately independent from the prompt matcher and the UI so
 * rerolls can reuse a snapshot without advancing the clock.  `messageCount`
 * is supplied by the host and must count model-visible chat messages before
 * the current generation starts.
 */

export interface TimedEffectCandidate {
  readonly path: string
  readonly sticky?: number
  readonly cooldown?: number
  readonly delay?: number
}

export interface TimedEffectRecord {
  /** Message count at which the entry was activated. */
  readonly activatedAt: number
  /** Last message count for which sticky behavior remains active. */
  readonly stickyUntil: number | null
  /** Last message count blocked by cooldown. */
  readonly cooldownUntil: number | null
}

export type TimedEffectState = Readonly<Record<string, TimedEffectRecord>>

const MAX_MESSAGES = 1_000_000_000

function nonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(MAX_MESSAGES, Math.max(0, Math.trunc(value)))
}

function normalizeRecord(value: unknown): TimedEffectRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const activatedAt = nonNegativeInteger(record.activatedAt, -1)
  if (activatedAt < 0) return undefined
  const stickyRaw = record.stickyUntil
  const cooldownRaw = record.cooldownUntil
  const stickyUntil = stickyRaw === null || stickyRaw === undefined
    ? null : nonNegativeInteger(stickyRaw, -1)
  const cooldownUntil = cooldownRaw === null || cooldownRaw === undefined
    ? null : nonNegativeInteger(cooldownRaw, -1)
  return {
    activatedAt,
    stickyUntil: stickyUntil !== null && stickyUntil >= 0 ? stickyUntil : null,
    cooldownUntil: cooldownUntil !== null && cooldownUntil >= 0 ? cooldownUntil : null,
  }
}

/** Parse durable state and discard malformed or non-string paths. */
export function normalizeTimedEffectState(value: unknown): TimedEffectState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, TimedEffectRecord> = {}
  for (const [path, raw] of Object.entries(value)) {
    if (path.length === 0) continue
    const record = normalizeRecord(raw)
    if (record !== undefined) result[path] = record
  }
  return result
}

function duration(value: number | undefined): number {
  return nonNegativeInteger(value)
}

/** True when a previous activation keeps this entry sticky at this count. */
export function isTimedEffectStickyActive(
  state: TimedEffectState,
  path: string,
  messageCount: number,
): boolean {
  const record = state[path]
  if (record === undefined || record.stickyUntil === null) return false
  const count = nonNegativeInteger(messageCount)
  return count > record.activatedAt && count <= record.stickyUntil
}

/** True when a previous activation blocks this entry at this count. */
export function isTimedEffectCoolingDown(
  state: TimedEffectState,
  path: string,
  messageCount: number,
): boolean {
  const record = state[path]
  if (record === undefined || record.cooldownUntil === null) return false
  const count = nonNegativeInteger(messageCount)
  const stickyUntil = record.stickyUntil ?? record.activatedAt
  return count > stickyUntil && count <= record.cooldownUntil
}

/** True when a candidate may be evaluated on this generation. */
export function canEvaluateTimedEffect(
  candidate: TimedEffectCandidate,
  state: TimedEffectState,
  messageCount: number,
): boolean {
  const count = nonNegativeInteger(messageCount)
  if (isTimedEffectStickyActive(state, candidate.path, count)) return true
  if (isTimedEffectCoolingDown(state, candidate.path, count)) return false
  return count >= duration(candidate.delay)
}

/** Filter candidates blocked by delay/cooldown while retaining sticky entries. */
export function filterTimedEffectCandidates<T extends TimedEffectCandidate>(
  candidates: readonly T[],
  state: TimedEffectState,
  messageCount: number,
): T[] {
  return candidates.filter(candidate => canEvaluateTimedEffect(candidate, state, messageCount))
}

/**
 * Remove stale paths and effects invalidated by a rollback.  A reroll has the
 * same message count as the generation that created the state; because the
 * chat did not advance, that activation must not survive into the branch.
 */
export function pruneTimedEffectState(
  state: TimedEffectState,
  candidates: readonly TimedEffectCandidate[],
  messageCount: number,
): TimedEffectState {
  const known = new Set(candidates.map(candidate => candidate.path))
  const count = nonNegativeInteger(messageCount)
  const result: Record<string, TimedEffectRecord> = {}
  for (const [path, record] of Object.entries(state)) {
    if (!known.has(path) || record.activatedAt >= count) continue
    if (record.cooldownUntil !== null && record.cooldownUntil < count
      && (record.stickyUntil === null || record.stickyUntil < count)) continue
    result[path] = record
  }
  return result
}

/** Record newly activated entries without refreshing an existing effect. */
export function recordTimedEffectActivations(
  state: TimedEffectState,
  candidates: readonly TimedEffectCandidate[],
  activatedPaths: readonly string[],
  messageCount: number,
): TimedEffectState {
  const count = nonNegativeInteger(messageCount)
  const result: Record<string, TimedEffectRecord> = { ...state }
  const byPath = new Map(candidates.map(candidate => [candidate.path, candidate]))
  for (const path of new Set(activatedPaths)) {
    const candidate = byPath.get(path)
    if (candidate === undefined) continue
    const existing = result[path]
    if (existing !== undefined && existing.activatedAt < count
      && (isTimedEffectStickyActive(result, path, count) || isTimedEffectCoolingDown(result, path, count))) {
      continue
    }
    const sticky = duration(candidate.sticky)
    const cooldown = duration(candidate.cooldown)
    if (sticky === 0 && cooldown === 0) continue
    const stickyUntil = sticky > 0 ? count + sticky : null
    const cooldownUntil = cooldown > 0 ? count + sticky + cooldown : null
    result[path] = { activatedAt: count, stickyUntil, cooldownUntil }
  }
  return result
}
