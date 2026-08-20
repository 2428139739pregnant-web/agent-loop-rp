/** Project Agent RP's resolved World Info entries into SillyTavern's
 * WORLD_INFO_ACTIVATED payload vocabulary.
 *
 * The host keeps a path as the canonical entry id because card, imported and
 * Tavern Helper books are merged into one Store.  SillyTavern normally uses
 * a numeric uid local to a book; a stable string uid is safer here than
 * inventing a number that can change when books are reordered.
 */

import type { WorldbookEntry } from './session.ts'

export interface WorldInfoEventMatch {
  readonly path: string
  readonly order: number
  readonly weight: number
  readonly content: string
  readonly source?: string
  readonly position?: number
  readonly depth?: number
  readonly role?: 'system' | 'user' | 'assistant'
}

export interface WorldInfoActivatedEntry {
  readonly world: string
  readonly uid: string
  readonly key: readonly string[]
  readonly keysecondary: readonly string[]
  readonly comment: string
  readonly content: string
  readonly constant: boolean
  readonly vectorized: false
  readonly selective: boolean
  readonly selectiveLogic: number
  readonly order: number
  readonly position: number
  readonly disable: boolean
  readonly excludeRecursion: boolean
  readonly preventRecursion: boolean
  readonly delayUntilRecursion: boolean | number
  readonly probability: number
  readonly useProbability: boolean
  readonly depth: number
  readonly caseSensitive: boolean
  readonly matchWholeWords: boolean
  readonly group?: string
  readonly groupOverride?: boolean
  readonly groupWeight?: number
  readonly useGroupScoring?: boolean
  readonly scanDepth?: number
  readonly role?: 'system' | 'user' | 'assistant'
  readonly source?: string
}

function selectiveLogicValue(value: WorldbookEntry['selectiveLogic']): number {
  switch (value) {
    case 'not-all': return 1
    case 'not-any': return 2
    case 'and-all': return 3
    default: return 0
  }
}

function worldName(entry: Pick<WorldbookEntry, 'path' | 'sourceBookId'>): string {
  const source = entry.sourceBookId?.trim()
  if (source !== undefined && source.length > 0) {
    const separator = source.indexOf(':')
    return separator >= 0 ? source.slice(separator + 1) : source
  }
  const separator = entry.path.lastIndexOf('/')
  return separator > 0 ? entry.path.slice(0, separator) : entry.path
}

/** Convert one resolved match using authoritative Store metadata. */
export function toWorldInfoActivatedEntry(
  match: WorldInfoEventMatch,
  source: WorldbookEntry | undefined,
): WorldInfoActivatedEntry {
  const entry = source
  const position = match.position ?? entry?.position ?? 1
  const resolvedRole = match.role ?? entry?.role
  return {
    world: entry === undefined ? worldName({ path: match.path }) : worldName(entry),
    uid: match.path,
    key: [...(entry?.keywords ?? [])],
    keysecondary: [...(entry?.secondaryKeywords ?? [])],
    comment: entry?.comment ?? match.path,
    content: match.content,
    constant: entry?.constant === true,
    vectorized: false,
    selective: entry?.selective === true,
    selectiveLogic: selectiveLogicValue(entry?.selectiveLogic),
    order: match.order,
    position,
    disable: entry?.enabled === false,
    excludeRecursion: entry?.excludeRecursion === true,
    preventRecursion: entry?.preventRecursion === true,
    delayUntilRecursion: entry?.delayUntilRecursion ?? false,
    probability: entry?.probability ?? 100,
    useProbability: entry?.useProbability !== false,
    depth: match.depth ?? entry?.depth ?? 0,
    caseSensitive: entry?.caseSensitive === true,
    matchWholeWords: entry?.matchWholeWords === true,
    ...(entry?.group === undefined ? {} : { group: entry.group }),
    ...(entry?.groupOverride === undefined ? {} : { groupOverride: entry.groupOverride }),
    ...(entry?.groupWeight === undefined ? {} : { groupWeight: entry.groupWeight }),
    ...(entry?.useGroupScoring === undefined ? {} : { useGroupScoring: entry.useGroupScoring }),
    ...(entry?.scanDepth === undefined ? {} : { scanDepth: entry.scanDepth }),
    ...(resolvedRole === undefined ? {} : { role: resolvedRole }),
    ...(match.source === undefined ? {} : { source: match.source }),
  }
}

/**
 * Merge ordinary matches, constant entries and generation-scoped forced
 * entries once by canonical path.  The order follows the resolved prompt
 * set, so event listeners observe the same entries that the response stage
 * will consume.
 */
export function buildWorldInfoActivatedEntries(
  matches: readonly WorldInfoEventMatch[],
  worldbook: { list(): readonly WorldbookEntry[] },
  extraPaths: ReadonlyMap<string, boolean> = new Map(),
  allowedConstantPaths?: ReadonlySet<string>,
): readonly WorldInfoActivatedEntry[] {
  const entriesByPath = new Map(worldbook.list().map(entry => [entry.path, entry]))
  const merged = new Map<string, WorldInfoEventMatch>()
  for (const match of matches) merged.set(match.path, match)
  for (const entry of worldbook.list()) {
    if (entry.constant !== true || entry.enabled === false) continue
    if (allowedConstantPaths !== undefined && !allowedConstantPaths.has(entry.path)) continue
    if (!merged.has(entry.path)) {
      merged.set(entry.path, {
        path: entry.path,
        order: entry.order,
        weight: entry.weight,
        content: entry.content,
        ...(entry.position === undefined ? {} : { position: entry.position }),
        ...(entry.depth === undefined ? {} : { depth: entry.depth }),
        ...(entry.role === undefined ? {} : { role: entry.role }),
        source: 'st',
      })
    }
  }
  for (const [path, force] of extraPaths) {
    const entry = entriesByPath.get(path)
    if (entry === undefined || entry.enabled === false && force !== true) continue
    if (merged.has(path)) continue
    merged.set(path, {
      path: entry.path,
      order: entry.order,
      weight: entry.weight,
      content: entry.content,
      ...(entry.position === undefined ? {} : { position: entry.position }),
      ...(entry.depth === undefined ? {} : { depth: entry.depth }),
      ...(entry.role === undefined ? {} : { role: entry.role }),
      source: 'plugin',
    })
  }
  return [...merged.values()]
    .sort((left, right) => left.order - right.order || right.weight - left.weight || left.path.localeCompare(right.path))
    .map(match => toWorldInfoActivatedEntry(match, entriesByPath.get(match.path)))
}
