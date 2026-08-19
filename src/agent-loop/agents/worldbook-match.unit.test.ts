import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildWorldbookMatchInput,
  applyWorldbookTokenBudget,
  deterministicWorldbookMatch,
  exactKeywordMatch,
  filterInclusionGroupCandidates,
  formatCandidates,
  formatRecentMessages,
  parseWorldbookMatchResponse,
  rollProbability,
  worldbookMatchAgent,
  type WorldbookMatchCandidate,
} from './worldbook-match.ts'
import { InMemoryPromptLoader, type AgentContext } from './types.ts'
import { MemoryWorldbookStore } from '../session.ts'
import type { IntentOutput, WorldbookMatchOutput } from '../schema.ts'
import type { ChatMessage, LLMProvider } from '../provider.ts'

// ─── parseWorldbookMatchResponse ────────────────────────────────────────────

test('parseWorldbookMatchResponse handles a clean JSON object', () => {
  const raw = JSON.stringify({
    matches: [{ path: '魔法.md', order: 1, weight: 10, content: '...' }],
  })
  const result = parseWorldbookMatchResponse(raw, [])
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]?.path, '魔法.md')
  assert.equal(result.matches[0]?.order, 1)
  assert.equal(result.matches[0]?.weight, 10)
})

test('parseWorldbookMatchResponse extracts a markdown ```json``` code block', () => {
  const raw = '```json\n{"matches":[{"path":"a.md","order":2,"weight":3,"content":"x"}]}\n```'
  const result = parseWorldbookMatchResponse(raw, [])
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]?.path, 'a.md')
})

test('parseWorldbookMatchResponse returns the fallback on garbage input', () => {
  const fallback = [{ path: 'X.md', order: 1, weight: 5, content: '' }]
  const result = parseWorldbookMatchResponse('not json at all', fallback)
  assert.deepEqual(result.matches, fallback)
})

test('parseWorldbookMatchResponse returns the fallback on empty string', () => {
  const fallback = [{ path: 'X.md', order: 1, weight: 5, content: '' }]
  const result = parseWorldbookMatchResponse('', fallback)
  assert.deepEqual(result.matches, fallback)
})

test('parseWorldbookMatchResponse returns empty matches on bare {} input', () => {
  const result = parseWorldbookMatchResponse('{}', [])
  assert.deepEqual(result.matches, [])
})

// ─── exactKeywordMatch(候选参数表上的精确匹配,LLM 故障安全网) ───────────────

function makeCandidate(overrides: Partial<WorldbookMatchCandidate> = {}): WorldbookMatchCandidate {
  return {
    path: 'a.md',
    comment: 'a',
    keys: ['火系'],
    secondaryKeys: [],
    selectiveLogic: 'and-any',
    caseSensitive: false,
    matchWholeWords: false,
    useRegex: false,
    probability: 100,
    useProbability: true,
    order: 1,
    weight: 5,
    ...overrides,
  }
}

test('exactKeywordMatch requires the primary key before applying secondary keys', () => {
  const candidates = [
    makeCandidate({ path: 'a.md', keys: ['火系', '水系'] }),
    makeCandidate({
      path: 'b.md', keys: ['历史'], secondaryKeys: ['古代'], selective: true,
    }),
  ]
  const byPrimary = exactKeywordMatch(['火系'], candidates)
  assert.equal(byPrimary.length, 1)
  assert.equal(byPrimary[0]?.path, 'a.md')
  assert.deepEqual(exactKeywordMatch(['古代'], candidates), [])
  assert.equal(exactKeywordMatch(['历史', '古代'], candidates)[0]?.path, 'b.md')
})

test('exactKeywordMatch returns empty for no match / empty keyword list', () => {
  const candidates = [makeCandidate({ keys: ['火系'] })]
  assert.equal(exactKeywordMatch(['冰系'], candidates).length, 0)
  assert.equal(exactKeywordMatch([], candidates).length, 0)
})

// ─── formatCandidates / formatRecentMessages(喂给 LLM 的结构化参数表) ───────

test('formatCandidates renders a markdown parameter table with ST semantics labels', () => {
  const out = formatCandidates([
    makeCandidate({
      path: 'a.md', comment: '火魔法', keys: ['火系', '焰'], secondaryKeys: ['法术'],
      selectiveLogic: 'not-any', caseSensitive: true, matchWholeWords: true, useRegex: true,
      probability: 80, order: 3, weight: 7,
    }),
  ])
  assert.match(out, /\| 路径 \| 名称 \| 主关键词 \| 次关键词 \| 次关键词逻辑 \|/)
  assert.ok(out.includes('a.md'))
  assert.ok(out.includes('火系, 焰'))
  assert.ok(out.includes('NOT_ANY(全部次关键词未命中才激活)'))
  assert.ok(out.includes('| 80 |'))
})

test('formatCandidates returns a placeholder for empty candidates', () => {
  assert.equal(formatCandidates([]), '(无候选条目)')
})

test('formatRecentMessages renders a numbered list with role labels', () => {
  const out = formatRecentMessages([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '欢迎回来' },
  ])
  assert.ok(out.includes('[1] 用户: 你好'))
  assert.ok(out.includes('[2] 角色: 欢迎回来'))
  assert.equal(formatRecentMessages([]), '(无最近消息)')
})

// ─── rollProbability(ST 掷骰公式,边界含等号) ───────────────────────────────

