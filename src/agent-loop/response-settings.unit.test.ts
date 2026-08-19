import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildResponseSettingsInstruction,
  DEFAULT_RESPONSE_PERSPECTIVES,
  DEFAULT_RESPONSE_SETTINGS,
  normalizeResponseSettings,
  responseMaxTokens,
} from './response-settings.ts'

test('response settings default to following the character card', () => {
  assert.deepEqual(normalizeResponseSettings({}), DEFAULT_RESPONSE_SETTINGS)
  assert.match(buildResponseSettingsInstruction(DEFAULT_RESPONSE_SETTINGS), /跟随角色卡/u)
  assert.equal(responseMaxTokens(DEFAULT_RESPONSE_SETTINGS), undefined)
})

test('response settings normalize POV and ST-style length ranges', () => {
  const settings = normalizeResponseSettings({ perspective: 'third', lengthPreset: 'medium' })
  assert.equal(settings.perspective, 'third')
  assert.equal(settings.minChars, 500)
  assert.equal(settings.maxChars, 900)
  assert.match(buildResponseSettingsInstruction(settings), /第三人称有限/u)
  assert.ok((responseMaxTokens(settings) ?? 0) >= 1_900)
})

test('response settings preserve user-defined POV names and exact prompt text', () => {
  const settings = normalizeResponseSettings({
    perspective: 'my-first',
    perspectives: [
      { id: 'card', name: '跟随卡片', instruction: '' },
      { id: 'my-first', name: '我的第一人称', instruction: '只能使用“俺”自称，并把所有内心感受写成身体感受。' },
    ],
  })
  assert.equal(settings.perspective, 'my-first')
  assert.equal(settings.perspectives.length, 2)
  assert.match(buildResponseSettingsInstruction(settings), /只能使用“俺”自称/u)
})

test('response settings keep the card escape hatch when every option is removed', () => {
  const settings = normalizeResponseSettings({ perspectives: [] })
  assert.deepEqual(settings.perspectives, [DEFAULT_RESPONSE_PERSPECTIVES[0]])
  assert.equal(settings.perspective, 'card')
})

test('custom response ranges are bounded and ordered', () => {
  const settings = normalizeResponseSettings({
    perspective: 'unknown', lengthPreset: 'custom', minChars: 50000, maxChars: 10,
  })
  assert.equal(settings.perspective, 'card')
  assert.equal(settings.minChars, 20_000)
  assert.equal(settings.maxChars, 20_000)
})
