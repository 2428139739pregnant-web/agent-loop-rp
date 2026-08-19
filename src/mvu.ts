/** Minimal persistent MVU state for imported Character Cards. */

import { snapshotJsonValue, type JsonValue, type SessionEvent } from '@deepseek-ai/dsh-session'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ImportedCharacterCard } from './import/types.ts'
import { decodeTavernHelperState } from './tavern-helper.ts'

/** DSH's command package extends SessionEventMap; keep the standalone app
 * independent from that package while accepting its durable event shape. */
type CommandDoneEvent = {
  readonly type: 'command/done'
  readonly data: { readonly kind: 'success' | 'error'; readonly text?: string }
}
type CompatibleSessionEvent = SessionEvent | CommandDoneEvent

interface JsonPatchOperation {
  readonly op: 'replace' | 'delta' | 'insert' | 'add' | 'remove' | 'move'
  readonly path?: string
  readonly from?: string
  readonly to?: string
  readonly value?: JsonValue
}

/** Macro sources used when a card stores {{user}} / {{char}} in stat_data. */
export interface MvuMacroContext {
  readonly user?: string | null
  readonly char?: string | null
}

/**
 * Normalize a value received from a browser/card runtime to the JSON value
 * used by the session layer.  Tavern Helper treats variable namespaces as
 * JSON objects; keeping this conversion here makes the HTTP adapter and the
 * history-based MVU reader share the same validation boundary.
 */
export function normalizeMvuJsonValue(value: unknown): JsonValue | undefined {
  return snapshotJsonValue(value) as JsonValue | undefined
}

/**
 * Extract the MVU `stat_data` value from either the canonical Tavern Helper
 * chat namespace (`{ stat_data: ... }`) or the legacy iframe payload where
 * the object itself is the MVU state.
 */
export function extractMvuStatData(value: unknown): JsonValue | undefined {
  const snapshot = normalizeMvuJsonValue(value)
  if (snapshot === undefined) return undefined
  const record = jsonRecord(snapshot)
  if (record !== undefined && 'stat_data' in record) return record.stat_data
  return snapshot
}

function substituteMvuTextMacros(text: string, macros: MvuMacroContext | undefined): string {
  if (macros === undefined) return text
  let out = text
  if (macros.user !== undefined && macros.user !== null) {
    out = out.replace(/\{\{user\}\}|<user>/giu, macros.user)
  }
  if (macros.char !== undefined && macros.char !== null) {
    out = out.replace(/\{\{char\}\}|<char>|<bot>/giu, macros.char)
  }
  return out
}

function substituteMvuValueMacros(value: JsonValue, macros: MvuMacroContext | undefined): JsonValue {
  if (typeof value === 'string') return substituteMvuTextMacros(value, macros)
  if (Array.isArray(value)) return value.map(item => substituteMvuValueMacros(item, macros))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      substituteMvuValueMacros(item, macros),
    ])) as JsonValue
  }
  return value
}

function jsonRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function unwrapInitializer(content: string): string {
  const tagged = content.match(/<initvar>\s*([\s\S]*?)\s*<\/initvar>/iu)?.[1]
  const source = tagged ?? content
  return source.trim().match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/u)?.[1] ?? source
}

/**
 * Detect the prompt-template initializer markers without treating ordinary
 * content containing the same text as an initializer.
 *
 * `[InitialVariables]` is a World Info title/memo marker.  The
 * `@@initial_variables` form is a prompt-template decorator and, like the
 * other decorators, is only valid in the leading decorator block of the
 * entry content.
 */
function hasInitialVariablesMarker(entry: NonNullable<ImportedCharacterCard['lorebook']>['entries'][number]): boolean {
  const title = `${entry.comment ?? ''}\n${entry.name ?? ''}`
  if (/\[InitialVariables\]/iu.test(title)) return true

  const lines = entry.content.split(/\r?\n/u)
  let index = 0
  let found = false
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? ''
    if (line === '') break
    if (!line.startsWith('@@')) break
    if (/^@@initial_variables$/iu.test(line)) found = true
    index += 1
  }
  return found
}

/** Remove the leading prompt-template decorator block before parsing data. */
function stripInitialVariablesDecorators(content: string): string {
  const lines = content.split(/\r?\n/u)
  let index = 0
  while (index < lines.length && (lines[index]?.trim() ?? '').startsWith('@@')) index += 1
  return lines.slice(index).join('\n').trim()
}

