import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildConstantWorldbookBlocks,
  buildContextBlock,
  buildContextMessages,
  applySillyTavernDepthPrompts,
  fitResponsePromptToBudget,
  buildWorldbookBlock,
  constantWorldbookDoc,
  parseSillyTavernExampleMessages,
  renderTemplate,
  responseAgent,
  splitWorldbookMatches,
  ST_MESSAGE_TREE_MARKER,
  type ResponseInput,
} from './response.ts'
import { DEFAULT_RESPONSE_PERSPECTIVES } from '../response-settings.ts'
import { InMemoryPromptLoader, type AgentContext } from './types.ts'
import type { PreprocessedCharacter } from '../character-loader.ts'
import type { ChatMessage, ChatOptions, LLMProvider } from '../provider.ts'
import {
  type ContextSegmentOutput,
  type IntentOutput,
  type ReplyResult,
  type WorldbookMatchOutput,
} from '../schema.ts'

// ─── renderTemplate ────────────────────────────────────────────────────────

test('renderTemplate replaces all variables', () => {
  const out = renderTemplate('Hello {{name}}, you are {{role}}', { name: 'A', role: 'B' })
  assert.equal(out, 'Hello A, you are B')
})

test('renderTemplate leaves unknown variables unchanged', () => {
  const out = renderTemplate('Hi {{name}}', {})
  assert.equal(out, 'Hi {{name}}')
})

test('renderTemplate replaces every occurrence of the same variable', () => {
  const out = renderTemplate('{{x}} and {{x}} again', { x: 'Y' })
  assert.equal(out, 'Y and Y again')
})

// ─── buildWorldbookBlock ───────────────────────────────────────────────────

test('buildWorldbookBlock sorts by order asc, weight desc', () => {
  const wb: WorldbookMatchOutput = {
    matches: [
      { path: 'b.md', order: 2, weight: 5, content: 'BBB' },
      { path: 'a.md', order: 1, weight: 3, content: 'AAA' },
      { path: 'c.md', order: 1, weight: 10, content: 'CCC' },
    ],
  }
  const out = buildWorldbookBlock(wb)
  // 期望顺序: c.md (order=1, weight=10) → a.md (order=1, weight=3) → b.md (order=2, weight=5)
  assert.ok(out.startsWith('### c.md'))
  assert.ok(out.indexOf('a.md') < out.indexOf('b.md'))
  assert.ok(out.includes('weight=10'))
  assert.ok(out.includes('CCC'))
})

test('buildWorldbookBlock handles empty', () => {
  assert.equal(buildWorldbookBlock({ matches: [] }), '')
})

test('splitWorldbookMatches preserves all SillyTavern insertion positions', () => {
  const buckets = splitWorldbookMatches([
    { path: 'before', order: 1, weight: 0, content: '0', position: 0 },
    { path: 'after', order: 2, weight: 0, content: '1', position: 1 },
    { path: 'examples-before', order: 3, weight: 0, content: '2', position: 2 },
    { path: 'examples-after', order: 4, weight: 0, content: '3', position: 3 },
    { path: 'depth', order: 5, weight: 0, content: '4', position: 4, depth: 2 },
    { path: 'author-before', order: 6, weight: 0, content: '5', position: 5 },
    { path: 'author-after', order: 7, weight: 0, content: '6', position: 6 },
    { path: 'outlet', order: 8, weight: 0, content: '7', position: 7 },
    { path: 'legacy', order: 9, weight: 0, content: 'legacy' },
  ])
  assert.deepEqual(buckets.beforeCharacter.map(item => item.path), ['before'])
  assert.deepEqual(buckets.afterCharacter.map(item => item.path), ['after'])
  assert.deepEqual(buckets.beforeExamples.map(item => item.path), ['examples-before'])
  assert.deepEqual(buckets.afterExamples.map(item => item.path), ['examples-after'])
  assert.deepEqual(buckets.atDepth.map(item => item.path), ['depth'])
  assert.deepEqual(buckets.beforeAuthorNote.map(item => item.path), ['author-before'])
  assert.deepEqual(buckets.afterAuthorNote.map(item => item.path), ['author-after'])
  assert.deepEqual(buckets.outlet.map(item => item.path), ['outlet'])
  assert.deepEqual(buckets.unplaced.map(item => item.path), ['legacy'])
})

