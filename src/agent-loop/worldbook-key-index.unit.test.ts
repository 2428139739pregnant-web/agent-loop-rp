import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildWorldbookKeyIndex,
  renderWorldbookKeyOnlyMd,
} from './worldbook-key-index.ts'
import type { WorldbookEntry } from './session.ts'

test('buildWorldbookKeyIndex keeps active green entries and marks ST-owned regex', () => {
  const entries: WorldbookEntry[] = [
    {
      path: '角色卡/背景', comment: '背景', keywords: ['{{char}}'], secondaryKeywords: ['{{user}}'],
      order: 2, weight: 3, content: 'must not be copied',
    },
    {
      path: '角色卡/蓝灯', keywords: ['blue'], constant: true,
      order: 1, weight: 10, content: 'blue content',
    },
    {
      path: '世界书/特殊', keywords: ['special'], comment: '@INJECT pos=0',
      order: 3, weight: 1, content: 'plugin content',
    },
    {
      path: '世界书/正则', keywords: ['/fire/i'], useRegex: true,
      order: 4, weight: 1, content: 'regex content',
    },
    {
      path: '世界书/禁用', keywords: ['disabled'], enabled: false,
      order: 5, weight: 1, content: 'disabled content',
    },
  ]

  const index = buildWorldbookKeyIndex(entries, { user: '小明', char: '晓' })
  assert.deepEqual(index.map(entry => entry.path), ['角色卡/背景', '世界书/正则'])
  assert.deepEqual(index[0]?.keys, ['晓'])
  assert.deepEqual(index[0]?.secondaryKeys, ['小明'])
  assert.equal(index[1]?.owner, 'st')

  const md = renderWorldbookKeyOnlyMd(index)
  assert.ok(md.includes('角色卡/背景'))
  assert.ok(md.includes('晓'))
  assert.ok(md.includes('世界书/正则'))
  assert.ok(!md.includes('must not be copied'))
  assert.ok(!md.includes('blue content'))
})