test('rollProbability: probability=100 always passes', () => {
  assert.equal(rollProbability(100, () => 0.999999), true)
  assert.equal(rollProbability(100, () => 0), true)
})

test('rollProbability: probability=0 effectively never passes (rng in [0,1))', () => {
  assert.equal(rollProbability(0, () => 0.000001), false)
  assert.equal(rollProbability(0, () => 0.999999), false)
})

test('rollProbability: boundary is inclusive (ST: random*100 <= probability)', () => {
  // rng=0.5 → 50 <= 50 ✓(与 ST world-info.js:4907-4925 同款含等号边界)
  assert.equal(rollProbability(50, () => 0.5), true)
  assert.equal(rollProbability(50, () => 0.51), false)
})

test('deterministicWorldbookMatch activates a keyless blue entry without chat text', () => {
  const matches = deterministicWorldbookMatch({
    intent: makeIntent(),
    scanDepth: 2,
    recentMessages: [],
    candidates: [
      makeCandidate({ path: 'blue.md', keys: [], constant: true }),
      makeCandidate({ path: 'green.md', keys: ['火系'] }),
    ],
  })
  assert.deepEqual(matches.map(candidate => candidate.path), ['blue.md'])
})

test('inclusion groups keep ST override winners and weighted winners local', () => {
  const input = {
    intent: makeIntent({ keywords: ['火'] }),
    scanDepth: 2,
    recentMessages: [{ role: 'user' as const, content: '火' }],
    candidates: [],
  }
  const override = filterInclusionGroupCandidates([
    makeCandidate({ path: 'low.md', keys: ['火'], group: 'scene', order: 1, groupOverride: true }),
    makeCandidate({ path: 'high.md', keys: ['火'], group: 'scene', order: 9, groupOverride: true }),
  ], input, () => 0)
  assert.deepEqual(override.map(candidate => candidate.path), ['high.md'])

  const weighted = filterInclusionGroupCandidates([
    makeCandidate({ path: 'first.md', keys: ['火'], group: 'scene', groupWeight: 1 }),
    makeCandidate({ path: 'second.md', keys: ['火'], group: 'scene', groupWeight: 9 }),
  ], input, () => 0.95)
  assert.deepEqual(weighted.map(candidate => candidate.path), ['second.md'])
})

test('sticky inclusion-group entries beat non-sticky candidates', () => {
  const input = {
    intent: makeIntent(),
    scanDepth: 2,
    recentMessages: [],
    candidates: [],
    messageCount: 3,
    timedEffects: { 'sticky.md': { activatedAt: 2, stickyUntil: 5, cooldownUntil: 5 } },
  }
  const result = filterInclusionGroupCandidates([
    makeCandidate({ path: 'sticky.md', group: 'same' }),
    makeCandidate({ path: 'other.md', group: 'same' }),
  ], input, () => 0.99)
  assert.deepEqual(result.map(candidate => candidate.path), ['sticky.md'])
})

test('deterministicWorldbookMatch applies recursive scanning and all four recursion gates', () => {
  const book = 'card:recursive'
  const matches = deterministicWorldbookMatch({
    intent: makeIntent({ keywords: ['start'] }),
    scanDepth: 2,
    recentMessages: [],
    candidates: [
      makeCandidate({
        path: 'root.md', keys: ['start'], recursiveScanning: true, recursiveBookId: book,
        recursiveContent: 'next',
      }),
      makeCandidate({
        path: 'delayed-one.md', keys: ['next'], recursiveScanning: true, recursiveBookId: book,
        delayUntilRecursion: true, recursiveContent: 'late',
      }),
      makeCandidate({
        path: 'delayed-two.md', keys: ['late'], recursiveScanning: true, recursiveBookId: book,
        delayUntilRecursion: 2,
      }),
      makeCandidate({
        path: 'excluded.md', keys: ['next'], recursiveScanning: true, recursiveBookId: book,
        excludeRecursion: true,
      }),
      makeCandidate({
        path: 'prevent-source.md', keys: ['start'], recursiveScanning: true, recursiveBookId: book,
        preventRecursion: true, recursiveContent: 'blocked',
      }),
      makeCandidate({
        path: 'prevent-target.md', keys: ['blocked'], recursiveScanning: true, recursiveBookId: book,
      }),
      makeCandidate({
        path: 'other-book.md', keys: ['next'], recursiveScanning: true, recursiveBookId: 'other-book',
      }),
      makeCandidate({ path: 'non-recursive.md', keys: ['next'] }),
    ],
  }, { rollProbability: false })

  assert.deepEqual(matches.map(candidate => candidate.path), [
    'root.md', 'delayed-one.md', 'delayed-two.md', 'prevent-source.md',
  ])
})

// ─── buildWorldbookMatchInput(蓝灯/绿灯分类 + 扫描深度 + 宏替换入参) ─────────

function makeIntent(overrides: Partial<IntentOutput> = {}): IntentOutput {
  return {
    userNarration: '',
    metaCommands: [],
    involvedCharacters: [],
    keywords: [],
    ...overrides,
  }
}

interface CtxOpts {
  readonly provider?: LLMProvider
  readonly store: MemoryWorldbookStore
  readonly promptBody?: string
  readonly history?: readonly ChatMessage[]
  readonly macros?: { user: string | null; char: string | null }
  readonly scanDepth?: number
  readonly globalScanData?: {
    readonly personaDescription?: string
    readonly characterDescription?: string
    readonly characterPersonality?: string
    readonly characterDepthPrompt?: string
    readonly scenario?: string
    readonly creatorNotes?: string
  }
  readonly tavernHelperState?: AgentContext['tavernHelperState']
}