// ─── buildContextBlock ─────────────────────────────────────────────────────

test('buildContextBlock respects mode', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: '...' },
    { role: 'assistant', content: 'A2' },
    { role: 'assistant', content: 'A3' },
  ]
  const seg: ContextSegmentOutput = {
    segments: [
      { id: 1, mode: 'full' },
      { id: 2, mode: 'drop' },
      { id: 3, mode: 'summary' },
    ],
  }
  const out = buildContextBlock(seg, history, 'sid', () => 'summary of A3')
  assert.ok(out.includes('A1'))              // full mode
  assert.ok(!out.includes('A2'))             // drop mode
  assert.ok(out.includes('summary of A3'))   // summary mode
})

test('buildContextBlock drops summary mode when no summary available', () => {
  const history: ChatMessage[] = [{ role: 'assistant', content: 'A1' }]
  const seg: ContextSegmentOutput = { segments: [{ id: 1, mode: 'summary' }] }
  const out = buildContextBlock(seg, history, 'sid', () => undefined)
  assert.equal(out, '')
})

test('buildContextBlock defaults missing id to drop', () => {
  // 2.2 should always emit a decision for every segment, but be defensive
  // if it ever drops one.
  const history: ChatMessage[] = [
    { role: 'assistant', content: 'A1' },
    { role: 'assistant', content: 'A2' },
  ]
  const seg: ContextSegmentOutput = { segments: [{ id: 1, mode: 'full' }] }
  const out = buildContextBlock(seg, history, 'sid', () => undefined)
  assert.ok(out.includes('A1'))
  assert.ok(!out.includes('A2'))
})

test('buildContextBlock numbers segments by assistant turns only', () => {
  // Two user turns interleaved with one assistant — the assistant should
  // be segment id 1, not 3.
  const history: ChatMessage[] = [
    { role: 'user', content: 'u1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'A1' },
  ]
  const seg: ContextSegmentOutput = { segments: [{ id: 1, mode: 'full' }] }
  const out = buildContextBlock(seg, history, 'sid', () => undefined)
  assert.ok(out.includes('A1'))
})

test('buildContextMessages preserves ST user/assistant roles and omits dropped turns', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'A1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'A2' },
  ]
  const messages = buildContextMessages(
    { segments: [{ id: 1, mode: 'full' }, { id: 2, mode: 'drop' }] },
    history,
    () => undefined,
  )
  assert.deepEqual(messages.map(message => [message.role, message.content]), [
    ['user', 'u1'],
    ['assistant', 'A1'],
  ])
})

test('parseSillyTavernExampleMessages follows ST START and speaker parsing', () => {
  const messages = parseSillyTavernExampleMessages(
    '<START>\n小明: 你好\n\n莉娜: 欢迎。\n<START>\n小明: 第二段',
    '小明',
    '莉娜',
  )
  assert.deepEqual(messages, [
    { role: 'system', content: '你好', name: '小明' },
    { role: 'system', content: '欢迎。', name: '莉娜' },
    { role: 'system', content: '第二段', name: '小明' },
  ])
})

test('applySillyTavernDepthPrompts inserts atDepth prompts from the newest message boundary', () => {
  const messages = applySillyTavernDepthPrompts([
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'current' },
  ], [
    { content: 'depth-0', depth: 0, role: 'system', order: 1 },
    { content: 'depth-1', depth: 1, role: 'system', order: 2 },
  ])
  assert.deepEqual(messages.map(message => message.content), ['u1', 'a1', 'depth-1', 'current', 'depth-0'])
})

