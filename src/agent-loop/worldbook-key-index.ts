/**
 * Runtime key-only worldbook index.
 *
 * This module is deliberately provider-free: the active character worldbook
 * sources are merged by the host, then their activation metadata is rendered
 * into a compact Markdown index.  Full entry content never enters this index;
 * the authoritative WorldbookStore is consulted only after a path is selected.
 */

import { classifyWorldbookEntry } from './worldbook-compat.ts'
import type { WorldbookEntry } from './session.ts'
import type { WorldbookEntryOwner } from './worldbook-compat.ts'
import { substituteUserCharMacros } from './persona-store.ts'

export interface WorldbookKeyIndexEntry {
  readonly path: string
  readonly comment: string
  readonly owner?: WorldbookEntryOwner
  readonly keys: readonly string[]
  readonly secondaryKeys: readonly string[]
  readonly selectiveLogic: 'and-any' | 'and-all' | 'not-any' | 'not-all'
  readonly selective?: boolean
  readonly caseSensitive: boolean
  readonly matchWholeWords: boolean
  readonly useRegex: boolean
  readonly group?: string
  readonly groupOverride?: boolean
  readonly groupWeight?: number
  readonly useGroupScoring?: boolean
  readonly order: number
  readonly weight: number
}

export interface WorldbookKeyIndexMacros {
  readonly user?: string | null
  readonly char?: string | null
}

function substituteMacros(text: string, macros: WorldbookKeyIndexMacros): string {
  return substituteUserCharMacros(text, macros.user ?? null, macros.char ?? null)
}

function entryComment(entry: WorldbookEntry): string {
  if (entry.comment !== undefined && entry.comment.trim().length > 0) return entry.comment
  return entry.path.split('/').pop() ?? entry.path
}

/**
 * Return all enabled non-blue green entries in the active combination. ST-native
 * regex entries remain visible in the index for completeness, but are marked as
 * `owner=st`; the semantic matcher must only select `owner=agent` entries.
 * Extension-control entries are kept in their separate plugin lane.
 */
export function buildWorldbookKeyIndex(
  entries: readonly WorldbookEntry[],
  macros: WorldbookKeyIndexMacros = {},
): WorldbookKeyIndexEntry[] {
  return entries
    .filter(entry => {
      const classification = classifyWorldbookEntry(entry)
      return entry.enabled !== false && entry.constant !== true && classification.owner !== 'plugin'
    })
    .map(entry => ({
      path: entry.path,
      comment: substituteMacros(entryComment(entry), macros),
      owner: classifyWorldbookEntry(entry).owner,
      keys: entry.keywords.map(key => substituteMacros(key, macros)),
      secondaryKeys: (entry.secondaryKeywords ?? []).map(key => substituteMacros(key, macros)),
      selectiveLogic: entry.selectiveLogic ?? 'and-any',
      selective: entry.selective === true,
      caseSensitive: entry.caseSensitive === true,
      matchWholeWords: entry.matchWholeWords === true,
      useRegex: entry.useRegex === true,
      ...(entry.group === undefined ? {} : { group: substituteMacros(entry.group, macros) }),
      ...(entry.groupOverride === undefined ? {} : { groupOverride: entry.groupOverride }),
      ...(entry.groupWeight === undefined ? {} : { groupWeight: entry.groupWeight }),
      ...(entry.useGroupScoring === undefined ? {} : { useGroupScoring: entry.useGroupScoring }),
      order: entry.order,
      weight: entry.weight,
    }))
    .sort((a, b) => a.order - b.order || b.weight - a.weight || a.path.localeCompare(b.path))
}

function markdownCell(value: string): string {
  return value.replace(/[|\r\n]+/gu, ' ').trim()
}

function selectiveLogicLabel(logic: WorldbookKeyIndexEntry['selectiveLogic']): string {
  switch (logic) {
    case 'and-all': return 'AND_ALL'
    case 'not-any': return 'NOT_ANY'
    case 'not-all': return 'NOT_ALL'
    default: return 'AND_ANY'
  }
}

/** Render a compact key-only Markdown document. No worldbook content is emitted. */
export function renderWorldbookKeyOnlyMd(
  entries: readonly WorldbookKeyIndexEntry[],
  title = '当前游玩组合 — Green Worldbook Key Index',
): string {
  const lines = [
    `# ${title}`,
    '',
    '> 本文件由代码根据当前启用的角色卡世界书和外部世界书自动生成。',
    '> 这里只包含绿灯匹配元数据；命中后通过 path 从权威世界书存储读取完整内容。',
    '',
    `条目数：${entries.length}`,
    '',
  ]

  if (entries.length === 0) {
    lines.push('（当前没有可交给语义匹配 agent 的绿灯条目）', '')
    return lines.join('\n')
  }

  lines.push(
    '| path | owner | comment | keys | secondaryKeys | selectiveLogic | caseSensitive | wholeWord | regex | group | groupOverride | groupWeight | order | weight |',
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |',
  )
  for (const entry of entries) {
    lines.push([
      `| ${markdownCell(entry.path)}`,
      `${entry.owner ?? 'agent'}`,
      `${markdownCell(entry.comment)}`,
      `${markdownCell(entry.keys.join(', ')) || '(none)'}`,
      `${markdownCell(entry.secondaryKeys.join(', ')) || '(none)'}`,
      `${selectiveLogicLabel(entry.selectiveLogic)}${entry.selective === true ? '' : ' (off)'}`,
      `${entry.caseSensitive ? 'yes' : 'no'}`,
      `${entry.matchWholeWords ? 'yes' : 'no'}`,
      `${entry.useRegex ? 'yes' : 'no'}`,
      `${markdownCell(entry.group ?? '') || '(none)'}`,
      `${entry.groupOverride === true ? 'yes' : 'no'}`,
      `${entry.groupWeight ?? 100}`,
      `${entry.order}`,
      `${entry.weight} |`,
    ].join(' | '))
  }
  lines.push('')
  return lines.join('\n')
}