function makeCtx(opts: CtxOpts): AgentContext {
  const prompts = new InMemoryPromptLoader()
  prompts.set('worldbook-match', opts.promptBody ?? 'tmpl {{keywords}} {{scan_depth}} {{recent_messages}} {{candidates}}')
  return {
    provider: opts.provider ?? { name: 'spy', async chat() { return { content: '{}' } } },
    model: 'mock',
    temperature: 0.2,
    prompts,
    session: {
      getHistory: () => opts.history ?? [],
      appendMessage: () => undefined,
      setHistory: () => undefined,
      turnCount: () => 0,
      summaryPath: () => '',
    },
    worldbook: opts.store,
    sessionId: 'test',
    ...(opts.macros !== undefined ? { macros: opts.macros } : {}),
    ...(opts.scanDepth !== undefined
      ? { worldbookSettings: { scanDepth: opts.scanDepth, useLlmMatcher: true } }
      : {}),
    ...(opts.globalScanData === undefined ? {} : { worldbookGlobalScanData: opts.globalScanData }),
    ...(opts.tavernHelperState === undefined ? {} : { tavernHelperState: opts.tavernHelperState }),
  }
}

test('buildWorldbookMatchInput keeps only enabled green entries (blue light excluded)', () => {
  const store = new MemoryWorldbookStore([
    { path: 'green.md', keywords: ['火系'], order: 1, weight: 5, content: 'A' },
    { path: 'blue.md', keywords: ['蓝'], order: 2, weight: 1, content: 'B', constant: true },
    { path: 'blue_disabled.md', keywords: ['蓝禁'], order: 3, weight: 1, content: 'C', constant: true, enabled: false },
    { path: 'green_disabled.md', keywords: ['绿禁'], order: 4, weight: 1, content: 'D', enabled: false },
  ])
  const input = buildWorldbookMatchInput(makeIntent({ keywords: ['x'] }), makeCtx({ store }))
  // 蓝灯不进匹配池(response 常驻注入);disabled(ST disable)两边都不进。
  assert.deepEqual(input.candidates.map(c => c.path), ['green.md'])
  assert.deepEqual(input.constantCandidates?.map(c => c.path), ['blue.md'])
})

test('buildWorldbookMatchInput respects scanDepth from settings and defaults to 2', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: '1' },
    { role: 'assistant', content: '2' },
    { role: 'user', content: '3' },
  ]
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['x'], order: 1, weight: 0, content: '' },
  ])
  const one = buildWorldbookMatchInput(
    makeIntent(),
    makeCtx({ store, history, scanDepth: 1 }),
  )
  assert.equal(one.scanDepth, 1)
  assert.deepEqual(one.recentMessages.map(m => m.content), ['3'])

  const two = buildWorldbookMatchInput(makeIntent(), makeCtx({ store, history }))
  assert.equal(two.scanDepth, 2)
  assert.deepEqual(two.recentMessages.map(m => m.content), ['2', '3'])
})

test('buildWorldbookMatchInput exposes ST min-activation history and active book names', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: '旧消息' },
    { role: 'assistant', content: '新消息' },
  ]
  const store = new MemoryWorldbookStore([
    { path: 'book.md', sourceBookId: 'worldbook:魔法书', keywords: ['魔法书'], order: 1, weight: 1, content: '' },
  ])
  const input = buildWorldbookMatchInput(
    makeIntent(),
    {
      ...makeCtx({ store, history }),
      worldbookSettings: {
        scanDepth: 1,
        useLlmMatcher: false,
        minActivations: 2,
        minActivationsDepthMax: 4,
        includeNames: true,
      },
    },
  )
  assert.equal(input.scanDepth, 1)
  assert.deepEqual(input.recentMessages.map(message => message.content), ['旧消息', '新消息'])
  assert.equal(input.minActivations, 2)
  assert.equal(input.minActivationsDepthMax, 4)
  assert.deepEqual(input.globalScanData?.worldbookNames, ['魔法书'])
})

test('ST global names can activate an entry even when chat depth is zero', () => {
  const matches = deterministicWorldbookMatch({
    intent: makeIntent(),
    scanDepth: 0,
    recentMessages: [],
    globalScanData: { worldbookNames: ['魔法书'] },
    includeNames: true,
    candidates: [makeCandidate({ path: 'book.md', keys: ['魔法书'] })],
  }, { rollProbability: false })
  assert.deepEqual(matches.map(candidate => candidate.path), ['book.md'])
})

test('ST min_activations widens the initial scan without an extra LLM call', () => {
  const matches = deterministicWorldbookMatch({
    intent: makeIntent(),
    scanDepth: 1,
    minActivations: 1,
    minActivationsDepthMax: 2,
    recentMessages: [
      { role: 'user', content: '旧消息有火' },
      { role: 'assistant', content: '新消息无关' },
    ],
    candidates: [makeCandidate({ path: 'old.md', keys: ['火'] })],
  }, { rollProbability: false })
  assert.deepEqual(matches.map(candidate => candidate.path), ['old.md'])
})