test('fitResponsePromptToBudget trims oldest history pairs but keeps fixed layers and current input', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'OLD_USER '.repeat(260) },
    { role: 'assistant', content: 'OLD_ASSISTANT '.repeat(260) },
    { role: 'user', content: 'KEEP_USER' },
  ]
  const fitted = fitResponsePromptToBudget(
    history,
    {
      perspective: 'card',
      perspectives: DEFAULT_RESPONSE_PERSPECTIVES,
      lengthPreset: 'custom',
      minChars: 20,
      maxChars: 20,
      maxContextTokens: 1_024,
    },
    (candidate) => [
      { role: 'system', content: 'FIXED_SYSTEM' },
      ...candidate,
    ],
  )
  assert.ok(fitted.stats.droppedHistoryMessages >= 2)
  assert.ok(fitted.messages.some(message => message.content === 'FIXED_SYSTEM'))
  assert.ok(fitted.messages.some(message => message.content === 'KEEP_USER'))
  assert.ok(!fitted.messages.some(message => message.content.includes('OLD_USER')))
  assert.ok(!fitted.messages.some(message => message.content.includes('OLD_ASSISTANT')))
})

// ─── responseAgent.run (integration) ───────────────────────────────────────

function makeCharacter(overrides: Partial<PreprocessedCharacter> = {}): PreprocessedCharacter {
  return {
    name: 'Lina',
    raw: {} as PreprocessedCharacter['raw'],
    persona: 'A cheerful mage apprentice.',
    worldview: 'A floating magic academy above the clouds.',
    style: 'Lyrical, second person, 80-200 chars.',
    firstMes: 'Lina tilts her head and smiles.',
    alternateGreetings: [],
    // ST 适配三字段(测试里默认空;有专门的用例覆盖非空注入)。
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    dynamicLorebookEntries: [],
    preprocessedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeIntent(overrides: Partial<IntentOutput> = {}): IntentOutput {
  return {
    userNarration: 'I step forward and draw my staff.',
    metaCommands: [],
    involvedCharacters: [],
    keywords: [],
    ...overrides,
  }
}

interface CtxOpts {
  readonly provider: LLMProvider
  readonly history?: readonly ChatMessage[]
  readonly promptBody?: string
  readonly turnCount?: number
}

function makeCtx(opts: CtxOpts): AgentContext {
  const prompts = new InMemoryPromptLoader()
  prompts.set(
    'response',
    opts.promptBody
      ?? '{{character_name}} | {{persona}} | {{worldview}} | {{style}} '
        + '| {{user_narration}} | {{meta_commands}} | {{involved_characters}} '
        + '| {{keywords}} | {{worldbook_block}} | {{context_block}}',
  )
  return {
    provider: opts.provider,
    model: 'mock',
    temperature: 0.7,
    prompts,
    session: {
      getHistory: () => opts.history ?? [],
      appendMessage: () => undefined,
      setHistory: () => undefined,
      turnCount: () => opts.turnCount ?? 0,
      summaryPath: () => '',
    },
    worldbook: { match: () => [], getContent: () => undefined, list: () => [] },
    sessionId: 'test',
  }
}

test('responseAgent.run returns the LLM content as reply', async () => {
  const provider: LLMProvider = {
    name: 'phony',
    async chat() { return { content: 'Hello, traveller.' } },
  }
  const ctx = makeCtx({ provider })
  const result: ReplyResult = await responseAgent.run(
    {
      intent: makeIntent(),
      worldbook: { matches: [] },
      contextSegmentation: { segments: [] },
      userInput: 'hi',
      character: makeCharacter(),
    },
    ctx,
  )
  assert.equal(result.reply, 'Hello, traveller.')
  assert.equal(result.sessionId, 'test')
  assert.equal(result.turn, 0)
  assert.equal(result.usedWorldbook, false)
  assert.equal(result.usedContextSegmentation, false)
})

test('responseAgent applies configurable perspective, length, and max token cap', async () => {
  let captured: ChatMessage[] = []
  let options: ChatOptions | undefined
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages, nextOptions) {
      captured = messages
      options = nextOptions
      return { content: 'r' }
    },
  }
  const ctx = makeCtx({
    provider,
    promptBody: '{{response_settings}}',
  })
  await responseAgent.run(
    {
      intent: makeIntent(),
      worldbook: { matches: [] },
      contextSegmentation: { segments: [] },
      userInput: 'hi',
      character: makeCharacter(),
      responseSettings: {
        perspective: 'third',
        perspectives: DEFAULT_RESPONSE_PERSPECTIVES,
        lengthPreset: 'medium',
        minChars: 500,
        maxChars: 900,
      },
    },
    ctx,
  )
  assert.match(captured[0]?.content ?? '', /第三人称有限/u)
  assert.match(captured[0]?.content ?? '', /500-900/u)
  assert.equal(options?.max_tokens, 1980)
})

