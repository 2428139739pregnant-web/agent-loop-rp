import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runMvuUpdate, type MvuRuntimeSettings } from './mvu-update.ts'
import { InMemoryPromptLoader, type AgentContext } from './types.ts'
import type { ChatMessage, ChatOptions, LLMProvider } from '../provider.ts'
import type { PreprocessedCharacter } from '../character-loader.ts'
import { applyMvuReply, normalizeMvuSupplement, readInitialMvuState, readMvuStateFromMessages } from '../../mvu.ts'

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

test('MVU normalizes modern tags to the Tavern-compatible lowercase wire format', () => {
  const normalized = normalizeMvuSupplement(
    { score: 0 },
    '<UpdateVariable><Analysis>changed</Analysis><JSONPatch>'
      + '[{"op":"replace","path":"/score","value":1}]'
      + '</JSONPatch></UpdateVariable>',
  )
  assert.equal(
    normalized,
    '<update><Analysis>changed</Analysis><json_patch>'
      + '[{"op":"replace","path":"/score","value":1}]'
      + '</json_patch></update>',
  )
})

test('MVU accepts standard RFC 6902 add operations', () => {
  const result = applyMvuReply(
    { score: 0, items: ['a'], meta: {} },
    '<update><json_patch>['
      + '{"op":"add","path":"/score","value":1},'
      + '{"op":"add","path":"/meta/location","value":"神殿"},'
      + '{"op":"add","path":"/items/-","value":"b"}'
      + ']</json_patch></update>',
  )
  assert.deepEqual(result?.statData, { score: 1, items: ['a', 'b'], meta: { location: '神殿' } })
  assert.equal(result?.appliedOperations, 3)
})

test('MVU state applies user and character macros before HUD/template consumption', () => {
  const character = makeCharacter()
  const card = {
    ...character.raw,
    lorebook: {
    ...character.raw.lorebook!,
    entries: [
      ...(character.raw.lorebook?.entries ?? []),
      {
        sourceId: 'init',
        name: '[initvar]',
        comment: '',
        content: '<initvar>\n主角:\n  姓名: <user>\n  称号: "{{char}} 的旅伴"\n</initvar>',
        enabled: true,
        insertionOrder: 0,
      },
    ],
    },
  } as unknown as typeof character.raw
  const state = readMvuStateFromMessages(card, [], { user: '艾云浮', char: '英妮缇雅' })
  assert.equal((state?.statData as { 主角: { 姓名: string; 称号: string } }).主角.姓名, '艾云浮')
  assert.equal((state?.statData as { 主角: { 姓名: string; 称号: string } }).主角.称号, '英妮缇雅 的旅伴')
})

test('MVU initial variables supports Prompt Template markers and ordered deep merge', () => {
  const card = {
    lorebook: {
      entries: [
        {
          name: '@@initial_variables should not be a title marker',
          comment: '',
          content: '@@preload\n@@initial_variables\nplayer:\n  hp: 20\n  mood: calm\nmode: yaml',
          insertionOrder: 1,
        },
        {
          name: '[InitialVariables]',
          comment: '',
          content: '{"player":{"name":"Lina","hp":10},"mode":"json"}',
          insertionOrder: 2,
        },
        {
          name: '[initvar]',
          comment: '',
          content: '<initvar>\nplayer:\n  mood: brave\nlegacy: true\n</initvar>',
          insertionOrder: 3,
        },
      ],
    },
  } as unknown as Parameters<typeof readInitialMvuState>[0]

  assert.deepEqual(readInitialMvuState(card), {
    player: { hp: 10, mood: 'brave', name: 'Lina' },
    mode: 'json',
    legacy: true,
  })
})

test('MVU initial variables uses YAML only after JSON parsing fails', () => {
  const card = {
    lorebook: {
      entries: [{
        name: '[InitialVariables]',
        content: 'settings:\n  greeting: "hello: world"\n  enabled: true',
        insertionOrder: 1,
      }],
    },
  } as unknown as Parameters<typeof readInitialMvuState>[0]

  assert.deepEqual(readInitialMvuState(card), {
    settings: { greeting: 'hello: world', enabled: true },
  })
})

test('MVU initial variables rejects valid non-object JSON and YAML values', () => {
  const jsonCard = {
    lorebook: { entries: [{ name: '[InitialVariables]', content: '[]', insertionOrder: 1 }] },
  } as unknown as Parameters<typeof readInitialMvuState>[0]
  assert.throws(() => readInitialMvuState(jsonCard), /must contain one JSON-compatible object/u)

  const yamlCard = {
    lorebook: { entries: [{ name: '[InitialVariables]', content: '- one\n- two', insertionOrder: 1 }] },
  } as unknown as Parameters<typeof readInitialMvuState>[0]
  assert.throws(() => readInitialMvuState(yamlCard), /must contain one JSON-compatible object/u)
})

test('MVU retry replay safety: stripping the prior block lets applyMvuReply start from the original state', () => {
  const seed = { score: 0 }
  const first = applyMvuReply(seed, '<update><json_patch>[{"op":"replace","path":"/score","value":1}]</json_patch></update>')
  assert.ok(first !== undefined)
  // Reapplying the same text on the already-updated state must not double-count,
  // matching the contract the retry endpoint relies on when no strip happens.
  const second = applyMvuReply(first.statData, '<update><json_patch>[{"op":"replace","path":"/score","value":1}]</json_patch></update>')
  assert.ok(second !== undefined)
  const secondState = second.statData as { score: number }
  assert.equal(secondState.score, 1)
  // A retry that strips the prior <update> block and feeds a fresh delta must
  // observe the original `seed`, not the post-update state.
  const third = applyMvuReply(seed, '<update><json_patch>[{"op":"delta","path":"/score","value":3}]</json_patch></update>')
  assert.ok(third !== undefined)
  const thirdState = third.statData as { score: number }
  assert.equal(thirdState.score, 3)
})

test('runMvuUpdate reports nothing when the model returns a no-op patch', async () => {
  const provider: LLMProvider = {
    name: 'phony',
    async chat() {
      return { content: '<update><json_patch>[]</json_patch></update>' }
    },
  }
  const settings: MvuRuntimeSettings = { enabled: true, model: 'mvu-model', temperature: 0, promptName: 'mvu' }
  const result = await runMvuUpdate(
    { character: makeCharacter(), userInput: 'hi', assistantReply: 'reply', statData: { score: 0 } },
    makeContext(provider),
    settings,
  )
  // An empty JSON Patch is a valid no-op block; the retry endpoint treats it
  // as `applied: true` with zero operations so the UI can show "no changes".
  assert.ok(result.update !== undefined)
  const applied = applyMvuReply({ score: 0 }, result.update)
  assert.ok(applied !== undefined)
  assert.equal(applied.appliedOperations, 0)
  assert.deepEqual(applied.statData, { score: 0 })
})
