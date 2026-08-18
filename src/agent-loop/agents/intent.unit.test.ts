import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyStarMarkerSemantics, parseIntentResponse } from './intent.ts'

test('parseIntentResponse handles a clean JSON object', () => {
  const raw = JSON.stringify({
    userNarration: '你好',
    metaCommands: [],
    involvedCharacters: ['莉娜'],
    keywords: ['火系'],
  })
  const result = parseIntentResponse(raw)
  assert.equal(result.userNarration, '你好')
  assert.deepEqual(result.involvedCharacters, ['莉娜'])
  assert.deepEqual(result.keywords, ['火系'])
})

test('parseIntentResponse extracts a markdown ```json``` code block', () => {
  const raw = '```json\n{"userNarration":"hi","keywords":[]}\n```'
  const result = parseIntentResponse(raw)
  assert.equal(result.userNarration, 'hi')
  assert.deepEqual(result.metaCommands, [])
  assert.deepEqual(result.keywords, [])
})

test('parseIntentResponse grabs an embedded JSON object from prose', () => {
  const raw = '好的,这是提取结果: {"userNarration":"hello","keywords":["a","b"]}'
  const result = parseIntentResponse(raw)
  assert.equal(result.userNarration, 'hello')
  assert.deepEqual(result.keywords, ['a', 'b'])
})

test('parseIntentResponse returns the empty schema on garbage input', () => {
  const result = parseIntentResponse('not json at all')
  assert.equal(result.userNarration, '')
  assert.deepEqual(result.metaCommands, [])
  assert.deepEqual(result.involvedCharacters, [])
  assert.deepEqual(result.keywords, [])
})

test('applyStarMarkerSemantics keeps unmarked text as speech', () => {
  const parsed = parseIntentResponse(JSON.stringify({
    userNarration: '模型误分的内容',
    metaCommands: ['模型误分的指令'],
    keywords: ['你好'],
  }))
  const result = applyStarMarkerSemantics('你好', parsed)
  assert.equal(result.userNarration, '你好')
  assert.deepEqual(result.metaCommands, [])
})

test('applyStarMarkerSemantics moves every starred segment to metaCommands', () => {
  const parsed = parseIntentResponse(JSON.stringify({
    userNarration: '',
    metaCommands: [],
    keywords: [],
  }))
  const result = applyStarMarkerSemantics('你好，*走向窗边*你还好吗？*时间快进到夜晚*', parsed)
  assert.equal(result.userNarration, '你好，你还好吗？')
  assert.deepEqual(result.metaCommands, ['走向窗边', '时间快进到夜晚'])
})
