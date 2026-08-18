import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fallbackKeywordScan,
  parseContextSegmentResponse,
  type ContextReader,
} from './context-process.ts'

/** Build a `ContextReader` stub from in-memory tables. */
function makeReader(
  conversations: ReadonlyArray<{ id: number; content: string }>,
  summaries: ReadonlyArray<{ id: number; summary: string }>,
): ContextReader {
  const byConv = new Map(conversations.map(c => [c.id, c]))
  const bySum = new Map(summaries.map(s => [s.id, s]))
  return {
    listConversations: () => conversations,
    readConversation: id => byConv.get(id),
    listSummaries: () => summaries,
    readSummary: id => bySum.get(id),
  }
}

test('parseContextSegmentResponse handles clean JSON', () => {
  const raw = JSON.stringify({
    segments: [
      { id: 1, mode: 'full' },
      { id: 2, mode: 'summary' },
      { id: 3, mode: 'drop' },
    ],
  })
  const result = parseContextSegmentResponse(raw)
  assert.equal(result.segments.length, 3)
  assert.equal(result.segments[0]?.id, 1)
  assert.equal(result.segments[0]?.mode, 'full')
  assert.equal(result.segments[2]?.mode, 'drop')
})

test('parseContextSegmentResponse extracts a ```json``` fenced code block', () => {
  const raw = '```json\n{"segments":[{"id":1,"mode":"full"}]}\n```'
  const result = parseContextSegmentResponse(raw)
  assert.equal(result.segments.length, 1)
  assert.equal(result.segments[0]?.mode, 'full')
})

test('parseContextSegmentResponse returns empty list on garbage input', () => {
  const result = parseContextSegmentResponse('not json at all')
  assert.deepEqual(result.segments, [])
})

test('parseContextSegmentResponse rejects the whole object on any illegal mode', () => {
  // schemastery's `z.union([...])` is strict: a single illegal value causes
  // the schema to throw, the `try` block is swallowed, and the fallback
  // ladder returns the empty list. Downstream code can then rebuild the
  // list from the keyword scan.
  const raw = JSON.stringify({
    segments: [
      { id: 1, mode: 'full' },
      { id: 2, mode: 'bogus' },
    ],
  })
  const result = parseContextSegmentResponse(raw)
  assert.deepEqual(result.segments, [])
})

test('fallbackKeywordScan matches by intent keyword in summary (case-insensitive)', () => {
  const reader = makeReader(
    [
      { id: 1, content: '...' },
      { id: 2, content: '...' },
      { id: 3, content: '...' },
    ],
    [
      { id: 1, summary: '讨论火系法术' },
      { id: 2, summary: '闲聊' },
      { id: 3, summary: '魔法历史' },
    ],
  )
  const segments = fallbackKeywordScan(
    { userNarration: '...', metaCommands: [], involvedCharacters: [], keywords: ['火系'] },
    [],
    reader,
  )
  // id 1: '火系' in '讨论火系法术' → 'full'
  // id 2: miss → 'summary'
  // id 3: miss → 'summary'
  assert.equal(segments.length, 3)
  assert.equal(segments[0]?.mode, 'full')
  assert.equal(segments[1]?.mode, 'summary')
  assert.equal(segments[2]?.mode, 'summary')
})

test('fallbackKeywordScan also uses worldbook paths as needles', () => {
  const reader = makeReader(
    [{ id: 1, content: '...' }],
    [{ id: 1, summary: '角色在 北方渔村 出生的故事' }],
  )
  // '北方渔村' does not appear in the summary, but the worldbook path
  // '角色/北方渔村.md' lowercased to '角色/北方渔村.md' is not a substring
  // either — so we rely on the basename '北方渔村.md' instead.
  const segments = fallbackKeywordScan(
    { userNarration: '...', metaCommands: [], involvedCharacters: [], keywords: [] },
    ['角色/北方渔村.md'],
    reader,
  )
  // '角色/北方渔村.md' lowered is a substring of the summary? No — the
  // summary doesn't contain the slash. Expect 'summary'.
  assert.equal(segments[0]?.mode, 'summary')

  // Now a path whose components actually appear in the summary.
  const reader2 = makeReader(
    [{ id: 1, content: '...' }],
    [{ id: 1, summary: '北方渔村 出身' }],
  )
  const segments2 = fallbackKeywordScan(
    { userNarration: '...', metaCommands: [], involvedCharacters: [], keywords: [] },
    ['北方渔村'],
    reader2,
  )
  assert.equal(segments2[0]?.mode, 'full')
})

test('fallbackKeywordScan returns drop for segments with no summary', () => {
  const reader = makeReader(
    [
      { id: 1, content: '...' },
      { id: 2, content: '...' },
    ],
    [], // no summaries yet
  )
  const segments = fallbackKeywordScan(
    { userNarration: '...', metaCommands: [], involvedCharacters: [], keywords: ['火系'] },
    [],
    reader,
  )
  assert.equal(segments.length, 2)
  assert.equal(segments[0]?.mode, 'drop')
  assert.equal(segments[1]?.mode, 'drop')
})
