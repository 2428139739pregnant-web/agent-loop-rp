import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectLorebook } from './lorebook.ts'
import type { ImportedLorebook, ImportedLorebookEntry } from './types.ts'

function entry(overrides: Partial<ImportedLorebookEntry> = {}): ImportedLorebookEntry {
  return {
    sourceId: 'entry',
    keys: ['trigger'],
    secondaryKeys: [],
    content: 'content',
    enabled: true,
    insertionOrder: 0,
    selective: false,
    constant: false,
    caseSensitive: false,
    matchWholeWords: false,
    secondaryLogic: 'and-any',
    position: 'after_char',
    ignoreBudget: false,
    useRegex: false,
    hasDecorators: false,
    ...overrides,
  }
}

function book(entries: readonly ImportedLorebookEntry[], overrides: Partial<ImportedLorebook> = {}): ImportedLorebook {
  return { recursiveScanning: false, entries, ...overrides }
}

test('ST default scan depth is two messages and constant entries ignore keys', () => {
  const result = inspectLorebook(book([
    entry({ sourceId: 'old', content: 'old', keys: ['old'] }),
    entry({ sourceId: 'constant', content: 'constant', keys: [], constant: true, insertionOrder: 1 }),
  ]), ['old', 'recent', 'latest'])

  assert.deepEqual(result.entries.map(value => [value.active, value.reason]), [
    [false, 'primary-unmatched'],
    [true, 'active-constant'],
  ])
})

test('secondary keys use all four ST selective logics', () => {
  const make = (secondaryLogic: ImportedLorebookEntry['secondaryLogic']): ImportedLorebook => book([
    entry({ keys: ['primary'], secondaryKeys: ['one', 'two'], selective: true, secondaryLogic }),
  ])
  const messages = ['primary one']
  assert.equal(inspectLorebook(make('and-any'), messages).entries[0]?.active, true)
  assert.equal(inspectLorebook(make('and-all'), messages).entries[0]?.active, false)
  assert.equal(inspectLorebook(make('not-any'), messages).entries[0]?.active, false)
  assert.equal(inspectLorebook(make('not-all'), messages).entries[0]?.active, true)
})

test('recursive activation scans newly inserted content without duplicating entries', () => {
  const result = inspectLorebook(book([
    entry({ sourceId: 'first', keys: ['first'], content: 'first mentions second', insertionOrder: 2 }),
    entry({ sourceId: 'second', keys: ['second'], content: 'second mentions third', insertionOrder: 1 }),
    entry({ sourceId: 'third', keys: ['third'], content: 'third', insertionOrder: 0 }),
  ], { recursiveScanning: true }), ['first'])

  assert.deepEqual(result.entries.filter(value => value.active).map(value => value.index), [0, 1, 2])
  assert.deepEqual(result.afterCharacter, ['third', 'second mentions third', 'first mentions second'])
})

test('minActivations expands only the message scan before recursion', () => {
  const result = inspectLorebook(book([
    entry({ sourceId: 'old', keys: ['old'], content: 'old' }),
    entry({ sourceId: 'new', keys: ['new'], content: 'new' }),
  ]), ['old', 'middle', 'new'], { scanDepth: 1, minActivations: 2, maxScanDepth: 3 })

  assert.deepEqual(result.entries.map(value => value.active), [true, true])
})

test('entry scan depth overrides the book and global scan depth', () => {
  const result = inspectLorebook(book([
    entry({ sourceId: 'entry-depth-one', keys: ['old'], scanDepth: 1 }),
    entry({ sourceId: 'entry-depth-three', keys: ['old'], scanDepth: 3, insertionOrder: 1 }),
  ], { scanDepth: 1 }), ['old', 'middle', 'latest'])

  assert.deepEqual(result.entries.map(value => value.active), [false, true])
})

test('recursive text is cumulative across passes', () => {
  const result = inspectLorebook(book([
    entry({ sourceId: 'seed', keys: [], constant: true, content: 'introduce secondary' }),
    entry({ sourceId: 'introduce', keys: ['introduce'], content: 'primary', insertionOrder: 1 }),
    entry({
      sourceId: 'selective',
      keys: ['primary'],
      secondaryKeys: ['secondary'],
      selective: true,
      content: 'selected',
      insertionOrder: 2,
    }),
  ], { recursiveScanning: true }), ['unrelated'])

  assert.equal(result.entries[2]?.active, true)
})

test('exclude recursion and prevent recursion follow their separate ST meanings', () => {
  const result = inspectLorebook(book([
    entry({ sourceId: 'seed', keys: [], constant: true, content: 'blocked-key forwarded-key' }),
    entry({ sourceId: 'prevent-source', keys: ['prevent-source'], content: 'prevented-key', preventRecursion: true }),
    entry({ sourceId: 'excluded', keys: ['blocked-key'], content: 'excluded', excludeRecursion: true }),
    entry({ sourceId: 'prevented', keys: ['prevented-key'], content: 'prevented' }),
    entry({ sourceId: 'forwarded', keys: ['forwarded-key'], content: 'forwarded' }),
  ], { recursiveScanning: true }), ['prevent-source'])

  assert.equal(result.entries[1]?.active, true)
  assert.equal(result.entries[2]?.active, false)
  assert.equal(result.entries[3]?.active, false)
  assert.equal(result.entries[4]?.active, true)
})

test('delay until recursion keeps an entry out of chat scans and admits it at its level', () => {
  const result = inspectLorebook(book([
    entry({ sourceId: 'seed', keys: [], constant: true, content: 'late-key' }),
    entry({ sourceId: 'late', keys: ['late-key'], content: 'late', delayUntilRecursion: 2 }),
  ], { recursiveScanning: true }), ['late-key'])

  assert.equal(result.entries[1]?.active, true)
  assert.equal(result.entries[1]?.reason, 'active-keyword')
})

test('active content is assembled in insertion order after recursive selection', () => {
  const result = inspectLorebook(book([
    entry({ keys: ['a'], content: 'A', insertionOrder: 20 }),
    entry({ keys: ['b'], content: 'B', insertionOrder: 10 }),
  ]), ['a b'])

  assert.deepEqual(result.afterCharacter, ['B', 'A'])
})
