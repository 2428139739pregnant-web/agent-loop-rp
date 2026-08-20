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

test('generateRaw defaults omitted ordered_prompts to user_input', () => {
  const request = parseTavernGenerateRawRequest({ user_input: '默认发送的问题' })

  assert.deepEqual(request.ordered_prompts, ['user_input'])
  assert.deepEqual(expandTavernGenerateRequest(request), [
    { role: 'user', content: '默认发送的问题' },
  ])
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

test('generateRaw expands depth entries and the chat history author note', () => {
  const request = parseTavernGenerateRawRequest({
    ordered_prompts: ['chat_history'],
    overrides: {
      chat_history: {
        with_depth_entries: true,
        author_note: '保持当前场景的紧张感。',
      },
    },
  })

  assert.deepEqual(expandTavernGenerateRequest(request, {
    chat_history: [{ role: 'user', content: '上一轮用户消息' }],
    chat_history_depth_entries: [{ role: 'system', content: '深度注入条目' }],
    author_note: '不会覆盖显式的 author_note',
  }), [
    { role: 'user', content: '上一轮用户消息' },
    { role: 'system', content: '深度注入条目' },
    { role: 'system', content: '保持当前场景的紧张感。' },
  ])

  const withoutDepthEntries = parseTavernGenerateRawRequest({
    ordered_prompts: ['chat_history'],
    overrides: { chat_history: { with_depth_entries: false } },
  })
  assert.deepEqual(expandTavernGenerateRequest(withoutDepthEntries, {
    chat_history: [{ role: 'user', content: '普通历史' }],
    chat_history_depth_entries: [{ role: 'system', content: '不应展开的深度条目' }],
  }), [
    { role: 'user', content: '普通历史' },
  ])
})

test('generateRaw parses custom_api, tools and tool_choice and forwards supported options', async () => {
  const calls: unknown[] = []
  const provider: LLMProvider = {
    name: 'test-provider',
    async chat(messages, options) {
      calls.push({ messages, options })
      return { content: '工具结果' }
    },
  }
  const request = parseTavernGenerateRawRequest({
    user_input: '查询天气',
    custom_api: {
      proxy_preset: '本地代理预设',
      apiurl: 'https://example.com/v1',
      key: 'test-key',
      model: 'tool-model',
      source: 'openai',
      max_tokens: 'same_as_preset',
      temperature: 0.3,
    },
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: '获取天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  })

  assert.deepEqual(request.custom_api, {
    proxy_preset: '本地代理预设',
    apiurl: 'https://example.com/v1',
    key: 'test-key',
    model: 'tool-model',
    source: 'openai',
    max_tokens: 'same_as_preset',
    temperature: 0.3,
  })
  assert.deepEqual(request.tools, [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取天气',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  }])
  assert.deepEqual(request.tool_choice, {
    type: 'function',
    function: { name: 'get_weather' },
  })

  const result = await generateTavernRaw(provider, request)
  assert.equal(result.content, '工具结果')
  assert.equal(calls.length, 1)
  assert.deepEqual((calls[0] as { options: unknown }).options, {
    model: 'tool-model',
    temperature: 0.3,
    tools: request.tools,
    tool_choice: request.tool_choice,
  })
})

test('generateRaw parses json_schema and rejects mixing it with tools', () => {
  const jsonSchema = {
    name: 'state_update',
    description: '结构化状态更新',
    value: {
      type: 'object',
      properties: { mood: { type: 'string' } },
      required: ['mood'],
      additionalProperties: false,
    },
    strict: true,
  }
  const request = parseTavernGenerateRawRequest({
    user_input: '更新状态',
    json_schema: jsonSchema,
  })

  assert.deepEqual(request.json_schema, jsonSchema)
  assert.throws(() => parseTavernGenerateRawRequest({
    tools: [{
      type: 'function',
      function: { name: 'noop' },
    }],
    json_schema: jsonSchema,
  }), /mutually exclusive/u)
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

test('generateRaw applies session Tavern Helper and Prompt-Template injections after expansion', async () => {
  const calls: unknown[] = []
  const provider: LLMProvider = {
    name: 'test-provider',
    async chat(messages) {
      calls.push(messages)
      return { content: '完成' }
    },
  }
  const request = parseTavernGenerateRawRequest({
    user_input: '当前问题',
    ordered_prompts: ['user_input'],
  })

  await generateTavernRaw(provider, request, {
    injected_prompts: [{
      content: '会话注入', position: 'in_prompt', depth: 0, role: 'system', order: 5, shouldScan: false,
    }],
    worldbook_prompt_injections: [{
      path: 'book/规则.md', content: '规则注入', role: 'system', order: 10,
      placement: { kind: 'target', targetRole: 'user', targetIndex: 1, at: 'before' },
    }],
  })

  assert.deepEqual(calls[0], [
    { role: 'system', content: '会话注入' },
    { role: 'system', content: '规则注入' },
    { role: 'user', content: '当前问题' },
  ])
})