test('ST global recursion and max recursion steps apply to entries without local flags', () => {
  const matches = deterministicWorldbookMatch({
    intent: makeIntent({ keywords: ['start'] }),
    scanDepth: 2,
    recentMessages: [],
    recursive: true,
    maxRecursionSteps: 1,
    candidates: [
      makeCandidate({ path: 'root.md', keys: ['start'], recursiveBookId: 'book', recursiveContent: 'next' }),
      makeCandidate({ path: 'next.md', keys: ['next'], recursiveBookId: 'book', recursiveContent: 'late' }),
      makeCandidate({ path: 'late.md', keys: ['late'], recursiveBookId: 'book' }),
    ],
  }, { rollProbability: false })
  assert.deepEqual(matches.map(candidate => candidate.path), ['root.md', 'next.md'])
})

test('ST global group scoring chooses the highest key-hit candidate', () => {
  const input = {
    intent: makeIntent({ keywords: ['火', '水'] }),
    scanDepth: 2,
    recentMessages: [{ role: 'user' as const, content: '火水' }],
    useGroupScoring: true,
    candidates: [],
  }
  const result = filterInclusionGroupCandidates([
    makeCandidate({ path: 'one.md', keys: ['火'], group: 'scene' }),
    makeCandidate({ path: 'two.md', keys: ['火', '水'], group: 'scene' }),
  ], input, () => 0.99)
  assert.deepEqual(result.map(candidate => candidate.path), ['two.md'])
})

test('buildWorldbookMatchInput substitutes {{user}}/{{char}} macros in keys', () => {
  const store = new MemoryWorldbookStore([
    {
      path: 'a.md',
      keywords: ['{{user}}的剑', '{{char}}的过去'],
      secondaryKeywords: ['{{user}}'],
      order: 1, weight: 0, content: '',
    },
  ])
  const input = buildWorldbookMatchInput(
    makeIntent(),
    makeCtx({ store, macros: { user: '小明', char: '晓' } }),
  )
  assert.deepEqual(input.candidates[0]?.keys, ['小明的剑', '晓的过去'])
  assert.deepEqual(input.candidates[0]?.secondaryKeys, ['小明'])
})

test('buildWorldbookMatchInput carries ST entry params (logic/probability/flags)', () => {
  const store = new MemoryWorldbookStore([
    {
      path: 'a.md', keywords: ['x'], order: 2, weight: 9, content: '',
      secondaryKeywords: ['y'], selectiveLogic: 'not-all', caseSensitive: true,
      matchWholeWords: true, useRegex: true, probability: 40, useProbability: false,
    },
  ])
  const input = buildWorldbookMatchInput(makeIntent(), makeCtx({ store }))
  const c = input.candidates[0]
  assert.equal(c?.selectiveLogic, 'not-all')
  assert.equal(c?.caseSensitive, true)
  assert.equal(c?.matchWholeWords, true)
  assert.equal(c?.useRegex, true)
  assert.equal(c?.probability, 40)
  assert.equal(c?.useProbability, false)
})

test('buildWorldbookMatchInput carries inclusion-group metadata', () => {
  const store = new MemoryWorldbookStore([{
    path: 'grouped.md', keywords: ['x'], order: 2, weight: 9, content: '',
    group: 'scene, mood', groupOverride: true, groupWeight: 4, useGroupScoring: true,
  }])
  const candidate = buildWorldbookMatchInput(makeIntent(), makeCtx({ store })).candidates[0]
  assert.equal(candidate?.group, 'scene, mood')
  assert.equal(candidate?.groupOverride, true)
  assert.equal(candidate?.groupWeight, 4)
  assert.equal(candidate?.useGroupScoring, true)
})

test('buildWorldbookMatchInput carries source-book budget metadata', () => {
  const store = new MemoryWorldbookStore([{
    path: 'book/entry.md', keywords: ['x'], order: 2, weight: 9, content: '',
    sourceBookId: 'book', sourceBookTokenBudget: 128, priority: 7,
  }])
  const candidate = buildWorldbookMatchInput(makeIntent(), makeCtx({ store })).candidates[0]
  assert.equal(candidate?.sourceBookId, 'book')
  assert.equal(candidate?.sourceBookTokenBudget, 128)
  assert.equal(candidate?.priority, 7)
})

test('worldbook matcher includes only opted-in ST global scan fields', () => {
  const store = new MemoryWorldbookStore([
    {
      path: 'persona.md', keywords: ['用户设定'], order: 1, weight: 1, content: '',
      matchPersonaDescription: true,
    },
    {
      path: 'scenario.md', keywords: ['暮州'], order: 2, weight: 1, content: '',
      matchScenario: true,
    },
    {
      path: 'blocked.md', keywords: ['用户设定'], order: 3, weight: 1, content: '',
    },
  ])
  const input = buildWorldbookMatchInput(makeIntent(), makeCtx({
    store,
    globalScanData: {
      personaDescription: '用户设定：艾云浮',
      scenario: '故事发生在暮州',
    },
  }))
  const matched = deterministicWorldbookMatch(input, { rollProbability: false })
  assert.deepEqual(matched.map(candidate => candidate.path), ['persona.md', 'scenario.md'])
})

