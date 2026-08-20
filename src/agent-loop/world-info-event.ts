/** Project Agent RP's resolved World Info entries into SillyTavern's
 * WORLD_INFO_ACTIVATED payload vocabulary.
 *
 * The host keeps a path as the canonical internal id because card, imported
 * and Tavern Helper books are merged into one Store. Public event payloads
 * retain the source book name and source uid whenever the importer has them.
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
  readonly uid: string | number
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

/** Observer payload used by Tavern's WORLDINFO_SCAN_DONE event. */
export interface WorldInfoScanDoneEvent {
  readonly state: { current: number; next: number; loopCount: number }
  readonly new: {
    readonly all: readonly WorldInfoActivatedEntry[]
    readonly successful: readonly WorldInfoActivatedEntry[]
  }
  readonly activated: {
    /** JSON-safe form; the iframe restores this to a Map before dispatch. */
    readonly entries: Readonly<Record<string, WorldInfoActivatedEntry>>
    readonly text: string
  }
  readonly sortedEntries: readonly WorldInfoActivatedEntry[]
  readonly recursionDelay: { readonly availableLevels: readonly number[]; readonly currentLevel: number | null }
  readonly budget: { readonly current: number; readonly overflowed: boolean }
  readonly timedEffects: Readonly<Record<string, unknown>>
}

/** Public World Info collection shape used by WORLDINFO_ENTRIES_LOADED. */
export interface WorldInfoEntriesLoadedEvent {
  readonly globalLore: readonly WorldInfoActivatedEntry[]
  readonly characterLore: readonly WorldInfoActivatedEntry[]
  readonly chatLore: readonly WorldInfoActivatedEntry[]
  readonly personaLore: readonly WorldInfoActivatedEntry[]
}

function selectiveLogicValue(value: WorldbookEntry['selectiveLogic']): number {
  switch (value) {
    case 'not-all': return 1
    case 'not-any': return 2
    case 'and-all': return 3
    default: return 0
  }
}

function worldName(entry: Pick<WorldbookEntry, 'path' | 'sourceBookId' | 'sourceBookName'>): string {
  const sourceName = entry.sourceBookName?.trim()
  if (sourceName !== undefined && sourceName.length > 0) return sourceName
  const source = entry.sourceBookId?.trim()
  if (source !== undefined && source.length > 0) {
    const separator = source.indexOf(':')
    return separator >= 0 ? source.slice(separator + 1) : source
  }
  const separator = entry.path.lastIndexOf('/')
  return separator > 0 ? entry.path.slice(0, separator) : entry.path
}

function worldInfoBookAliases(entry: WorldbookEntry): ReadonlySet<string> {
  const aliases = new Set<string>()
  const sourceName = entry.sourceBookName?.trim()
  if (sourceName !== undefined && sourceName.length > 0) aliases.add(sourceName)
  const source = entry.sourceBookId?.trim()
  if (source !== undefined && source.length > 0) {
    aliases.add(source)
    const separator = source.indexOf(':')
    if (separator >= 0 && separator + 1 < source.length) aliases.add(source.slice(separator + 1))
  }
  const parts = entry.path.split('/').filter(Boolean)
  if (parts.length > 0) aliases.add(parts[0] ?? '')
  if (parts.length > 1) aliases.add(parts[1] ?? '')
  aliases.delete('')
  return aliases
}

/** Resolve the official Tavern `{ world, uid }` identity to this store's
 * canonical path. Imported cards expose a source uid while older fixtures
 * and helper entries may encode it in the canonical path itself. */
export function resolveWorldInfoEntryPath(
  worldbook: { list(): readonly WorldbookEntry[] },
  world: string | undefined,
  uid: string | number | undefined,
): string | null {
  const uidText = uid === undefined || uid === null ? '' : String(uid).trim()
  if (uidText.length === 0) return null
  const worldText = typeof world === 'string' ? world.trim() : ''
  return worldbook.list().find(entry => {
    if (worldText.length > 0 && !worldInfoBookAliases(entry).has(worldText)) return false
    if (entry.sourceUid !== undefined && String(entry.sourceUid) === uidText) return true
    return entry.path === uidText
      || entry.path.endsWith(`/${uidText}`)
      || entry.path.endsWith(`/${uidText}.md`)
  })?.path ?? null
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
    // Keep the canonical path internal, but expose the original Tavern uid
    // when available so helper listeners can round-trip the official shape.
    uid: entry?.sourceUid ?? match.path,
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

/** Build the JSON-safe observer payload for Tavern's scan-complete event. */
export function buildWorldInfoScanDoneEvent(
  matches: readonly WorldInfoEventMatch[],
  worldbook: { list(): readonly WorldbookEntry[] },
  budget?: { usedTokens?: number; droppedPaths?: readonly string[] },
  timedEffects: Readonly<Record<string, unknown>> = {},
): WorldInfoScanDoneEvent {
  const entries = buildWorldInfoActivatedEntries(matches, worldbook)
  const entryMap = Object.fromEntries(entries.map(entry => [`${entry.world}.${entry.uid}`, entry]))
  return {
    state: { current: 1, next: 0, loopCount: 1 },
    new: { all: entries, successful: entries },
    activated: {
      entries: entryMap,
      text: entries.map(entry => entry.content).filter(content => content.length > 0).join('\n'),
    },
    sortedEntries: entries,
    recursionDelay: { availableLevels: [], currentLevel: null },
    budget: {
      current: typeof budget?.usedTokens === 'number' && Number.isFinite(budget.usedTokens) ? budget.usedTokens : 0,
      overflowed: (budget?.droppedPaths?.length ?? 0) > 0,
    },
    timedEffects: { ...timedEffects },
  }
}

/**
 * Project the current merged store into Tavern's four loaded-lore buckets.
 * The source-book prefix is the stable boundary used by the importer and
 * helper bridge; books without a prefix are global lore by default.
 */
export function buildWorldInfoEntriesLoadedEvent(
  worldbook: { list(): readonly WorldbookEntry[] },
): WorldInfoEntriesLoadedEvent {
  const result: Record<keyof WorldInfoEntriesLoadedEvent, WorldInfoActivatedEntry[]> = {
    globalLore: [],
    characterLore: [],
    chatLore: [],
    personaLore: [],
  }
  for (const entry of worldbook.list()) {
    const sourceKind = entry.sourceBookId?.split(':', 1)[0]
    const bucket: keyof WorldInfoEntriesLoadedEvent = sourceKind === 'character'
      ? 'characterLore'
      : sourceKind === 'chat'
        ? 'chatLore'
        : sourceKind === 'persona'
          ? 'personaLore'
          : 'globalLore'
    result[bucket].push(toWorldInfoActivatedEntry({
      path: entry.path,
      order: entry.order,
      weight: entry.weight,
      content: entry.content,
      source: 'st',
      ...(entry.position === undefined ? {} : { position: entry.position }),
      ...(entry.depth === undefined ? {} : { depth: entry.depth }),
      ...(entry.role === undefined ? {} : { role: entry.role }),
    }, entry))
  }
  return result
}
