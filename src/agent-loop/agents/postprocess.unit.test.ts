import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage, ChatOptions, LLMProvider, LLMResult } from '../provider.ts'
import { MemorySessionStore, MemoryWorldbookStore } from '../session.ts'
import { InMemoryPromptLoader, type AgentContext } from './types.ts'
import {
  applyEdits,
  density,
  gate,
  parseJsonLoose,
  programmaticChecks,
  runPostprocessPipeline,
  type EditStats,
  type PostprocessImageryStore,
} from './postprocess.ts'
import { SpanEditOutputSchema, type SpanEditOutput } from '../schema.ts'

// ─── applyEdits ─────────────────────────────────────────────────────────────

test('applyEdits replaces a unique, long-enough anchor', () => {
  const text = '她在桌前坐下，继续处理桌上的文件，然后端起茶杯喝了一口。'
  const anchor = '继续处理桌上的文件，然后端起' // 14 chars ≥ ANCHOR_MIN
  assert.ok(anchor.length >= 12)
  const stats: EditStats = {}
  const out = applyEdits(text, [{ anchor, replacement: '先把孕肚安置妥当，再', op: 'A1', reason: '因果链' }], stats)
  assert.equal(out, '她在桌前坐下，先把孕肚安置妥当，再茶杯喝了一口。')
  assert.equal(stats.A1, 1)
  assert.equal(stats.anchor_miss, undefined)
})

test('applyEdits drops the edit when the anchor is not found', () => {
  const text = '她在桌前坐下，继续处理桌上的文件。'
  const stats: EditStats = {}
  const out = applyEdits(text, [{ anchor: '这段文字根本不存在于正文中啊', replacement: 'X', op: 'C2' }], stats)
  assert.equal(out, text)
  assert.equal(stats.anchor_miss, 1)
  assert.equal(stats.C2, undefined)
})

test('applyEdits drops the edit when the anchor matches more than once', () => {
  const text = '暮色缓缓沉入湖面尽头的远处。她停下脚步。暮色缓缓沉入湖面尽头的远处。'
  const anchor = '暮色缓缓沉入湖面尽头的远处' // 13 chars, appears twice
  assert.ok(anchor.length >= 12)
  const stats: EditStats = {}
  const out = applyEdits(text, [{ anchor, replacement: 'X', op: 'C3' }], stats)
  assert.equal(out, text)
  assert.equal(stats.anchor_ambiguous, 1)
})

test('applyEdits drops the edit when the anchor is shorter than the minimum', () => {
  const text = '她在桌前坐下，继续处理桌上的文件。'
  const stats: EditStats = {}
  const out = applyEdits(text, [{ anchor: '很短的锚点', replacement: 'X', op: 'A1' }], stats)
  assert.equal(out, text)
  assert.equal(stats.anchor_too_short, 1)
  assert.equal(stats.A1, undefined)
})

test('applyEdits applies edits sequentially and supports deletion (empty replacement)', () => {
  const text = '她扶着栏杆慢慢站了起来，又整理了一下衣角，随后推门走了出去。'
  const stats: EditStats = {}
  const out = applyEdits(text, [
    { anchor: '扶着栏杆慢慢站了起来，又', replacement: '扶着栏杆慢慢站了起来，肚子的重量让她顿了顿，随后', op: 'A1' },
    { anchor: '整理了一下衣角，随后推门', replacement: '', op: 'C4' },
  ], stats)
  assert.equal(out, '她扶着栏杆慢慢站了起来，肚子的重量让她顿了顿，随后走了出去。')
  assert.equal(stats.A1, 1)
  assert.equal(stats.C4, 1)
})

test('applyEdits with an empty edit list returns the text untouched', () => {
  const stats: EditStats = {}
  assert.equal(applyEdits('原文保持不变。', [], stats), '原文保持不变。')
  assert.deepEqual(stats, {})
})

// ─── parseJsonLoose ─────────────────────────────────────────────────────────

test('parseJsonLoose parses bare JSON', () => {
  const fallback: SpanEditOutput = { edits: [] }
  const out = parseJsonLoose<SpanEditOutput>(SpanEditOutputSchema as never, '{"edits":[{"anchor":"x一二三四五六七八九十一二","replacement":"r","op":"A1"}]}', fallback)
  assert.equal(out.edits.length, 1)
  assert.equal(out.edits[0]?.op, 'A1')
})