test('worldbook matcher includes Tavern Helper should_scan prompts in the local scan buffer', () => {
  const store = new MemoryWorldbookStore([
    { path: 'helper.md', keywords: ['暗号'], order: 1, weight: 1, content: '' },
  ])
  const helperState = {
    injectedPrompts: [{
      id: 'scan', scriptId: 'script', position: 'none', depth: 0, role: 'system',
      content: '暗号', shouldScan: true, once: false, order: 100,
    }],
  } as unknown as AgentContext['tavernHelperState']
  const input = buildWorldbookMatchInput(makeIntent(), makeCtx({ store, tavernHelperState: helperState }))
  assert.deepEqual(input.injectedScanText, ['暗号'])
  assert.deepEqual(
    deterministicWorldbookMatch(input, { rollProbability: false }).map(candidate => candidate.path),
    ['helper.md'],
  )
})

test('buildWorldbookMatchInput carries recursive source metadata and macro-expanded content', () => {
  const store = new MemoryWorldbookStore([{
    path: 'card/root.md', keywords: ['start'], order: 1, weight: 1,
    content: '{{user}} reveals the next-key',
    recursiveScanning: true,
    recursiveBookId: 'card:book',
    excludeRecursion: true,
    preventRecursion: true,
    delayUntilRecursion: 2,
  }])
  const input = buildWorldbookMatchInput(
    makeIntent(),
    makeCtx({ store, macros: { user: '小明', char: '晓' } }),
  )
  const candidate = input.candidates[0]
  assert.equal(candidate?.recursiveScanning, true)
  assert.equal(candidate?.recursiveBookId, 'card:book')
  assert.equal(candidate?.excludeRecursion, true)
  assert.equal(candidate?.preventRecursion, true)
  assert.equal(candidate?.delayUntilRecursion, 2)
  assert.equal(candidate?.recursiveContent, '小明 reveals the next-key')
})

test('buildWorldbookMatchInput carries deterministic activation for special green entries', () => {
  const store = new MemoryWorldbookStore([
    {
      path: 'active-generate.md', keywords: ['火系'], order: 1, weight: 1,
      content: 'active', comment: '[GENERATE:AFTER]',
    },
    {
      path: 'inactive-generate.md', keywords: ['冰系'], order: 2, weight: 1,
      content: 'inactive', comment: '[GENERATE:AFTER]',
    },
  ])
  const input = buildWorldbookMatchInput(makeIntent({ keywords: ['火系'] }), makeCtx({ store }))
  assert.equal(input.pluginCandidates?.find(c => c.path === 'active-generate.md')?.active, true)
  assert.equal(input.pluginCandidates?.find(c => c.path === 'inactive-generate.md')?.active, false)
})

// ─── worldbookMatchAgent.run (integration) ──────────────────────────────────

test('worldbookMatchAgent.run returns empty when candidates are empty (no LLM call)', async () => {
  let providerCalled = false
  const provider: LLMProvider = {
    name: 'spy',
    async chat() { providerCalled = true; return { content: '{}' } },
  }
  const ctx = makeCtx({
    provider,
    store: new MemoryWorldbookStore([
      { path: 'blue.md', keywords: ['蓝'], order: 1, weight: 1, content: 'B', constant: true },
    ]),
    history: [{ role: 'user', content: 'hi' }],
  })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent(), ctx), ctx)
  assert.deepEqual(result.matches, [])
  assert.equal(providerCalled, false)
})

test('worldbookMatchAgent emits plugin plans locally and never sends special entries to the matcher', async () => {
  let providerCalled = false
  const provider: LLMProvider = {
    name: 'spy',
    async chat(messages) {
      providerCalled = true
      assert.ok(!messages.some(message => message.content.includes('SPECIAL_ONLY')))
      return { content: '{}' }
    },
  }
  const ctx = makeCtx({
    provider,
    store: new MemoryWorldbookStore([
      { path: 'special.md', keywords: [], order: 1, weight: 1, content: 'SPECIAL_ONLY', comment: '@INJECT pos=0,role=system' },
      { path: 'ordinary.md', keywords: ['火系'], order: 2, weight: 1, content: 'ordinary' },
    ]),
    history: [{ role: 'user', content: '火系' }],
  })
  const result = await worldbookMatchAgent.run(
    buildWorldbookMatchInput(makeIntent({ keywords: ['火系'] }), ctx),
    ctx,
  )
  assert.equal(providerCalled, true)
  assert.equal(result.plugin?.promptInjections[0]?.content, 'SPECIAL_ONLY')
  assert.deepEqual(result.matches.map(match => match.path), ['ordinary.md'])
})

test('worldbookMatchAgent uses one semantic call and recursively activates content from its seed', async () => {
  let providerCalls = 0
  const provider: LLMProvider = {
    name: 'one-call-seed',
    async chat() {
      providerCalls += 1
      return { content: JSON.stringify({ matches: [{ path: 'semantic-seed.md' }] }) }
    },
  }
  const store = new MemoryWorldbookStore([
    {
      path: 'semantic-seed.md', keywords: ['not-in-chat'], order: 1, weight: 1,
      content: 'recursive-key', recursiveScanning: true, recursiveBookId: 'external:book',
    },
    {
      path: 'recursive-target.md', keywords: ['recursive-key'], order: 2, weight: 1,
      content: 'target-content', recursiveScanning: true, recursiveBookId: 'external:book',
    },
    {
      path: 'other-book-target.md', keywords: ['recursive-key'], order: 3, weight: 1,
      content: 'wrong-book', recursiveScanning: true, recursiveBookId: 'other-book',
    },
  ])
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: 'ordinary' }] })
  const built = buildWorldbookMatchInput(makeIntent({ keywords: ['ordinary'] }), ctx)
  const result = await worldbookMatchAgent.run({ ...built, mode: 'native' }, ctx)

  assert.equal(providerCalls, 1)
  assert.deepEqual(result.matches.map(match => match.path), [
    'semantic-seed.md', 'recursive-target.md',
  ])
  assert.equal(result.matches[1]?.content, 'target-content')
})

