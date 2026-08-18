import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyLorebookEntries,
  classifyLorebookEntry,
  entryStPosition,
  loadCharacterCardFromJson,
  preprocessCharacterCard,
  type PreprocessedCharacter,
} from './character-loader.ts'
import type { ImportedCharacterCard, ImportedLorebookEntry } from '../import/types.ts'
import { parseCharacterCardJson } from '../import/character-card.ts'

// ─── 测试工具 ────────────────────────────────────────────────────────────────

/** 最小完整 V2 卡 JSON(带 mes_example / system_prompt / post_history_instructions
 *  与内嵌世界书),参考 character-loader.test-fixture.ts 的范式。 */
function fullCardJson(overrides: {
  mesExample?: string
  systemPrompt?: string
  postHistoryInstructions?: string
  bookEntries?: unknown[]
} = {}): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '测试角色',
      description: '主描述。',
      personality: '温和。',
      scenario: '图书馆。',
      first_mes: '你好。',
      mes_example: overrides.mesExample ?? '<START>\n{{user}}: 早\n{{char}}: 早安。',
      // V2 spec 校验要求这些字段存在(字符串),默认给空串;
      // "缺字段 → 空串默认"的语义在 preprocessCharacterCard 层测试(见下)。
      system_prompt: overrides.systemPrompt ?? '',
      post_history_instructions: overrides.postHistoryInstructions ?? '',
      alternate_greetings: [],
      creator_notes: '',
      creator: 'unit-test',
      character_version: '1.0',
      tags: [],
      extensions: {},
      character_book: {
        name: '测试书',
        entries: overrides.bookEntries ?? [],
      },
    },
  })
}

/** 一条内嵌书条目(V2 spec 字段 + ST extensions)。 */
function bookEntry(o: {
  id: number
  content: string
  constant?: boolean
  enabled?: boolean
  position?: 'before_char' | 'after_char'
  stPosition?: number
  keys?: string[]
  secondaryKeys?: string[]
  order?: number
  selectiveLogic?: number
  probability?: number
}): Record<string, unknown> {
  return {
    id: o.id,
    keys: o.keys ?? [],
    secondary_keys: o.secondaryKeys ?? [],
    content: o.content,
    enabled: o.enabled ?? true,
    insertion_order: o.order ?? 100,
    constant: o.constant ?? false,
    position: o.position ?? 'after_char',
    extensions: {
      ...(o.stPosition !== undefined ? { position: o.stPosition } : {}),
      ...(o.selectiveLogic !== undefined ? { selectiveLogic: o.selectiveLogic } : {}),
      ...(o.probability !== undefined ? { probability: o.probability } : {}),
    },
  }
}

/** 一条**已解析**的 ImportedLorebookEntry(classify 系列直接吃这个形态)。 */
function mkEntry(o: {
  id: number
  content: string
  constant?: boolean
  enabled?: boolean
  position?: 'before_char' | 'after_char'
  stPosition?: number
  order?: number
}): ImportedLorebookEntry {
  return {
    sourceId: String(o.id),
    keys: [],
    secondaryKeys: [],
    content: o.content,
    enabled: o.enabled ?? true,
    insertionOrder: o.order ?? 100,
    selective: false,
    constant: o.constant ?? false,
    caseSensitive: false,
    matchWholeWords: false,
    secondaryLogic: 'and-any',
    position: o.position ?? 'after_char',
    ...(o.stPosition !== undefined ? { stPosition: o.stPosition } : {}),
    ignoreBudget: false,
    useRegex: false,
    hasDecorators: false,
  }
}

function asEntry(value: unknown): ImportedLorebookEntry {
  return value as ImportedLorebookEntry
}

// ─── 新字段提取:mes_example / system_prompt / post_history_instructions ─────

