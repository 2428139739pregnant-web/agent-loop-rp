import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateTavernRaw, parseTavernGenerateRawRequest } from './tavern-generation.ts'
import type { LLMProvider } from './provider.ts'

test('generateRaw preserves ordered prompts and calls the provider exactly once', async () => {
  const calls: unknown[] = []
  const provider: LLMProvider = {
    name: 'test-provider',
    async chat(messages, options) {
      calls.push({ messages, options })
      return { content: '辅助结果', usage: { prompt_tokens: 12, completion_tokens: 3 } }
    },
  }
  const request = parseTavernGenerateRawRequest({
    ordered_prompts: [
      { role: 'system', content: '系统' },
      { role: 'user', content: '问题', name: '玩家' },
    ],
    model: 'deepseek-chat',
    temperature: 0.4,
    max_tokens: 128,
  })
  const result = await generateTavernRaw(provider, request)
  assert.equal(result.content, '辅助结果')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    messages: [
      { role: 'system', content: '系统' },
      { role: 'user', content: '问题', name: '玩家' },
    ],
    options: { model: 'deepseek-chat', temperature: 0.4, max_tokens: 128 },
  })
})

test('generateRaw rejects unsupported or oversized prompt input before a provider call', () => {
  assert.throws(() => parseTavernGenerateRawRequest({ ordered_prompts: [{ role: 'tool', content: '不允许' }] }), /role is invalid/u)
  assert.throws(() => parseTavernGenerateRawRequest({ ordered_prompts: [{ role: 'user', content: 'x'.repeat(512 * 1024 + 1) }] }), /too large/u)
  assert.throws(() => parseTavernGenerateRawRequest({ ordered_prompts: [{ role: 'user', content: 'x' }], max_tokens: 0 }), /max_tokens is invalid/u)
})
