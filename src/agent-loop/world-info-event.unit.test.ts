import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryWorldbookStore } from './session.ts'
import {
  buildWorldInfoActivatedEntries,
  buildWorldInfoEntriesLoadedEvent,
  buildWorldInfoScanDoneEvent,
  resolveWorldInfoEntryPath,
} from './world-info-event.ts'

test('WORLD_INFO_ACTIVATED projects green, constant, and forced entries with ST metadata', () => {
  const store = new MemoryWorldbookStore([
    {
      path: 'book/green.md', sourceBookId: 'worldbook:book', sourceBookName: '展示世界书', sourceUid: 3, keywords: ['魔法'],
      secondaryKeywords: ['火'], selective: true, selectiveLogic: 'and-all',
      order: 2, weight: 10, content: 'GREEN', position: 4, depth: 3,
    },
    {
      path: 'book/blue.md', sourceBookId: 'worldbook:book', keywords: [],
      order: 1, weight: 20, content: 'BLUE', constant: true, position: 0,
    },
    {
      path: 'book/forced.md', sourceBookId: 'worldbook:book', keywords: ['never'],
      order: 3, weight: 1, content: 'FORCED', enabled: true, position: 7,
    },
  ])
  const result = buildWorldInfoActivatedEntries([
    { path: 'book/green.md', order: 2, weight: 10, content: 'GREEN', position: 4 },
  ], store, new Map([['book/forced.md', true]]))

  assert.deepEqual(result.map(entry => entry.uid), ['book/blue.md', 3, 'book/forced.md'])
  assert.equal(result[1]?.world, '展示世界书')
  assert.equal(result[0]?.constant, true)
  assert.equal(result[0]?.position, 0)
  assert.equal(result[1]?.selectiveLogic, 3)
  assert.deepEqual(result[1]?.keysecondary, ['火'])
  assert.equal(result[2]?.source, 'plugin')
})

test('constant activation respects the World Info budget keep set', () => {
  const store = new MemoryWorldbookStore([
    { path: 'blue-a', keywords: [], order: 1, weight: 1, content: 'A', constant: true },
    { path: 'blue-b', keywords: [], order: 2, weight: 1, content: 'B', constant: true },
  ])
  const result = buildWorldInfoActivatedEntries([], store, new Map(), new Set(['blue-b']))
  assert.deepEqual(result.map(entry => entry.uid), ['blue-b'])
})

test('WORLDINFO_SCAN_DONE projects activated entries into a JSON-safe payload', () => {
  const store = new MemoryWorldbookStore([
    { path: 'book/a', sourceBookId: 'worldbook:book', keywords: ['a'], order: 1, weight: 1, content: 'A' },
  ])
  const result = buildWorldInfoScanDoneEvent(
    [{ path: 'book/a', order: 1, weight: 1, content: 'A', source: 'st' }],
    store,
    { usedTokens: 12, droppedPaths: ['book/dropped'] },
    { sticky: { 'book/a': { start: 1, end: 2 } } },
  )

  assert.equal(result.state.next, 0)
  assert.equal(result.budget.current, 12)
  assert.equal(result.budget.overflowed, true)
  assert.equal(result.activated.entries['book.book/a']?.uid, 'book/a')
  assert.deepEqual(result.timedEffects, { sticky: { 'book/a': { start: 1, end: 2 } } })
})

test('WORLDINFO_ENTRIES_LOADED groups merged books by their source prefix', () => {
  const store = new MemoryWorldbookStore([
    { path: 'character/a', sourceBookId: 'character:卡', keywords: [], order: 2, weight: 1, content: 'A' },
    { path: 'worldbook/b', sourceBookId: 'worldbook:外部', keywords: [], order: 1, weight: 1, content: 'B' },
    { path: 'chat/c', sourceBookId: 'chat:当前', keywords: [], order: 3, weight: 1, content: 'C' },
    { path: 'persona/d', sourceBookId: 'persona:用户', keywords: [], order: 4, weight: 1, content: 'D' },
  ])
  const result = buildWorldInfoEntriesLoadedEvent(store)

  assert.deepEqual(result.characterLore.map(entry => entry.uid), ['character/a'])
  assert.deepEqual(result.globalLore.map(entry => entry.uid), ['worldbook/b'])
  assert.deepEqual(result.chatLore.map(entry => entry.uid), ['chat/c'])
  assert.deepEqual(result.personaLore.map(entry => entry.uid), ['persona/d'])
})

test('WORLDINFO_FORCE_ACTIVATE resolves raw Tavern world and uid across merged sources', () => {
  const store = new MemoryWorldbookStore([
    { path: '角色/条目', sourceBookId: 'character:角色', sourceBookName: '角色背景', sourceUid: 'card-7', keywords: [], order: 1, weight: 1, content: 'CARD' },
    { path: '世界书/外部/条目', sourceBookId: 'worldbook:外部', sourceBookName: '外部展示名', sourceUid: 'external-3', keywords: [], order: 2, weight: 1, content: 'EXTERNAL' },
    { path: '酒馆助手/插件书/9', sourceBookId: 'tavern-helper:插件书', sourceBookName: '插件书', sourceUid: '9', keywords: [], order: 3, weight: 1, content: 'HELPER' },
  ])

  assert.equal(resolveWorldInfoEntryPath(store, '角色背景', 'card-7'), '角色/条目')
  assert.equal(resolveWorldInfoEntryPath(store, '外部展示名', 'external-3'), '世界书/外部/条目')
  assert.equal(resolveWorldInfoEntryPath(store, '插件书', 9), '酒馆助手/插件书/9')
  assert.equal(resolveWorldInfoEntryPath(store, '不存在', 9), null)
})