test('preprocess extracts mes_example / system_prompt / post_history_instructions', () => {
  const p = loadCharacterCardFromJson(fullCardJson({
    mesExample: '<START>\n{{user}}: 你好\n{{char}}: 幸会。',
    systemPrompt: '以第一人称扮演。',
    postHistoryInstructions: '回复保持在 200 字内。',
  }))
  assert.equal(p.mesExample, '<START>\n{{user}}: 你好\n{{char}}: 幸会。')
  assert.equal(p.systemPrompt, '以第一人称扮演。')
  assert.equal(p.postHistoryInstructions, '回复保持在 200 字内。')
})

test('empty system_prompt / post_history_instructions stay empty strings (no placeholder injection)', () => {
  // JSON 层 V2 spec 要求字段存在;空串是合法值 → preprocess 原样保留空串,
  // 由 response 端渲染占位(不在这里混入 style)。
  const p = loadCharacterCardFromJson(fullCardJson({ systemPrompt: '', postHistoryInstructions: '' }))
  assert.equal(p.systemPrompt, '')
  assert.equal(p.postHistoryInstructions, '')
})

test('preprocess defaults the three fields to empty string when the card object omits them', () => {
  // 直接喂 preprocess 一个缺字段的卡对象(模拟旧存档 / wire 反序列化路径):
  // 三字段 undefined → 空串默认,消费端(response)按占位处理。
  const card = parseCharacterCardJson(fullCardJson())
  const stripped: Record<string, unknown> = { ...card }
  delete stripped.messageExample
  delete stripped.systemPrompt
  delete stripped.postHistoryInstructions
  const p = preprocessCharacterCard(stripped as unknown as ImportedCharacterCard)
  assert.equal(p.mesExample, '')
  assert.equal(p.systemPrompt, '')
  assert.equal(p.postHistoryInstructions, '')
})

test('style doc no longer embeds system_prompt / post_history_instructions (moved to dedicated fields)', () => {
  const p = loadCharacterCardFromJson(fullCardJson({
    systemPrompt: 'SYS_MARKER_不要重复',
    postHistoryInstructions: 'PHI_MARKER_不要重复',
  }))
  assert.ok(!p.style.includes('SYS_MARKER_不要重复'))
  assert.ok(!p.style.includes('PHI_MARKER_不要重复'))
  assert.equal(p.systemPrompt, 'SYS_MARKER_不要重复')
  assert.equal(p.postHistoryInstructions, 'PHI_MARKER_不要重复')
})

// ─── 蓝灯条目:constant && !disable + position 映射 + order 降序 ──────────────

test('constant entry classification follows ST position mapping', () => {
  const before = mkEntry({ id: 1, content: 'A', constant: true, position: 'before_char' })
  const after = mkEntry({ id: 2, content: 'B', constant: true, position: 'after_char' })
  const atDepth = mkEntry({ id: 3, content: 'C', constant: true, stPosition: 4 })
  const anTop = mkEntry({ id: 4, content: 'D', constant: true, stPosition: 2 })
  const green = mkEntry({ id: 5, content: 'E', constant: false, position: 'before_char' })
  assert.equal(classifyLorebookEntry(before), 'persona')     // 0/before_char → persona
  assert.equal(classifyLorebookEntry(after), 'worldview')    // 1/after_char → worldview
  assert.equal(classifyLorebookEntry(atDepth), 'style')      // 4/atDepth → style 尾部(简化映射)
  assert.equal(classifyLorebookEntry(anTop), 'style')        // 2/ANTop → style 尾部
  assert.equal(classifyLorebookEntry(green), 'dynamic')      // 非常驻 → 绿灯
})

test('entryStPosition computes extensions.position ?? (before_char ? 0 : 1)', () => {
  assert.equal(entryStPosition(mkEntry({ id: 1, content: '', position: 'before_char' })), 0)
  assert.equal(entryStPosition(mkEntry({ id: 2, content: '', position: 'after_char' })), 1)
  assert.equal(entryStPosition(mkEntry({ id: 3, content: '', position: 'before_char', stPosition: 4 })), 4)
})

