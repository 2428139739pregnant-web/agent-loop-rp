import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyWorldbookEntry } from './worldbook-compat.ts'
import { resolveWorldbookMatches } from './worldbook-resolver.ts'
import type { WorldbookEntry } from './session.ts'

function entry(overrides: Partial<WorldbookEntry> = {}): WorldbookEntry {
  return {
    path: 'book/entry.md',
    keywords: ['魔法'],
    order: 1,
    weight: 5,
    content: '知识',
    ...overrides,
  }
}

test('classifyWorldbookEntry sends ordinary green entries to the agent lane', () => {
  const result = classifyWorldbookEntry(entry())
  assert.equal(result.owner, 'agent')
  assert.equal(result.agentEligible, true)
  assert.deepEqual(result.pluginKinds, [])
})

test('classifyWorldbookEntry keeps constant and native regex entries in the ST lane', () => {
  assert.equal(classifyWorldbookEntry(entry({ constant: true })).owner, 'st')
  assert.equal(classifyWorldbookEntry(entry({ useRegex: true })).owner, 'st')
})

test('classifyWorldbookEntry isolates extension directives but keeps EJS-only lore activatable', () => {
  const inject = classifyWorldbookEntry(entry({ comment: '@INJECT pos=0,role=system' }))
  assert.equal(inject.owner, 'plugin')
  assert.ok(inject.pluginKinds.includes('inject'))

  const generate = classifyWorldbookEntry(entry({ comment: '[GENERATE:REGEX:魔法]' }))
  assert.equal(generate.owner, 'plugin')
  assert.ok(generate.pluginKinds.includes('generate'))

  const ejs = classifyWorldbookEntry(entry({ content: '<%= variables.magic %>' }))
  assert.equal(ejs.owner, 'agent')
  assert.equal(ejs.agentEligible, true)
  assert.ok(ejs.pluginKinds.includes('ejs'))
})

test('disabled special entries stay in the plugin lane, ordinary disabled entries stay inert', () => {
  const special = classifyWorldbookEntry(entry({ enabled: false, comment: '[GENERATE:AFTER]' }))
  assert.equal(special.owner, 'plugin')
  assert.ok(special.reasons.some(reason => reason.includes('disabled special')))
  assert.equal(classifyWorldbookEntry(entry({ enabled: false })).owner, 'disabled')
})

test('resolveWorldbookMatches is deterministic and never calls an LLM', () => {
  const result = resolveWorldbookMatches({
    st: { matches: [{ path: 'a', order: 2, weight: 1, content: 'A' }] },
    agent: {
      matches: [
        { path: 'a', order: 2, weight: 1, content: 'A from agent' },
        { path: 'b', order: 1, weight: 4, content: 'B' },
      ],
    },
  })
  assert.deepEqual(result.matches.map(match => [match.path, match.source]), [
    ['b', 'agent'],
    ['a', 'st+agent'],
  ])
  assert.equal(result.matches[1]?.content, 'A')
})