test('responseAgent applies plugin prompt injections in the same single response call', async () => {
  let calls = 0
  let captured: ChatMessage[] = []
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      calls += 1
      captured = messages
      return { content: 'r' }
    },
  }
  const ctx = makeCtx({ provider })
  await responseAgent.run(
    {
      intent: makeIntent(),
      worldbook: {
        matches: [],
        plugin: {
          promptInjections: [{
            path: 'special', content: 'SPECIAL', role: 'system', order: 1,
            placement: { kind: 'absolute', position: 0 },
          }],
          renderDirectives: [],
          skipped: [],
        },
      },
      contextSegmentation: { segments: [] },
      userInput: 'hi',
      character: makeCharacter(),
    },
    ctx,
  )
  assert.equal(calls, 1)
  assert.equal(captured[0]?.content, 'SPECIAL')
  assert.equal(captured.at(-1)?.role, 'user')
})

test('responseAgent sends selected context as a real chatHistory message layer', async () => {
  let captured: ChatMessage[] = []
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      captured = messages
      return { content: 'r' }
    },
  }
  const ctx = makeCtx({
    provider,
    history: [
      { role: 'user', content: 'old user' },
      { role: 'assistant', content: 'old assistant' },
      { role: 'user', content: 'current' },
    ],
  })
  await responseAgent.run({
    intent: makeIntent(),
    worldbook: { matches: [] },
    contextSegmentation: { segments: [{ id: 1, mode: 'full' }] },
    userInput: 'current',
    character: makeCharacter(),
  }, ctx)
  assert.deepEqual(captured.map(message => [message.role, message.content]), [
    ['system', captured[0]?.content],
    ['user', 'old user'],
    ['assistant', 'old assistant'],
    ['user', 'current'],
  ])
  assert.equal(captured.filter(message => message.content === 'current').length, 1)
})

test('responseAgent uses an ST-style message tree when the response template opts in', async () => {
  let captured: ChatMessage[] = []
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      captured = messages
      return { content: 'r' }
    },
  }
  const ctx = makeCtx({
    provider,
    promptBody: `${ST_MESSAGE_TREE_MARKER}\nCONTROL {{card_system_prompt}}`,
    history: [
      { role: 'user', content: 'old user' },
      { role: 'assistant', content: 'old assistant' },
      { role: 'user', content: 'current' },
    ],
  })
  // makeCtx installs its own loader; replace the body is enough for this test.
  await responseAgent.run({
    intent: makeIntent({ metaCommands: ['加快节奏'] }),
    worldbook: { matches: [{ path: 'depth', order: 1, weight: 0, content: 'DEPTH', position: 4, depth: 1 }] },
    contextSegmentation: { segments: [{ id: 1, mode: 'full' }] },
    userInput: 'current',
    character: makeCharacter({
      systemPrompt: 'CARD_SYSTEM',
      mesExample: '<START>\n{{user}}: 你好\n{{char}}: 欢迎。',
      postHistoryInstructions: 'POST_HISTORY',
    }),
  }, ctx)
  assert.equal(captured[0]?.role, 'system')
  assert.match(captured[0]?.content ?? '', /CONTROL CARD_SYSTEM/u)
  assert.ok(captured.some(message => message.content === '[Example Chat]'))
  assert.ok(captured.some(message => message.name === 'Lina' && message.content === '欢迎。'))
  assert.ok(captured.some(message => message.content.includes('DEPTH')))
  assert.ok(captured.some(message => message.content === 'old assistant'))
  assert.equal(captured.findLast(message => message.content === 'current')?.role, 'user')
  assert.equal(captured.at(-1)?.content, 'POST_HISTORY')
})

