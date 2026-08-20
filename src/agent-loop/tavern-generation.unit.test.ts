import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  expandTavernGenerateRequest,
  generateTavernRaw,
  parseTavernGenerateRawRequest,
} from './tavern-generation.ts'
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

test('generateRaw expands official placeholders, overrides and history limits before one provider call', () => {
  const request = parseTavernGenerateRawRequest({
    user_input: '当前问题',
    ordered_prompts: [
      'char_description',
      'chat_history',
      'user_input',
    ],
    overrides: { char_description: '覆盖角色描述' },
    max_chat_history: 1,
  })
  assert.deepEqual(expandTavernGenerateRequest(request, {
    char_description: '原角色描述',
    chat_history: [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
    ],
  }), [
    { role: 'system', content: '覆盖角色描述' },
    { role: 'assistant', content: '旧回答' },
    { role: 'user', content: '当前问题' },
  ])
})

test('generate injections follow official position, depth, role and order semantics', () => {
  const request = parseTavernGenerateRawRequest({
    user_input: '问题',
    ordered_prompts: ['chat_history', 'user_input'],
    injects: [
      { content: '先验', position: 'in_prompt', role: 'system', order: 10 },
      { content: '深度提示', position: 'in_chat', role: 'assistant', depth: 0, order: 20 },
      { content: '末前提示', position: 'before_prompt', role: 'system', order: 30 },
      { content: '不应发送', position: 'none', role: 'system' },
    ],
  })
  assert.deepEqual(expandTavernGenerateRequest(request, {
    chat_history: [{ role: 'assistant', content: '历史回答' }],
  }), [
    { role: 'system', content: '先验' },
    { role: 'assistant', content: '历史回答' },
    { role: 'system', content: '末前提示' },
    { role: 'user', content: '问题' },
    { role: 'assistant', content: '深度提示' },
  ])
})
