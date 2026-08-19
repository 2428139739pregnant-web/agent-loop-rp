import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tavernHelperWorldbookMetadata, tavernHelperWorldbookPosition } from './worldbook-position.ts'

test('Tavern Helper named positions preserve the ST World Info enum', () => {
  assert.deepEqual([
    tavernHelperWorldbookPosition('before_character_definition'),
    tavernHelperWorldbookPosition('after_character_definition'),
    tavernHelperWorldbookPosition('before_example_messages'),
    tavernHelperWorldbookPosition('after_example_messages'),
    tavernHelperWorldbookPosition('before_author_note'),
    tavernHelperWorldbookPosition('after_author_note'),
    tavernHelperWorldbookPosition('at_depth'),
    tavernHelperWorldbookPosition('outlet'),
  ], [0, 1, 2, 3, 5, 6, 4, 7])
})

test('Tavern Helper recursion controls map to the common ST entry model', () => {
  const metadata = tavernHelperWorldbookMetadata({
    uid: 1,
    name: 'entry',
    enabled: true,
    strategy: {
      type: 'selective', keys: [],
      keys_secondary: { logic: 'and_any', keys: [] },
      scan_depth: 'same_as_global',
    },
    position: { type: 'at_depth', role: 'assistant', depth: 8, order: 10 },
    content: 'content',
    probability: 100,
    recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: 2 },
    effect: { sticky: null, cooldown: null, delay: null },
  })
  assert.deepEqual(metadata, {
    position: 4,
    depth: 8,
    role: 'assistant',
    excludeRecursion: true,
    preventRecursion: true,
    delayUntilRecursion: 2,
  })
})