test('worldbookMatchAgent.run returns empty when scan text is empty (no LLM call)', async () => {
  // 老用例的关键词为空场景:新语义下扫描文本 = 最近消息 + 意图关键词/叙述,
  // 两者都空 → 不值得调 LLM,直接空匹配。
  let providerCalled = false
  const provider: LLMProvider = {
    name: 'spy',
    async chat() { providerCalled = true; return { content: '{}' } },
  }
  const ctx = makeCtx({
    provider,
    store: new MemoryWorldbookStore([
      { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A' },
    ]),
  })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent(), ctx), ctx)
  assert.deepEqual(result.matches, [])
  assert.equal(providerCalled, false)
})

test('worldbookMatchAgent.run reads content from the worldbook store, not the LLM', async () => {
  const store = new MemoryWorldbookStore([
    { path: '魔法.md', keywords: ['火系'], order: 1, weight: 10, content: 'AUTHORITATIVE_1' },
    { path: '背景.md', keywords: ['莉娜'], order: 2, weight: 8, content: 'AUTHORITATIVE_2' },
  ])
  const provider: LLMProvider = {
    name: 'phony',
    async chat() {
      return { content: JSON.stringify({
        matches: [
          { path: '魔法.md', order: 1, weight: 10, content: 'LLM_HALLUCINATED_1' },
          { path: '背景.md', order: 2, weight: 8, content: 'LLM_HALLUCINATED_2' },
        ],
      }) }
    },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const result: WorldbookMatchOutput = await worldbookMatchAgent.run(
    buildWorldbookMatchInput(makeIntent({ keywords: ['火系', '莉娜'] }), ctx),
    ctx,
  )
  assert.equal(result.matches.length, 2)
  assert.equal(result.matches[0]?.path, '魔法.md')
  assert.equal(result.matches[0]?.content, 'AUTHORITATIVE_1')
  assert.equal(result.matches[1]?.path, '背景.md')
  assert.equal(result.matches[1]?.content, 'AUTHORITATIVE_2')
})

test('worldbookMatchAgent.run macro-substitutes matched content', async () => {
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['剑'], order: 1, weight: 5, content: '{{user}}握住{{char}}的手' },
  ])
  const provider: LLMProvider = {
    name: 'phony',
    async chat() {
      return { content: JSON.stringify({ matches: [{ path: 'a.md' }] }) }
    },
  }
  const ctx = makeCtx({
    provider, store,
    history: [{ role: 'user', content: '看剑' }],
    macros: { user: '小明', char: '晓' },
  })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent({ keywords: ['剑'] }), ctx), ctx)
  assert.equal(result.matches[0]?.content, '小明握住晓的手')
})

test('worldbookMatchAgent.run falls back to exact match when LLM returns garbage', async () => {
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A 正文' },
    { path: 'b.md', keywords: ['冰系'], order: 2, weight: 3, content: 'B 正文' },
  ])
  const provider: LLMProvider = {
    name: 'garbage',
    async chat() { return { content: 'totally not json' } },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent({ keywords: ['火系'] }), ctx), ctx)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]?.path, 'a.md')
  assert.equal(result.matches[0]?.content, 'A 正文')
})

test('worldbookMatchAgent.run skips paths the LLM invented', async () => {
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A' },
  ])
  const provider: LLMProvider = {
    name: 'phony',
    async chat() {
      return { content: JSON.stringify({
        matches: [
          { path: 'invented.md', order: 1, weight: 5 },  // not in candidates
          { path: 'a.md', order: 1, weight: 5, content: 'A' },
        ],
      }) }
    },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent({ keywords: ['火系'] }), ctx), ctx)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]?.path, 'a.md')
})

test('worldbookMatchAgent.run dedupes duplicate paths from the LLM', async () => {
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A' },
  ])
  const provider: LLMProvider = {
    name: 'phony',
    async chat() {
      return { content: JSON.stringify({
        matches: [
          { path: 'a.md', order: 1, weight: 5, content: 'A' },
          { path: 'a.md', order: 1, weight: 5, content: 'A' },
        ],
      }) }
    },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent({ keywords: ['火系'] }), ctx), ctx)
  assert.equal(result.matches.length, 1)
})

test('worldbookMatchAgent.run sorts by order asc, weight desc', async () => {
  const store = new MemoryWorldbookStore([
    { path: 'first.md', keywords: ['x'], order: 1, weight: 1, content: '' },
    { path: 'second_high.md', keywords: ['x'], order: 2, weight: 100, content: '' },
    { path: 'second_low.md', keywords: ['x'], order: 2, weight: 1, content: '' },
  ])
  const provider: LLMProvider = {
    name: 'phony',
    async chat() {
      return { content: JSON.stringify({
        matches: [
          { path: 'second_low.md', order: 2, weight: 1 },
          { path: 'first.md', order: 1, weight: 1 },
          { path: 'second_high.md', order: 2, weight: 100 },
        ],
      }) }
    },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: 'x' }] })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent({ keywords: ['x'] }), ctx), ctx)
  assert.equal(result.matches.length, 3)
  assert.equal(result.matches[0]?.path, 'first.md')
  assert.equal(result.matches[1]?.path, 'second_high.md')
  assert.equal(result.matches[2]?.path, 'second_low.md')
})

