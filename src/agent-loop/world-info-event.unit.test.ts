import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryWorldbookStore } from './session.ts'
import { buildWorldInfoActivatedEntries } from './world-info-event.ts'

test('WORLD_INFO_ACTIVATED projects green, constant, and forced entries with ST metadata', () => {
  const store = new MemoryWorldbookStore([
    {
      path: 'book/green.md', sourceBookId: 'worldbook:book', keywords: ['魔法'],
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

  assert.deepEqual(result.map(entry => entry.uid), ['book/blue.md', 'book/green.md', 'book/forced.md'])
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