test('parseJsonLoose parses JSON inside a markdown fence', () => {
  const fallback: SpanEditOutput = { edits: [] }
  const raw = '好的，以下是编辑指令：\n```json\n{"edits":[{"anchor":"y二三四五六七八九十一二三四","replacement":"","op":"C4"}]}\n```'
  const out = parseJsonLoose<SpanEditOutput>(SpanEditOutputSchema as never, raw, fallback)
  assert.equal(out.edits.length, 1)
  assert.equal(out.edits[0]?.op, 'C4')
})

test('parseJsonLoose extracts the first {...} block out of prose', () => {
  const fallback: SpanEditOutput = { edits: [] }
  const raw = '这是你要的结果: {"edits":[]} 希望有帮助。'
  const out = parseJsonLoose<SpanEditOutput>(SpanEditOutputSchema as never, raw, fallback)
  assert.deepEqual(out, { edits: [] })
})

test('parseJsonLoose fills schema defaults for missing fields', () => {
  const fallback: SpanEditOutput = { edits: [] }
  const out = parseJsonLoose<SpanEditOutput>(SpanEditOutputSchema as never, '{"edits":[{"anchor":"z三四五六七八九十一二三四五"}]}', fallback)
  assert.equal(out.edits.length, 1)
  assert.equal(out.edits[0]?.replacement, '')
  assert.equal(out.edits[0]?.op, '?')
})

test('parseJsonLoose returns the fallback on garbage input', () => {
  const fallback: SpanEditOutput = { edits: [] }
  for (const garbage of ['完全不是 JSON', '{invalid json}', ''] ) {
    const out = parseJsonLoose<SpanEditOutput>(SpanEditOutputSchema as never, garbage, fallback)
    assert.equal(out, fallback)
  }
})

// ─── gate ───────────────────────────────────────────────────────────────────

test('gate passes text mentioning pregnancy-related keywords', () => {
  assert.equal(gate('她揉了揉隆起的孕肚。'), true)
  assert.equal(gate('胎动了一下。'), true)
  assert.equal(gate('她感到一阵宫缩。'), true)
})

test('gate blocks ordinary daily text', () => {
  assert.equal(gate('今天阳光明媚，她去了图书馆看书。'), false)
  assert.equal(gate(''), false)
})

// ─── density ────────────────────────────────────────────────────────────────

test('density measures the body-related sentence ratio', () => {
  const text = '她的孕肚在走动时晃动了一下。窗外的阳光很好，街道十分安静。'
  assert.equal(density(text), 0.5)
})

test('density returns 0 for text with no relevant sentences', () => {
  assert.equal(density('今天阳光明媚，她去了图书馆看书。风很轻。'), 0)
})

test('density ignores fenced code blocks and details blocks (status bars)', () => {
  const statusBar = '```\n三围: 88/70/96\n妊娠状态: 20周\n```\n'
  const details = '<details>孕肚巨大，宫缩频繁</details>'
  assert.equal(density(statusBar), 0)
  assert.equal(density(details), 0)
})

test('density drops sentence fragments shorter than 5 chars', () => {
  // '好。' is 1 char — dropped from both numerator and denominator.
  const text = '好。她的肚子在椅子上搁得稳稳的。'
  assert.equal(density(text), 1)
})

// ─── programmaticChecks ─────────────────────────────────────────────────────

const LONG_STATUS = '，一切指标平稳，胎儿发育正常，母体状态良好，无明显不适，日常活动自如，产检记录完整无误，情绪稳定睡眠充足'

test('programmaticChecks flags waist not being the largest measurement after mid-term', () => {
  const text = `三围: 88/70/96\n妊娠状态: 20周${LONG_STATUS}`
  const issues = programmaticChecks(text)
  const sizes = issues.filter(i => i.where === '三围')
  assert.equal(sizes.length, 1)
  assert.ok(sizes[0]?.fix.includes('腰围必须大于'))
})

test('programmaticChecks accepts waist-dominant measurements after mid-term', () => {
  const text = `三围: 88/99/96\n妊娠状态: 20周${LONG_STATUS}`
  const issues = programmaticChecks(text)
  assert.equal(issues.filter(i => i.where === '三围').length, 0)
  assert.equal(issues.filter(i => i.where === '产程').length, 0)
})

test('programmaticChecks flags labor language before week 36', () => {
  const text = `妊娠状态: 30周${LONG_STATUS}，她突然觉得羊水破了，宫口开了两指。`
  const issues = programmaticChecks(text)
  const labor = issues.filter(i => i.where === '产程')
  assert.equal(labor.length, 1)
  assert.ok(labor[0]?.fix.includes('不得出现破水'))
})

