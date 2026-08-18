import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyWorldbookPromptInjections,
  applyWorldbookRenderDirectives,
  buildWorldbookPluginOutput,
  type WorldbookPluginCandidate,
} from './worldbook-plugin.ts'
import type { AgentContext } from './agents/types.ts'
import type { ChatMessage } from './provider.ts'

function makeContext(): AgentContext {
  return {
    provider: {
      name: 'must-not-be-called',
      async chat() { throw new Error('plugin compatibility must not call an LLM') },
    },
    model: 'test',
    temperature: 0,
    prompts: { load: async () => '' },
    session: {
      getHistory: () => [],
      appendMessage: () => undefined,
      setHistory: () => undefined,
      turnCount: () => 0,
      summaryPath: () => '',
    },
    worldbook: { match: () => [], getContent: () => undefined, list: () => [] },
    sessionId: 'plugin-test',
    macros: { user: '小明', char: '莉娜' },
  }
}

function candidate(overrides: Partial<WorldbookPluginCandidate> = {}): WorldbookPluginCandidate {
  return {
    path: 'book/special.md',
    comment: '@INJECT target=user,at=after,role=system',
    content: '提示 {{user}}',
    order: 1,
    weight: 1,
    ...overrides,
  }
}

test('plugin plan handles @INJECT, GENERATE, and RENDER without an LLM call', () => {
  const output = buildWorldbookPluginOutput([
    candidate(),
    candidate({ path: 'book/before.md', comment: '[GENERATE:BEFORE]', content: 'before', order: 2, constant: true }),
    candidate({ path: 'book/render.md', comment: '[RENDER:AFTER]', content: 'status', order: 3, active: true }),
  ], makeContext())

  assert.equal(output.promptInjections.length, 2)
  assert.deepEqual(output.promptInjections[0]?.placement, {
    kind: 'target', targetRole: 'user', targetIndex: 1, at: 'after',
  })
  assert.deepEqual(output.promptInjections[1]?.placement, {
    kind: 'message', messageIndex: 0, at: 'before',
  })
  assert.equal(output.promptInjections[0]?.content, '提示 小明')
  assert.deepEqual(output.renderDirectives, [{
    path: 'book/render.md', content: 'status', order: 3, placement: 'after',
  }])
})

test('generation/render placement respects ST blue-light and green activation rules', () => {
  const output = buildWorldbookPluginOutput([
    candidate({ path: 'green-before', comment: '[GENERATE:BEFORE]', content: 'no', active: true }),
    candidate({ path: 'green-after', comment: '[GENERATE:AFTER]', content: 'yes', active: true }),
    candidate({ path: 'blue-before', comment: '[GENERATE:BEFORE]', content: 'blue', constant: true }),
    candidate({ path: 'green-render-before', comment: '[RENDER:BEFORE]', content: 'no', active: true }),
    candidate({ path: 'green-render-after', comment: '[RENDER:AFTER]', content: 'yes', active: true }),
  ], makeContext())

  assert.deepEqual(output.promptInjections.map(item => item.path), ['blue-before', 'green-after'])
  assert.deepEqual(output.renderDirectives.map(item => item.path), ['green-render-after'])
  assert.ok(output.skipped.some(item => item.path === 'green-before'))
  assert.ok(output.skipped.some(item => item.path === 'green-render-before'))
})

test('prompt injections preserve roles and apply absolute, target, and regex placement', () => {
  const base: ChatMessage[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ]
  const output = applyWorldbookPromptInjections(base, [
    { path: 'absolute', content: 'A', role: 'assistant', order: 1, placement: { kind: 'absolute', position: 0 } },
    { path: 'target', content: 'T', role: 'system', order: 2, placement: { kind: 'target', targetRole: 'user', targetIndex: 1, at: 'before' } },
    { path: 'regex', content: 'R', role: 'system', order: 3, placement: { kind: 'regex', pattern: 'hello', at: 'after' } },
  ])
  assert.deepEqual(output, [
    { role: 'assistant', content: 'A' },
    { role: 'system', content: 'system' },
    { role: 'system', content: 'T' },
    { role: 'user', content: 'hello' },
    { role: 'system', content: 'R' },
  ])
  assert.deepEqual(base, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello' },
  ], 'the resolver must not mutate the base message array')
})

test('render directives stay out of the prompt and only affect display text', () => {
  const reply = applyWorldbookRenderDirectives('正文', [
    { path: 'after', content: '尾部状态', order: 2, placement: 'after' },
    { path: 'before', content: '前置状态', order: 1, placement: 'before' },
  ])
  assert.equal(reply, '前置状态\n\n正文\n\n尾部状态')
})