test('responseAgent reports and applies the context budget after all injections are assembled', async () => {
  let captured: ChatMessage[] = []
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      captured = messages
      return { content: 'r' }
    },
  }
  const ctx = makeCtx({
    provider,
    promptBody: `${ST_MESSAGE_TREE_MARKER}\nCONTROL`,
    history: [
      { role: 'user', content: 'OLD_USER '.repeat(260) },
      { role: 'assistant', content: 'OLD_ASSISTANT '.repeat(260) },
      { role: 'user', content: 'current' },
    ],
  })
  const result = await responseAgent.run({
    intent: makeIntent(),
    worldbook: { matches: [] },
    contextSegmentation: { segments: [{ id: 1, mode: 'full' }] },
    userInput: 'current',
    character: makeCharacter(),
    responseSettings: {
      perspective: 'card',
      perspectives: DEFAULT_RESPONSE_PERSPECTIVES,
      lengthPreset: 'custom',
      minChars: 20,
      maxChars: 20,
      maxContextTokens: 1_024,
    },
  }, ctx)
  assert.ok((result.promptBudget?.droppedHistoryMessages ?? 0) >= 2)
  assert.ok(captured.some(message => message.content === 'current'))
  assert.ok(!captured.some(message => message.content.includes('OLD_USER')))
  assert.ok(!captured.some(message => message.content.includes('OLD_ASSISTANT')))
})

test('responseAgent.run sets usedWorldbook when matches non-empty', async () => {
  const provider: LLMProvider = {
    name: 'phony',
    async chat() { return { content: 'r' } },
  }
  const ctx = makeCtx({ provider })
  const result = await responseAgent.run(
    {
      intent: makeIntent(),
      worldbook: { matches: [{ path: 'a.md', order: 1, weight: 5, content: 'A' }] },
      contextSegmentation: { segments: [] },
      userInput: 'hi',
      character: makeCharacter(),
    },
    ctx,
  )
  assert.equal(result.usedWorldbook, true)
  assert.equal(result.usedContextSegmentation, false)
})

test('responseAgent.run sets usedContextSegmentation when segments non-empty', async () => {
  const provider: LLMProvider = {
    name: 'phony',
    async chat() { return { content: 'r' } },
  }
  const ctx = makeCtx({ provider })
  const result = await responseAgent.run(
    {
      intent: makeIntent(),
      worldbook: { matches: [] },
      contextSegmentation: { segments: [{ id: 1, mode: 'full' }] },
      userInput: 'hi',
      character: makeCharacter(),
    },
    ctx,
  )
  assert.equal(result.usedWorldbook, false)
  assert.equal(result.usedContextSegmentation, true)
})

test('responseAgent.run reports turn count from the session', async () => {
  const provider: LLMProvider = {
    name: 'phony',
    async chat() { return { content: 'r' } },
  }
  const ctx = makeCtx({ provider, turnCount: 7 })
  const result = await responseAgent.run(
    {
      intent: makeIntent(),
      worldbook: { matches: [] },
      contextSegmentation: { segments: [] },
      userInput: 'hi',
      character: makeCharacter(),
    },
    ctx,
  )
  assert.equal(result.turn, 7)
})

