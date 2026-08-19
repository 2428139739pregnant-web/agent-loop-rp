import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canEvaluateTimedEffect,
  filterTimedEffectCandidates,
  isTimedEffectCoolingDown,
  isTimedEffectStickyActive,
  normalizeTimedEffectState,
  pruneTimedEffectState,
  recordTimedEffectActivations,
  type TimedEffectCandidate,
} from './worldbook-timed-effects.ts'

const entry = (path: string, overrides: Partial<TimedEffectCandidate> = {}): TimedEffectCandidate => ({
  path,
  ...overrides,
})

test('timed effect state normalization is JSON-safe and drops malformed records', () => {
  assert.deepEqual(normalizeTimedEffectState({
    ok: { activatedAt: 2, stickyUntil: 5, cooldownUntil: 7 },
    bad: { activatedAt: '2' },
    empty: null,
  }), {
    ok: { activatedAt: 2, stickyUntil: 5, cooldownUntil: 7 },
  })
})

test('delay blocks activation until the required message count', () => {
  const candidate = entry('delay', { delay: 2 })
  assert.equal(canEvaluateTimedEffect(candidate, {}, 0), false)
  assert.equal(canEvaluateTimedEffect(candidate, {}, 1), false)
  assert.equal(canEvaluateTimedEffect(candidate, {}, 2), true)
})

test('sticky keeps an entry active without refreshing or re-rolling it', () => {
  const candidate = entry('sticky', { sticky: 3, cooldown: 2 })
  const state = recordTimedEffectActivations({}, [candidate], ['sticky'], 1)
  assert.equal(isTimedEffectStickyActive(state, 'sticky', 2), true)
  assert.equal(isTimedEffectStickyActive(state, 'sticky', 4), true)
  assert.equal(isTimedEffectStickyActive(state, 'sticky', 5), false)
  assert.equal(isTimedEffectCoolingDown(state, 'sticky', 5), true)
  assert.equal(isTimedEffectCoolingDown(state, 'sticky', 6), true)
  assert.equal(canEvaluateTimedEffect(candidate, state, 7), true)
  const unchanged = recordTimedEffectActivations(state, [candidate], ['sticky'], 2)
  assert.deepEqual(unchanged, state)
})

test('cooldown blocks only subsequent messages and expires deterministically', () => {
  const candidate = entry('cooldown', { cooldown: 2 })
  const state = recordTimedEffectActivations({}, [candidate], ['cooldown'], 3)
  assert.equal(canEvaluateTimedEffect(candidate, state, 4), false)
  assert.equal(canEvaluateTimedEffect(candidate, state, 5), false)
  assert.equal(canEvaluateTimedEffect(candidate, state, 6), true)
})

test('filter keeps sticky candidates and removes delayed/cooling candidates', () => {
  const candidates = [
    entry('sticky', { sticky: 2 }),
    entry('cooling', { cooldown: 3 }),
    entry('delayed', { delay: 5 }),
  ]
  const state = recordTimedEffectActivations({}, candidates, ['sticky', 'cooling'], 1)
  assert.deepEqual(filterTimedEffectCandidates(candidates, state, 2).map(item => item.path), ['sticky'])
})

test('prune removes stale paths and effects from a rerolled branch', () => {
  const candidates = [entry('live', { sticky: 3 }), entry('removed', { sticky: 3 })]
  const state = recordTimedEffectActivations({}, candidates, ['live', 'removed'], 4)
  assert.deepEqual(pruneTimedEffectState(state, [candidates[0]!], 4), {})
  assert.deepEqual(pruneTimedEffectState(state, [candidates[0]!], 5), { live: state.live })
})