function initializerContents(card: ImportedCharacterCard): string[] {
  return [...(card.lorebook?.entries ?? [])]
    .sort((left, right) => left.insertionOrder - right.insertionOrder)
    .flatMap(entry => {
      const tagged = /<initvar>[\s\S]*?<\/initvar>/iu.test(entry.content)
      const named = /\[initvar\]/iu.test(`${entry.comment ?? ''}\n${entry.name ?? ''}`)
      const promptTemplate = hasInitialVariablesMarker(entry)
      if (!tagged && !named && !promptTemplate) return []
      const withoutDecorators = promptTemplate ? stripInitialVariablesDecorators(entry.content) : entry.content
      return [unwrapInitializer(withoutDecorators)]
    })
}

function mergeInitialRecord(target: Record<string, JsonValue>, source: Record<string, JsonValue>): void {
  for (const [key, value] of Object.entries(source)) {
    const current = jsonRecord(target[key] as JsonValue)
    const incoming = jsonRecord(value)
    if (current !== undefined && incoming !== undefined) mergeInitialRecord(current, incoming)
    else target[key] = value
  }
}

/** Read and merge the card-owned initial `stat_data` without activating hidden initializer lore. */
export function readInitialMvuState(card: ImportedCharacterCard, macros?: MvuMacroContext): JsonValue | undefined {
  const contents = initializerContents(card)
  if (contents.length === 0) return undefined
  const merged: Record<string, JsonValue> = {}
  for (const content of contents) {
    let parsed: unknown
    try {
      // ST-Prompt-Template deliberately gives JSON the first opportunity so
      // JSON-only syntax (for example escaped strings) is never reinterpreted
      // by YAML.  YAML is only the compatibility fallback.
      parsed = JSON.parse(content)
    } catch (jsonError: unknown) {
      try {
        parsed = parseYaml(content, { maxAliasCount: 100 })
      } catch (yamlError: unknown) {
        const jsonMessage = jsonError instanceof Error ? jsonError.message : String(jsonError)
        const yamlMessage = yamlError instanceof Error ? yamlError.message : String(yamlError)
        throw new Error(`Character Card MVU initializer must be valid JSON or YAML (JSON: ${jsonMessage}; YAML: ${yamlMessage})`)
      }
    }
    const snapshot = snapshotJsonValue(parsed) as JsonValue | undefined
    const record = snapshot === undefined ? undefined : jsonRecord(snapshot)
    if (record === undefined) {
      throw new Error('Character Card MVU initializer must contain one JSON-compatible object')
    }
    mergeInitialRecord(merged, record)
  }
  return substituteMvuValueMacros(merged, macros)
}