test('responseAgent.run renders every template variable', async () => {
  let capturedSystem = ''
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      capturedSystem = messages.find(m => m.role === 'system')?.content ?? ''
      return { content: 'r' }
    },
  }
  const ctx = makeCtx({ provider })
  const input: ResponseInput = {
    intent: makeIntent({
      userNarration: 'draws sword',
      metaCommands: ['节奏加快'],
      involvedCharacters: ['Lina', 'Kai'],
      keywords: ['火系', '剑术'],
    }),
    worldbook: { matches: [{ path: 'fire.md', order: 1, weight: 9, content: 'FIRE_MAGIC' }] },
    contextSegmentation: { segments: [] },
    userInput: 'go',
    character: makeCharacter({ name: 'Lina' }),
  }
  await responseAgent.run(input, ctx)
  assert.ok(capturedSystem.includes('Lina'),         'character_name')
  assert.ok(capturedSystem.includes('A cheerful'),   'persona')
  assert.ok(capturedSystem.includes('floating'),     'worldview')
  assert.ok(capturedSystem.includes('Lyrical'),      'style')
  assert.ok(capturedSystem.includes('draws sword'),  'user_narration')
  assert.ok(capturedSystem.includes('节奏加快'),       'meta_commands')
  assert.ok(capturedSystem.includes('Lina, Kai'),    'involved_characters')
  assert.ok(capturedSystem.includes('火系, 剑术'),     'keywords')
  assert.ok(capturedSystem.includes('fire.md'),      'worldbook_block path')
  assert.ok(capturedSystem.includes('FIRE_MAGIC'),   'worldbook_block content')
})

test('responseAgent.run falls back to placeholders when inputs are empty', async () => {
  let capturedSystem = ''
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      capturedSystem = messages.find(m => m.role === 'system')?.content ?? ''
      return { content: 'r' }
    },
  }
  const ctx = makeCtx({ provider })
  const input: ResponseInput = {
    intent: makeIntent({ userNarration: 'go' }),
    worldbook: { matches: [] },
    contextSegmentation: { segments: [] },
    userInput: 'go',
    character: makeCharacter(),
  }
  await responseAgent.run(input, ctx)
  assert.ok(capturedSystem.includes('(无)'))
  assert.ok(capturedSystem.includes('(无激活的世界书条目)'))
  assert.ok(capturedSystem.includes('(无相关历史)'))
})

test('responseAgent.run injects the user input as the user message', async () => {
  let capturedUser = ''
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      capturedUser = messages.find(m => m.role === 'user')?.content ?? ''
      return { content: 'r' }
    },
  }
  const ctx = makeCtx({ provider })
  await responseAgent.run(
    {
      intent: makeIntent(),
      worldbook: { matches: [] },
      contextSegmentation: { segments: [] },
      userInput: 'TURN_INPUT_MARKER',
      character: makeCharacter(),
    },
    ctx,
  )
  assert.equal(capturedUser, 'TURN_INPUT_MARKER')
})

// ─── ST 适配:三字段(示例对话 / system_prompt / post_history_instructions) ──

test('responseAgent.run renders mes_example / system_prompt / post_history_instructions with macros', async () => {
  let capturedSystem = ''
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      capturedSystem = messages.find(m => m.role === 'system')?.content ?? ''
      return { content: 'r' }
    },
  }
  const prompts = new InMemoryPromptLoader()
  prompts.set('response',
    'SYS>>{{card_system_prompt}}|EXAMPLE>>{{example_dialogue}}|POST>>{{post_history_instructions}}')
  const ctx: AgentContext = {
    provider,
    model: 'mock',
    temperature: 0.7,
    prompts,
    session: { getHistory: () => [], appendMessage: () => undefined, setHistory: () => undefined, turnCount: () => 0, summaryPath: () => '' },
    worldbook: { match: () => [], getContent: () => undefined, list: () => [] },
    sessionId: 'test',
  }
  const input: ResponseInput = {
    intent: makeIntent(),
    worldbook: { matches: [] },
    contextSegmentation: { segments: [] },
    userInput: 'go',
    character: makeCharacter({
      mesExample: '<START>\n{{user}}: 早\n{{char}}: 早安。',
      systemPrompt: '扮演{{char}}。',
      postHistoryInstructions: '{{user}}的称呼要保持。',
    }),
    userPersona: { name: '小明', description: '' },
  }
  await responseAgent.run(input, ctx)
  // 三个新字段都进 system prompt,且 {{user}}/{{char}} 已替换(makeCharacter 的角色名是 Lina)。
  assert.ok(capturedSystem.includes('SYS>>扮演Lina。'), 'system_prompt 前置 + 宏替换')
  assert.ok(capturedSystem.includes('EXAMPLE>><START>\n小明: 早\nLina: 早安。'), 'mes_example + 宏替换')
  assert.ok(capturedSystem.includes('POST>>小明的称呼要保持。'), 'post_history_instructions + 宏替换')
})