test('strict mode uses deterministic ST matching without an LLM call', async () => {
  let calls = 0
  const provider: LLMProvider = {
    name: 'strict-spy',
    async chat() { calls += 1; return { content: '{}' } },
  }
  const ctx = makeCtx({
    provider,
    store: new MemoryWorldbookStore([
      { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A' },
    ]),
    history: [{ role: 'user', content: '火系' }],
  })
  const result = await worldbookMatchAgent.run({
    intent: makeIntent({ userNarration: '火系', keywords: ['火系'] }),
    scanDepth: 2,
    recentMessages: [{ role: 'user', content: '火系' }],
    candidates: [makeCandidate({ owner: 'agent' })],
    mode: 'strict',
  }, ctx)
  assert.equal(calls, 0)
  assert.equal(result.matches[0]?.path, 'a.md')
  assert.equal(result.matches[0]?.source, 'st')
})

test('worldbook token budget keeps ST priority and ignoreBudget entries', () => {
  const input = {
    intent: makeIntent(),
    scanDepth: 2,
    recentMessages: [],
    maxContextTokens: 1_024,
    budgetPercent: 1,
    budgetCap: 0,
    candidates: [
      makeCandidate({ path: 'low.md', order: 1, weight: 1 }),
      makeCandidate({ path: 'high.md', order: 9, weight: 1 }),
      makeCandidate({ path: 'always.md', order: 2, weight: 1, ignoreBudget: true }),
    ],
  }
  const result = applyWorldbookTokenBudget(input, [
    { path: 'low.md', order: 1, weight: 1, content: 'x'.repeat(40) },
    { path: 'high.md', order: 9, weight: 1, content: 'high' },
    { path: 'always.md', order: 2, weight: 1, content: 'x'.repeat(40) },
  ])
  assert.ok(result)
  assert.deepEqual(result.matches.map(match => match.path), ['high.md', 'always.md'])
  assert.deepEqual(result.budget.droppedPaths, ['low.md'])
  assert.equal(result.budget.budgetTokens, 10)
  assert.equal(result.budget.usedTokens, 1)
})

test('worldbook source-book token budgets run before the shared session budget', () => {
  const input = {
    intent: makeIntent(),
    scanDepth: 2,
    recentMessages: [],
    maxContextTokens: 1_024,
    candidates: [
      makeCandidate({ path: 'book-a-low.md', sourceBookId: 'book-a', sourceBookTokenBudget: 2, priority: 1 }),
      makeCandidate({ path: 'book-a-high.md', sourceBookId: 'book-a', sourceBookTokenBudget: 2, priority: 9 }),
      makeCandidate({ path: 'book-b.md', sourceBookId: 'book-b', sourceBookTokenBudget: 8 }),
    ],
  }
  const result = applyWorldbookTokenBudget(input, [
    { path: 'book-a-low.md', order: 1, weight: 1, content: '12345678' },
    { path: 'book-a-high.md', order: 2, weight: 1, content: 'high' },
    { path: 'book-b.md', order: 3, weight: 1, content: 'book-b' },
  ])
  assert.ok(result)
  assert.deepEqual(result.matches.map(match => match.path), ['book-a-high.md', 'book-b.md'])
  assert.deepEqual(result.budget.sourceBooks, [{
    sourceBookId: 'book-a', budgetTokens: 2, usedTokens: 1, droppedPaths: ['book-a-low.md'],
  }, {
    sourceBookId: 'book-b', budgetTokens: 8, usedTokens: 2, droppedPaths: [],
  }])
  assert.deepEqual(result.budget.droppedPaths, ['book-a-low.md'])
})

test('worldbook budget accounts for constant entries and returns their kept paths', () => {
  const input = {
    intent: makeIntent(),
    scanDepth: 2,
    recentMessages: [],
    maxContextTokens: 1_024,
    budgetPercent: 1,
    candidates: [makeCandidate({ path: 'green.md', order: 1 })],
    constantCandidates: [makeCandidate({ path: 'blue.md', order: 9, constant: true })],
  }
  const result = applyWorldbookTokenBudget(
    input,
    [{ path: 'green.md', order: 1, weight: 1, content: 'x'.repeat(40) }],
    [{ path: 'blue.md', order: 9, weight: 1, content: 'blue' }],
  )
  assert.ok(result)
  assert.deepEqual(result.matches, [])
  assert.deepEqual(result.budget.keptConstantPaths, ['blue.md'])
  assert.deepEqual(result.budget.droppedPaths, ['green.md'])
})

test('enhanced mode keeps ST matches and adds agent matches in one LLM call', async () => {
  let calls = 0
  let capturedPrompt = ''
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A' },
    { path: 'b.md', keywords: ['完全不同'], order: 2, weight: 4, content: 'B' },
  ])
  const provider: LLMProvider = {
    name: 'enhanced-spy',
    async chat(messages) {
      calls += 1
      capturedPrompt = messages[0]?.content ?? ''
      return { content: JSON.stringify({ matches: [{ path: 'a.md' }, { path: 'b.md' }] }) }
    },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const result = await worldbookMatchAgent.run({
    intent: makeIntent({ userNarration: '火系', keywords: ['火系'] }),
    scanDepth: 2,
    recentMessages: [{ role: 'user', content: '火系' }],
    candidates: [
      makeCandidate({ path: 'a.md', owner: 'agent' }),
      makeCandidate({ path: 'b.md', keys: ['完全不同'], owner: 'agent', order: 2, weight: 4 }),
    ],
    mode: 'enhanced',
  }, ctx)
  assert.equal(calls, 1)
  assert.ok(capturedPrompt.includes('a.md'), 'the ST baseline is input to the same semantic call')
  assert.deepEqual(result.matches.map(match => [match.path, match.source]), [
    ['a.md', 'st+agent'],
    ['b.md', 'agent'],
  ])
})