/** Fold the latest durable MVU snapshot, falling back to the card initializer. */
export function readCurrentMvuState(
  card: ImportedCharacterCard,
  events: readonly SessionEvent[],
  macros?: MvuMacroContext,
): { readonly statData: JsonValue; readonly updateCount: number; readonly lastError?: string } | undefined {
  let statData = readInitialMvuState(card, macros)
  let updateCount = 0
  let lastError: string | undefined
  for (const event of events as readonly CompatibleSessionEvent[]) {
    if (event.type === 'command/done' && event.data.kind === 'success') {
      const scriptState = decodeTavernHelperState(event.data.text)
      const scope = scriptState?.lastMutation?.scope
      if (scriptState !== undefined && (scope === 'message' || scope === 'chat')) {
        const variables = scriptState.scopes[scope]
        const replacement = variables.stat_data
        if (replacement !== undefined && jsonRecord(replacement) !== undefined) {
          const initializing = statData === undefined
          statData = replacement
          if (!initializing) updateCount += 1
          lastError = undefined
        }
      }
      continue
    }
    if (event.type !== 'assistant/message' || statData === undefined) continue
    const text = event.data.message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('\n')
    if (!/<(?:UpdateVariable(?:variable)?|update)>/iu.test(text)) continue
    try {
      const update = applyMvuReply(statData, text)
      if (update === undefined) continue
      statData = update.statData
      updateCount += 1
      lastError = undefined
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (statData === undefined) return undefined
  return {
    statData: substituteMvuValueMacros(statData, macros),
    updateCount,
    ...(lastError === undefined ? {} : { lastError }),
  }
}

/** Fold MVU state from the lightweight agent-loop chat history.
 *
 * The standalone Harness stores ordinary chat messages instead of DSH
 * `SessionEvent`s. Keeping this adapter here lets both runtimes use the same
 * initializer and JSON-Patch semantics, and makes reroll naturally restore
 * the state represented by the truncated history.
 */
export function readMvuStateFromMessages(
  card: ImportedCharacterCard,
  messages: readonly { readonly role: 'system' | 'user' | 'assistant' | 'tool'; readonly content: string }[],
  macros?: MvuMacroContext,
): { readonly statData: JsonValue; readonly updateCount: number; readonly lastError?: string } | undefined {
  let statData = readInitialMvuState(card, macros)
  let updateCount = 0
  let lastError: string | undefined
  for (const message of messages) {
    if (message.role !== 'assistant' || statData === undefined) continue
    if (!/<(?:UpdateVariable(?:variable)?|update)>/iu.test(message.content)) continue
    try {
      const update = applyMvuReply(statData, message.content)
      if (update === undefined) continue
      statData = update.statData
      updateCount += 1
      lastError = undefined
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (statData === undefined) return undefined
  return {
    statData: substituteMvuValueMacros(statData, macros),
    updateCount,
    ...(lastError === undefined ? {} : { lastError }),
  }
}

/**
 * Read MVU state with an explicitly persisted session snapshot taking
 * precedence over machine tags in the transcript.  A snapshot is written by
 * Tavern Helper's `replaceVariables`; replaying the same assistant tag on top
 * of it would apply the update twice after a restart.
 */
export function readMvuStateWithSessionOverride(
  card: ImportedCharacterCard,
  messages: readonly { readonly role: 'system' | 'user' | 'assistant' | 'tool'; readonly content: string }[],
  sessionStatData: JsonValue | undefined,
  macros?: MvuMacroContext,
): { readonly statData: JsonValue; readonly updateCount: number; readonly lastError?: string } | undefined {
  if (sessionStatData !== undefined) {
    return {
      statData: substituteMvuValueMacros(sessionStatData, macros),
      updateCount: 0,
    }
  }
  return readMvuStateFromMessages(card, messages, macros)
}

function pointerSegments(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return []
  if (!pointer.startsWith('/')) throw new Error(`MVU path must be a JSON Pointer: ${pointer}`)
  const segments = pointer.slice(1).split('/').map(segment => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'))
  return segments[0] === 'stat_data' ? segments.slice(1) : segments
}

function parentAt(root: JsonValue, pointer: string): { parent: Record<string, JsonValue> | JsonValue[]; key: string } {
  const segments = pointerSegments(pointer)
  const key = segments.pop()
  if (key === undefined) throw new Error('MVU operation cannot replace the stat_data root')
  let current: JsonValue = root
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) throw new Error(`MVU path does not exist: ${pointer}`)
      current = current[index]!
      continue
    }
    const record = jsonRecord(current)
    if (record === undefined || !(segment in record)) throw new Error(`MVU path does not exist: ${pointer}`)
    current = record[segment]!
  }
  const parent = Array.isArray(current) ? current : jsonRecord(current)
  if (parent === undefined) throw new Error(`MVU path parent is not a container: ${pointer}`)
  return { parent, key }
}

function arrayIndex(array: JsonValue[], key: string, append: boolean): number {
  if (append && key === '-') return array.length
  const index = Number(key)
  if (!Number.isSafeInteger(index) || index < 0 || index > array.length || (!append && index === array.length)) {
    throw new Error(`MVU array index is unavailable: ${key}`)
  }
  return index
}

function readAt(root: JsonValue, pointer: string): JsonValue {
  const { parent, key } = parentAt(root, pointer)
  if (Array.isArray(parent)) return parent[arrayIndex(parent, key, false)]!
  if (!(key in parent)) throw new Error(`MVU path does not exist: ${pointer}`)
  return parent[key]!
}

function removeAt(root: JsonValue, pointer: string): JsonValue {
  const { parent, key } = parentAt(root, pointer)
  if (Array.isArray(parent)) return parent.splice(arrayIndex(parent, key, false), 1)[0]!
  if (!(key in parent)) throw new Error(`MVU path does not exist: ${pointer}`)
  const value = parent[key]!
  delete parent[key]
  return value
}

function insertAt(root: JsonValue, pointer: string, value: JsonValue): void {
  const { parent, key } = parentAt(root, pointer)
  if (Array.isArray(parent)) {
    parent.splice(arrayIndex(parent, key, true), 0, value)
    return
  }
  if (key in parent) throw new Error(`MVU insert path already exists: ${pointer}`)
  parent[key] = value
}

/** RFC 6902 add: insert into arrays, and create or replace object members. */
function addAt(root: JsonValue, pointer: string, value: JsonValue): void {
  const { parent, key } = parentAt(root, pointer)
  if (Array.isArray(parent)) {
    parent.splice(arrayIndex(parent, key, true), 0, value)
    return
  }
  parent[key] = value
}

function replaceAt(root: JsonValue, pointer: string, value: JsonValue): void {
  const { parent, key } = parentAt(root, pointer)
  if (Array.isArray(parent)) parent[arrayIndex(parent, key, false)] = value
  else {
    if (!(key in parent)) throw new Error(`MVU replace path does not exist: ${pointer}`)
    parent[key] = value
  }
}

function operation(value: unknown): JsonPatchOperation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('MVU patch entries must be objects')
  const record = value as Record<string, unknown>
  if (record.op !== 'replace' && record.op !== 'delta' && record.op !== 'insert' && record.op !== 'add'
    && record.op !== 'remove' && record.op !== 'move') throw new Error(`Unsupported MVU operation: ${String(record.op)}`)
  if (record.path !== undefined && typeof record.path !== 'string') throw new Error('MVU operation path must be a string')
  if (record.from !== undefined && typeof record.from !== 'string') throw new Error('MVU move source must be a string')
  if (record.to !== undefined && typeof record.to !== 'string') throw new Error('MVU move destination must be a string')
  const snapshot = record.value === undefined ? undefined : snapshotJsonValue(record.value) as JsonValue | undefined
  if (record.value !== undefined && snapshot === undefined) throw new Error('MVU operation value must be JSON-compatible')
  return { op: record.op, ...(record.path === undefined ? {} : { path: record.path }), ...(record.from === undefined ? {} : { from: record.from }), ...(record.to === undefined ? {} : { to: record.to }), ...(snapshot === undefined ? {} : { value: snapshot }) }
}

function patchArrays(text: string): JsonPatchOperation[][] {
  const blocks = [...text.matchAll(/<(?:UpdateVariable(?:variable)?|update)>\s*([\s\S]*?)\s*<\/(?:UpdateVariable(?:variable)?|update)>/giu)]
  return blocks.map(match => {
    const body = match[1] ?? ''
    const encoded = body.match(/<(?:JSONPatch|json_patch)>\s*([\s\S]*?)\s*<\/(?:JSONPatch|json_patch)>/iu)?.[1]
    if (encoded === undefined) throw new Error('MVU update is missing JSONPatch/json_patch')
    let parsed: unknown
    try {
      parsed = JSON.parse(encoded)
    } catch {
      // A number of Tavern MVU cards emit JSON5-like patches with trailing
      // commas. YAML's JSON-compatible parser accepts that legacy spelling
      // while still giving us a plain data structure to validate below.
      parsed = parseYaml(encoded, { maxAliasCount: 100 })
    }
    if (!Array.isArray(parsed)) throw new Error('MVU JSONPatch must be an array')
    return parsed.map(operation)
  })
}

/** Apply every complete new-style or legacy MVU JSON Patch block atomically. */
export function applyMvuReply(
  current: JsonValue,
  text: string,
): { readonly statData: JsonValue; readonly appliedOperations: number } | undefined {
  if (!/<(?:UpdateVariable(?:variable)?|update)>/iu.test(text)) return undefined
  const batches = patchArrays(text)
  const cloned = snapshotJsonValue(current) as JsonValue | undefined
  if (cloned === undefined) throw new Error('Current MVU state is not JSON-compatible')
  let count = 0
  for (const batch of batches) {
    for (const item of batch) {
      const path = item.path
      if (item.op === 'move') {
        const from = item.from
        const to = item.to ?? path
        if (from === undefined || to === undefined) throw new Error('MVU move requires from and to')
        insertAt(cloned, to, removeAt(cloned, from))
      } else if (item.op === 'remove') {
        if (path === undefined) throw new Error('MVU remove requires path')
        removeAt(cloned, path)
      } else if (item.op === 'insert') {
        if (path === undefined || item.value === undefined) throw new Error('MVU insert requires path and value')
        insertAt(cloned, path, item.value)
      } else if (item.op === 'add') {
        if (path === undefined || item.value === undefined) throw new Error('MVU add requires path and value')
        addAt(cloned, path, item.value)
      } else if (item.op === 'replace') {
        if (path === undefined || item.value === undefined) throw new Error('MVU replace requires path and value')
        replaceAt(cloned, path, item.value)
      } else {
        if (path === undefined || typeof item.value !== 'number') throw new Error('MVU delta requires path and numeric value')
        const before = readAt(cloned, path)
        if (typeof before !== 'number') throw new Error(`MVU delta path is not numeric: ${path}`)
        replaceAt(cloned, path, before + item.value)
      }
      count += 1
    }
  }
  return { statData: cloned, appliedOperations: count }
}

/** Collect the inert card-authored rules needed by a dedicated MVU update call. */
export function renderMvuUpdateInstructions(
  card: ImportedCharacterCard,
  statData: JsonValue,
): string | undefined {
  const entries = card.lorebook?.entries.filter(entry => entry.enabled
    && !entry.hasDecorators
    && !/<%[\s\S]*?%>/u.test(entry.content)
    && /(?:变量更新规则|变量输出格式|<(?:UpdateVariable(?:variable)?|update)>)/iu.test(entry.content)) ?? []
  if (entries.length === 0) return undefined
  return entries
    .sort((left, right) => left.insertionOrder - right.insertionOrder)
    .map(entry => substituteMvuMacros(entry.content, statData))
    .join('\n\n')
}

/** Collect a card-authored ten-choice contract for a dedicated completion call. */
export function renderChoiceInstructions(card: ImportedCharacterCard): string | undefined {
  const symbols = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
  return card.lorebook?.entries
    .filter(entry => entry.enabled
      && entry.constant
      && !entry.hasDecorators
      && !/<%[\s\S]*?%>/u.test(entry.content)
      && symbols.every(symbol => entry.content.includes(`<${symbol}>`) && entry.content.includes(`</${symbol}>`)))
    .sort((left, right) => left.insertionOrder - right.insertionOrder)
    .map(entry => entry.content)
    .join('\n\n') || undefined
}

/** Normalize one complete card-authored ten-choice module. */
export function normalizeChoiceSupplement(raw: string): string | undefined {
  const symbols = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']
  const choices = symbols.map(symbol => {
    const matches = [...raw.matchAll(new RegExp(`<${symbol}>\\s*([\\s\\S]*?)\\s*</${symbol}>`, 'gu'))]
    if (matches.length !== 1) return undefined
    const value = matches[0]?.[1]?.trim()
    return value === undefined || value.length === 0 || /<[①②③④⑤⑥⑦⑧⑨⑩]>/u.test(value)
      ? undefined
      : `<${symbol}>${value}</${symbol}>`
  })
  return choices.some(choice => choice === undefined) ? undefined : choices.join('\n')
}

/** Normalize a narrow model response to one complete, valid MVU block. */
export function normalizeMvuSupplement(current: JsonValue, raw: string): string | undefined {
  const fenced = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()
  const complete = fenced.match(/<(?:UpdateVariable(?:variable)?|update)>[\s\S]*?<\/(?:UpdateVariable(?:variable)?|update)>/iu)?.[0]
  const jsonPatch = fenced.match(/<(?:JSONPatch|json_patch)>\s*([\s\S]*?)\s*<\/(?:JSONPatch|json_patch)>/iu)?.[1]
  let candidate = complete
  if (candidate === undefined && jsonPatch !== undefined) {
    candidate = `<UpdateVariable>\n<Analysis>Dedicated MVU state update.</Analysis>\n<JSONPatch>\n${jsonPatch}\n</JSONPatch>\n</UpdateVariable>`
  }
  if (candidate === undefined) {
    try {
      const parsed: unknown = JSON.parse(fenced)
      if (Array.isArray(parsed)) {
        candidate = `<UpdateVariable>\n<Analysis>Dedicated MVU state update.</Analysis>\n<JSONPatch>\n${JSON.stringify(parsed)}\n</JSONPatch>\n</UpdateVariable>`
      } else if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const patch = record.json_patch ?? record.JSONPatch
        if (Array.isArray(patch)) {
          const analysis = typeof record.analysis === 'string' ? record.analysis : 'Dedicated MVU state update.'
          candidate = `<UpdateVariable>\n<Analysis>${analysis}</Analysis>\n<JSONPatch>\n${JSON.stringify(patch)}\n</JSONPatch>\n</UpdateVariable>`
        }
      }
    } catch {
      return undefined
    }
  }
  if (candidate === undefined) return undefined
  try {
    return applyMvuReply(current, candidate) === undefined ? undefined : candidate
  } catch {
    return undefined
  }
}

/** Replace the two MVU state macros used by compatible lorebook entries. */
export function substituteMvuMacros(text: string, statData: JsonValue | undefined): string {
  if (statData === undefined) return text
  const yaml = stringifyYaml(statData, { lineWidth: 0 }).trimEnd()
  const json = JSON.stringify(statData)
  return text
    .replace(/\{\{format_message_variable::stat_data\}\}/giu, yaml)
    .replace(/\{\{get_message_variable::stat_data\}\}/giu, json)
}