test('responseAgent.run falls back to placeholders when the card fields are empty', async () => {
  let capturedSystem = ''
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      capturedSystem = messages.find(m => m.role === 'system')?.content ?? ''
      return { content: 'r' }
    },
  }
  const prompts = new InMemoryPromptLoader()
  prompts.set('response', 'SYS>>{{card_system_prompt}}|EXAMPLE>>{{example_dialogue}}|POST>>{{post_history_instructions}}')
  const ctx: AgentContext = {
    provider,
    model: 'mock',
    temperature: 0.7,
    prompts,
    session: { getHistory: () => [], appendMessage: () => undefined, setHistory: () => undefined, turnCount: () => 0, summaryPath: () => '' },
    worldbook: { match: () => [], getContent: () => undefined, list: () => [] },
    sessionId: 'test',
  }
  // 老存档/旧 wire 的 character 可能完全没有这三个字段(undefined)→ 占位,不抛错。
  await responseAgent.run(
    {
      intent: makeIntent(),
      worldbook: { matches: [] },
      contextSegmentation: { segments: [] },
      userInput: 'go',
      character: makeCharacter(),
    },
    ctx,
  )
  assert.ok(capturedSystem.includes('SYS>>(卡片未提供 system_prompt)'))
  assert.ok(capturedSystem.includes('EXAMPLE>>(无示例对话)'))
  assert.ok(capturedSystem.includes('POST>>(无回复后指令)'))
})

// ─── ST 适配:独立世界书蓝灯条目常驻注入 ─────────────────────────────────────

test('constantWorldbookDoc maps ST position to the three docs', () => {
  assert.equal(constantWorldbookDoc(0), 'persona')     // before_char
  assert.equal(constantWorldbookDoc(1), 'worldview')   // after_char
  assert.equal(constantWorldbookDoc(2), 'style')       // ANTop(简化并入 style 尾部)
  assert.equal(constantWorldbookDoc(4), 'style')       // atDepth
  assert.equal(constantWorldbookDoc(7), 'style')       // outlet
  assert.equal(constantWorldbookDoc(undefined), 'persona') // ST 默认 position=0
})

test('buildConstantWorldbookBlocks keeps enabled constants only, sorted order DESC, macro-substituted', () => {
  const store = {
    list: () => [
      { path: '书/p5', keywords: [], order: 5, weight: 0, content: 'BLUE_P5 {{user}}', constant: true, position: 0 },
      { path: '书/p9', keywords: [], order: 9, weight: 0, content: 'BLUE_P9', constant: true, position: 0 },
      { path: '书/w3', keywords: [], order: 3, weight: 0, content: 'BLUE_W3', constant: true, position: 1 },
      { path: '书/s2', keywords: [], order: 2, weight: 0, content: 'BLUE_S2', constant: true, position: 6 },
      { path: '书/green', keywords: ['k'], order: 1, weight: 0, content: 'GREEN', constant: false },
      { path: '书/off', keywords: [], order: 1, weight: 0, content: 'OFF', constant: true, enabled: false },
    ],
  }
  const blocks = buildConstantWorldbookBlocks(store, (t) => t.replaceAll('{{user}}', '小明'))
  assert.ok(blocks.persona.includes('BLUE_P9'))
  assert.ok(blocks.persona.includes('BLUE_P5 {{user}}'.replace('{{user}}', '小明')))
  assert.ok(blocks.persona.indexOf('BLUE_P9') < blocks.persona.indexOf('BLUE_P5'), 'order 降序')
  assert.ok(blocks.worldview.includes('BLUE_W3'))
  assert.ok(blocks.style.includes('BLUE_S2'))
  assert.ok(!blocks.persona.includes('GREEN'), '绿灯不常驻')
  assert.ok(!blocks.persona.includes('OFF') && !blocks.worldview.includes('OFF'), '禁用条目跳过')
})