test('programmaticChecks allows labor language at term (>= 36 weeks)', () => {
  const text = `妊娠状态: 38周${LONG_STATUS}，羊水破了，产程正式开始。`
  const issues = programmaticChecks(text)
  assert.equal(issues.filter(i => i.where === '产程').length, 0)
})

test('programmaticChecks flags short status-bar field descriptions', () => {
  const issues = programmaticChecks('肚子状态: 太大了')
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.where, '肚子状态')
  assert.ok(issues[0]?.fix.includes('不足50字'))
})

test('programmaticChecks returns nothing for ordinary text', () => {
  assert.deepEqual(programmaticChecks('今天阳光明媚，她去了图书馆看书。'), [])
})

// ─── pipeline composition ──────────────────────────────────────────────────

class ChainedPostprocessProvider implements LLMProvider {
  readonly name = 'chained-postprocess-test'
  readonly inputs: string[] = []

  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<LLMResult> {
    const system = messages.find(m => m.role === 'system')?.content ?? ''
    const user = messages.find(m => m.role === 'user')?.content ?? ''
    this.inputs.push(user)

    if (system === 'A') {
      return {
        content: JSON.stringify({ edits: [{
          anchor: '她扶着门框站稳，孕肚在布料下轻轻起伏',
          replacement: '她扶着门框站稳，重心被腹部的分量往前牵，孕肚在布料下轻轻起伏，里面随即顶来一下',
          op: 'A1',
        }] }),
      }
    }
    if (system === 'B') {
      return {
        content: JSON.stringify({ edits: [{
          anchor: '重心被腹部的分量往前牵，孕肚在布料下轻轻起伏',
          replacement: '重心被腹部的分量往前牵，衣料在隆起处绷出细响，孕肚在布料下轻轻起伏',
          op: 'B1',
        }] }),
      }
    }
    if (system === 'C') {
      return {
        content: JSON.stringify({ edits: [{
          anchor: '衣料在隆起处绷出细响，孕肚在布料下轻轻起伏',
          replacement: '衣料在隆起处绷出细响，孕肚在布料下轻轻起伏，胎动把她的话截住半拍',
          op: 'C2',
        }] }),
      }
    }
    return { content: JSON.stringify({ sentences: [] }) }
  }
}

function makeChainedContext(provider: LLMProvider): AgentContext {
  const prompts = new InMemoryPromptLoader()
  prompts.set('postprocess-a', 'A')
  prompts.set('postprocess-b', 'B')
  prompts.set('postprocess-c', 'C')
  prompts.set('postprocess-extract', 'E')
  return {
    provider,
    model: 'test',
    temperature: 0.7,
    prompts,
    session: new MemorySessionStore(),
    worldbook: new MemoryWorldbookStore(),
    sessionId: 'postprocess-chain-test',
  }
}

test('runPostprocessPipeline chains A, B, and C edits onto the latest text', async () => {
  const provider = new ChainedPostprocessProvider()
  const ctx = makeChainedContext(provider)
  const imagery: PostprocessImageryStore = {
    list: async () => [],
    append: async () => undefined,
  }
  const raw = '她扶着门框站稳，孕肚在布料下轻轻起伏。'
  const expected = '她扶着门框站稳，重心被腹部的分量往前牵，衣料在隆起处绷出细响，孕肚在布料下轻轻起伏，胎动把她的话截住半拍，里面随即顶来一下。'

  const result = await runPostprocessPipeline(raw, ctx, { imageryStore: imagery })

  assert.equal(result, expected)
  assert.ok(provider.inputs.some(input => input.includes('重心被腹部的分量往前牵')))
  assert.ok(provider.inputs.some(input => input.includes('衣料在隆起处绷出细响')))
})

test('deferred imagery extraction does not delay the final postprocess result', async () => {
  const provider = new ChainedPostprocessProvider()
  const ctx = makeChainedContext(provider)
  let appendStarted = false
  let releaseAppend: () => void = () => undefined
  const appendBlocked = new Promise<void>(resolve => { releaseAppend = resolve })
  const imagery: PostprocessImageryStore = {
    list: async () => [],
    append: async () => {
      appendStarted = true
      await appendBlocked
    },
  }

  const result = await runPostprocessPipeline(
    '她扶着门框站稳，孕肚在布料下轻轻起伏。',
    ctx,
    { imageryStore: imagery, deferExtract: true },
  )

  assert.match(result, /胎动把她的话截住半拍/u)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(appendStarted, true)
  releaseAppend()
  await new Promise<void>(resolve => setImmediate(resolve))
})