test('enhanced mode rolls an agent-owned ST-key match only once', async () => {
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A', probability: 50 },
  ])
  const provider: LLMProvider = {
    name: 'enhanced-probability-spy',
    async chat() {
      return { content: JSON.stringify({ matches: [{ path: 'a.md' }] }) }
    },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const originalRandom = Math.random
  const rolls = [0.1, 0.9]
  let calls = 0
  Math.random = () => {
    calls += 1
    return rolls.shift() ?? 0.9
  }
  try {
    const result = await worldbookMatchAgent.run({
      intent: makeIntent({ userNarration: '火系', keywords: ['火系'] }),
      scanDepth: 2,
      recentMessages: [{ role: 'user', content: '火系' }],
      candidates: [makeCandidate({ path: 'a.md', owner: 'agent', probability: 50 })],
      mode: 'enhanced',
    }, ctx)
    assert.equal(calls, 1)
    assert.deepEqual(result.matches.map(match => match.path), ['a.md'])
  } finally {
    Math.random = originalRandom
  }
})

test('native mode lets the agent decide ordinary green entries', async () => {
  let calls = 0
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A' },
  ])
  const provider: LLMProvider = {
    name: 'native-spy',
    async chat() {
      calls += 1
      return { content: JSON.stringify({ matches: [{ path: 'a.md' }] }) }
    },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const result = await worldbookMatchAgent.run({
    intent: makeIntent({ userNarration: '火系', keywords: ['火系'] }),
    scanDepth: 2,
    recentMessages: [{ role: 'user', content: '火系' }],
    candidates: [makeCandidate({ owner: 'agent' })],
    mode: 'native',
  }, ctx)
  assert.equal(calls, 1)
  assert.deepEqual(result.matches.map(match => [match.path, match.source]), [['a.md', 'agent']])
})

// ─── probability 掷骰收尾(agent 选中后由代码掷) ────────────────────────────

test('worldbookMatchAgent.run keeps probability=100 selections without rolling', async () => {
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A', probability: 100 },
  ])
  const provider: LLMProvider = {
    name: 'phony',
    async chat() { return { content: JSON.stringify({ matches: [{ path: 'a.md' }] }) } },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent({ keywords: ['火系'] }), ctx), ctx)
  assert.equal(result.matches.length, 1)
})

test('worldbookMatchAgent.run drops probability=0 selections (dice never passes)', async () => {
  // Math.random()*100 <= 0 仅当随机数恰好为 0(概率 2^-53),实测恒被掷掉。
  const store = new MemoryWorldbookStore([
    { path: 'zero.md', keywords: ['火系'], order: 1, weight: 5, content: 'A', probability: 0 },
    { path: 'full.md', keywords: ['火系'], order: 2, weight: 5, content: 'B' },
  ])
  const provider: LLMProvider = {
    name: 'phony',
    async chat() {
      return { content: JSON.stringify({ matches: [{ path: 'zero.md' }, { path: 'full.md' }] }) }
    },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent({ keywords: ['火系'] }), ctx), ctx)
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]?.path, 'full.md')
})

test('worldbookMatchAgent.run skips the dice when useProbability=false', async () => {
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A', probability: 0, useProbability: false },
  ])
  const provider: LLMProvider = {
    name: 'phony',
    async chat() { return { content: JSON.stringify({ matches: [{ path: 'a.md' }] }) } },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const result = await worldbookMatchAgent.run(buildWorldbookMatchInput(makeIntent({ keywords: ['火系'] }), ctx), ctx)
  assert.equal(result.matches.length, 1)
})

test('worldbookMatchAgent.run: probability statistics smoke (p=70 keeps ~70%)', async () => {
  // 统计冒烟:agent 选中后 p=70 的条目应约 70% 出现(允许 ±25% 容差,300 次采样)。
  const store = new MemoryWorldbookStore([
    { path: 'a.md', keywords: ['火系'], order: 1, weight: 5, content: 'A', probability: 70 },
  ])
  const provider: LLMProvider = {
    name: 'phony',
    async chat() { return { content: JSON.stringify({ matches: [{ path: 'a.md' }] }) } },
  }
  const ctx = makeCtx({ provider, store, history: [{ role: 'user', content: '火系' }] })
  const input = buildWorldbookMatchInput(makeIntent({ keywords: ['火系'] }), ctx)
  let kept = 0
  const samples = 300
  for (let i = 0; i < samples; i++) {
    const r = await worldbookMatchAgent.run(input, ctx)
    if (r.matches.length > 0) kept += 1
  }
  const ratio = kept / samples
  assert.ok(ratio > 0.45 && ratio < 0.95, `probability 70% smoke out of range: ${ratio}`)
})