test('classifyLorebookEntries drops disabled entries entirely (ST disable)', () => {
  const split = classifyLorebookEntries({
    recursiveScanning: false,
    entries: [
      asEntry(bookEntry({ id: 1, content: 'keep-blue', constant: true, position: 'before_char' })),
      asEntry(bookEntry({ id: 2, content: 'drop-blue', constant: true, enabled: false, position: 'before_char' })),
      asEntry(bookEntry({ id: 3, content: 'keep-green', constant: false })),
      asEntry(bookEntry({ id: 4, content: 'drop-green', constant: false, enabled: false })),
    ],
  })
  assert.equal(split.persona.length, 1)
  assert.ok(split.persona[0]?.content.includes('keep-blue'))
  assert.equal(split.dynamic.length, 1)
  assert.ok(split.dynamic[0]?.content.includes('keep-green'))
})

test('constant blocks land in the position-mapped doc, sorted by order DESC (ST semantics)', () => {
  const p = loadCharacterCardFromJson(fullCardJson({
    bookEntries: [
      bookEntry({ id: 1, content: 'P_ORDER_5', constant: true, position: 'before_char', order: 5 }),
      bookEntry({ id: 2, content: 'P_ORDER_9', constant: true, position: 'before_char', order: 9 }),
      bookEntry({ id: 3, content: 'W_ORDER_3', constant: true, position: 'after_char', order: 3 }),
      bookEntry({ id: 4, content: 'S_ORDER_7', constant: true, stPosition: 6, order: 7 }),
      bookEntry({ id: 5, content: 'GREEN_BODY', constant: false, keys: ['钥匙'] }),
    ],
  }))
  // before_char → persona 文档,order 降序(9 在 5 前)
  assert.ok(p.persona.includes('P_ORDER_9'))
  assert.ok(p.persona.includes('P_ORDER_5'))
  assert.ok(p.persona.indexOf('P_ORDER_9') < p.persona.indexOf('P_ORDER_5'))
  // after_char → worldview 文档
  assert.ok(p.worldview.includes('W_ORDER_3'))
  // position 6(EMBottom)→ style 文档尾部(与 ST 的差异:8 插入点简化为三文档)
  assert.ok(p.style.includes('S_ORDER_7'))
  // 绿灯不进文档,走 dynamic
  assert.ok(!p.persona.includes('GREEN_BODY'))
  assert.ok(!p.worldview.includes('GREEN_BODY'))
  assert.ok(!p.style.includes('GREEN_BODY'))
  assert.equal(p.dynamicLorebookEntries.length, 1)
  assert.ok(p.dynamicLorebookEntries[0]?.content.includes('GREEN_BODY'))
  // 蓝灯条目不进动态池(避免双重注入)
  assert.equal(p.dynamicLorebookEntries.filter(e => e.constant).length, 0)
})

test('ST extensions (selectiveLogic / probability) are parsed through to lorebook entries', () => {
  const p = loadCharacterCardFromJson(fullCardJson({
    bookEntries: [
      bookEntry({ id: 1, content: 'X', constant: false, keys: ['k'], selectiveLogic: 2, probability: 40, stPosition: 1 }),
    ],
  }))
  const e = p.lorebook?.entries[0]
  assert.equal(e?.secondaryLogic, 'not-any')  // ST selectiveLogic 2 = NOT_ANY
  assert.equal(e?.probability, 40)
  assert.equal(e?.stPosition, 1)
})

test('preprocessed output keeps lorebook intact for the UI worldbook view', () => {
  const p: PreprocessedCharacter = loadCharacterCardFromJson(fullCardJson({
    bookEntries: [bookEntry({ id: 1, content: 'X', constant: true, position: 'before_char' })],
  }))
  assert.equal(p.lorebook?.entries.length, 1)
  assert.equal(p.lorebook?.name, '测试书')
})