test('constant worldbook entries honor ST probability after activation', () => {
  const store = {
    list: () => [
      { path: 'book/zero', keywords: [], order: 1, weight: 0, content: 'ZERO', constant: true, probability: 0 },
      { path: 'book/half', keywords: [], order: 2, weight: 0, content: 'HALF', constant: true, probability: 50 },
      { path: 'book/off', keywords: [], order: 3, weight: 0, content: 'OFF', constant: true, probability: 0, useProbability: false },
    ],
  }
  const blocked = buildConstantWorldbookBlocks(store, text => text, { random: () => 0.99 })
  assert.ok(!blocked.persona.includes('ZERO'))
  assert.ok(!blocked.persona.includes('HALF'))
  assert.ok(blocked.persona.includes('OFF'))
  const passed = buildConstantWorldbookBlocks(store, text => text, { random: () => 0.01 })
  assert.ok(passed.persona.includes('HALF'))
})

test('responseAgent.run appends standalone constant worldbook blocks into the doc sections', async () => {
  let capturedSystem = ''
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      capturedSystem = messages.find(m => m.role === 'system')?.content ?? ''
      return { content: 'r' }
    },
  }
  const prompts = new InMemoryPromptLoader()
  prompts.set('response', 'P>>{{persona}}|W>>{{worldview}}|S>>{{style}}')
  const ctx: AgentContext = {
    provider,
    model: 'mock',
    temperature: 0.7,
    prompts,
    session: { getHistory: () => [], appendMessage: () => undefined, setHistory: () => undefined, turnCount: () => 0, summaryPath: () => '' },
    worldbook: {
      match: () => [],
      getContent: () => undefined,
      list: () => [
        { path: '世界书/xp', keywords: [], order: 10, weight: 0, content: 'XP_CONST', constant: true, position: 0 },
      ],
    },
    sessionId: 'test',
  }
  await responseAgent.run(
    {
      intent: makeIntent(),
      worldbook: { matches: [] },
      contextSegmentation: { segments: [] },
      userInput: 'go',
      character: makeCharacter(),
    },
    ctx,
  )
  // 独立书蓝灯每轮注入,不受消息内容影响;拼在 persona 文档尾部(position 0)。
  assert.ok(capturedSystem.includes('XP_CONST'))
  assert.ok(capturedSystem.includes('常驻世界书条目'))
  assert.ok(capturedSystem.indexOf('XP_CONST') > capturedSystem.indexOf('P>>A cheerful'))
})

test('constant worldbook blocks honor the matcher budget allowlist', () => {
  const store = {
    list: () => [
      { path: '书/keep', keywords: [], order: 2, weight: 0, content: 'KEEP', constant: true, position: 0 },
      { path: '书/drop', keywords: [], order: 1, weight: 0, content: 'DROP', constant: true, position: 0 },
    ],
  }
  const blocks = buildConstantWorldbookBlocks(store, text => text, {
    allowedPaths: new Set(['书/keep']),
  })
  assert.ok(blocks.persona.includes('KEEP'))
  assert.ok(!blocks.persona.includes('DROP'))
})
