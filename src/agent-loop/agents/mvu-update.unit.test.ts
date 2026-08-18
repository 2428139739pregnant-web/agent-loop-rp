import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runMvuUpdate, type MvuRuntimeSettings } from './mvu-update.ts'
import { InMemoryPromptLoader, type AgentContext } from './types.ts'
import type { ChatMessage, ChatOptions, LLMProvider } from '../provider.ts'
import type { PreprocessedCharacter } from '../character-loader.ts'

function makeCharacter(): PreprocessedCharacter {
  return {
    name: 'Lina',
    raw: {
      lorebook: {
        entries: [{
          sourceId: 'mvu-rule',
          name: '变量更新规则',
          comment: '变量更新规则',
          content: '<update><json_patch>[]</json_patch></update>\n变量更新规则：根据正文更新 /score。',
          enabled: true,
          insertionOrder: 1,
        }],
      },
    } as unknown as PreprocessedCharacter['raw'],
    persona: '', worldview: '', style: '', firstMes: '', alternateGreetings: [],
    mesExample: '', systemPrompt: '', postHistoryInstructions: '',
    dynamicLorebookEntries: [], preprocessedAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeContext(provider: LLMProvider): AgentContext {
  const prompts = new InMemoryPromptLoader()
  prompts.set('mvu', '<state>{{mvu_state}}</state>\n<reply>{{assistant_reply}}</reply>\n<rules>{{mvu_update_rules}}</rules>')
  return {
    provider,
    model: 'main-model',
    temperature: 0.7,
    prompts,
    session: { getHistory: () => [], appendMessage: () => undefined, setHistory: () => undefined, turnCount: () => 0, summaryPath: () => '' },
    worldbook: { match: () => [], getContent: () => undefined, list: () => [] },
    sessionId: 'test',
  }
}

test('runMvuUpdate uses its own model and temperature and normalizes a legacy patch', async () => {
  let seenOptions: ChatOptions | undefined
  let seenPrompt = ''
  const provider: LLMProvider = {
    name: 'phony',
    async chat(messages: ChatMessage[], options?: ChatOptions) {
      seenOptions = options
      seenPrompt = messages.find(message => message.role === 'user')?.content ?? ''
      return { content: '<update><json_patch>[{"op":"delta","path":"/score","value":1}]</json_patch></update>' }
    },
  }
  const settings: MvuRuntimeSettings = { enabled: true, model: 'mvu-model', temperature: 0.15, promptName: 'mvu' }
  const result = await runMvuUpdate(
    { character: makeCharacter(), userInput: '前进', assistantReply: '她向前走。', statData: { score: 0 } },
    makeContext(provider),
    settings,
  )
  assert.equal(seenOptions?.model, 'mvu-model')
  assert.equal(seenOptions?.temperature, 0.15)
  assert.ok(seenPrompt.includes('她向前走。'))
  assert.ok(seenPrompt.includes('变量更新规则'))
  // A card-authored legacy block is valid and is preserved so its own regex
  // and downstream Tavern helper rules continue to recognize it.
  assert.match(result.update ?? '', /<update>/u)
  assert.match(result.update ?? '', /<json_patch>/u)
})

test('runMvuUpdate skips the extra call when MVU is disabled', async () => {
  let calls = 0
  const provider: LLMProvider = {
    name: 'phony',
    async chat() { calls += 1; return { content: 'should not run' } },
  }
  const result = await runMvuUpdate(
    { character: makeCharacter(), userInput: 'x', assistantReply: 'y', statData: { score: 0 } },
    makeContext(provider),
    { enabled: false, model: 'mvu-model', temperature: 0, promptName: 'mvu' },
  )
  assert.equal(calls, 0)
  assert.equal(result.update, undefined)
})
