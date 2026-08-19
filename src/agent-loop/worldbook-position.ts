import type { TavernWorldbookEntry } from '../tavern-helper.ts'
import type { WorldbookEntry } from './session.ts'

/** Convert Tavern Helper's named position to SillyTavern's World Info enum. */
export function tavernHelperWorldbookPosition(
  position: TavernWorldbookEntry['position']['type'],
): number {
  switch (position) {
    case 'before_character_definition': return 0
    case 'after_character_definition': return 1
    case 'before_example_messages': return 2
    case 'after_example_messages': return 3
    case 'before_author_note': return 5
    case 'after_author_note': return 6
    case 'outlet': return 7
    case 'at_depth': return 4
  }
}

/** Preserve Tavern Helper recursion controls in the common ST entry model. */
export function tavernHelperWorldbookMetadata(
  entry: TavernWorldbookEntry,
): Pick<WorldbookEntry, 'position' | 'depth' | 'role' | 'excludeRecursion' | 'preventRecursion' | 'delayUntilRecursion'> {
  return {
    position: tavernHelperWorldbookPosition(entry.position.type),
    depth: Math.max(0, Math.trunc(entry.position.depth)),
    role: entry.position.role,
    ...(entry.recursion.prevent_incoming ? { excludeRecursion: true } : {}),
    ...(entry.recursion.prevent_outgoing ? { preventRecursion: true } : {}),
    ...(entry.recursion.delay_until === null ? {} : { delayUntilRecursion: entry.recursion.delay_until }),
  }
}
