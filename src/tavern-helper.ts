/** Session-owned Tavern Helper variable compatibility. */

import { snapshotJsonValue, type JsonValue, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  ImportedCharacterFrontend,
  ImportedTavernHelperScript,
  ImportedTavernHelperScriptTree,
} from './import/types.ts'
import type { ChatMessage } from './agent-loop/provider.ts'

/** DSH's command package extends SessionEventMap; keep this compatibility
 * reader usable without pulling the command registry into the standalone app. */
type CommandDoneEvent = {
  readonly type: 'command/done'
  readonly data: { readonly kind: 'success' | 'error'; readonly text?: string }
}
type CompatibleSessionEvent = SessionEvent | CommandDoneEvent

/** Tavern Helper variable namespaces supported by the isolated runtime. */
export type TavernVariableScope = 'global' | 'preset' | 'character' | 'chat' | 'message' | 'script' | 'extension'

type JsonRecord = Readonly<Record<string, JsonValue>>
type TavernExtensionVariables = Readonly<Record<string, JsonRecord>>

/** One normalized Tavern Helper script retained in a Session-owned script tree. */
export interface TavernScript {
  readonly type: 'script'
  readonly enabled: boolean
  readonly name: string
  readonly id: string
  readonly content: string
  readonly info: string
  readonly button: {
    readonly enabled: boolean
    readonly buttons: readonly { readonly name: string; readonly visible: boolean }[]
  }
  readonly data: JsonRecord
  readonly export_with: { readonly data: boolean; readonly button: boolean }
}

/** One normalized Tavern Helper folder containing child script-tree nodes. */
export interface TavernScriptFolder {
  readonly type: 'folder'
  readonly enabled: boolean
  readonly name: string
  readonly id: string
  readonly icon: string
  readonly color: string
  readonly scripts: readonly TavernScriptTree[]
}

/** One public Tavern Helper script-tree node. */
export type TavernScriptTree = TavernScript | TavernScriptFolder

/** Script-tree storage scopes exposed by Tavern Helper. */
export type TavernScriptTreeScope = 'global' | 'preset' | 'character'

/** SillyTavern extension prompt positions used by setExtensionPrompt. */
export type TavernInjectedPromptPosition = 'before_prompt' | 'in_prompt' | 'in_chat' | 'none'

/** JSON-safe Tavern Helper worldbook entry retained in one roleplay Session. */
export interface TavernWorldbookEntry {
  readonly uid: number
  readonly name: string
  readonly enabled: boolean
  readonly strategy: {
    readonly type: 'constant' | 'selective' | 'vectorized'
    readonly keys: readonly string[]
    readonly keys_secondary: {
      readonly logic: 'and_any' | 'and_all' | 'not_all' | 'not_any'
      readonly keys: readonly string[]
    }
    readonly scan_depth: 'same_as_global' | number
  }
  readonly position: {
    readonly type: 'before_character_definition' | 'after_character_definition' | 'before_example_messages'
      | 'after_example_messages' | 'before_author_note' | 'after_author_note' | 'at_depth' | 'outlet'
    readonly role: 'system' | 'assistant' | 'user'
    readonly depth: number
    readonly order: number
  }
  readonly content: string
  readonly probability: number
  readonly recursion: {
    readonly prevent_incoming: boolean
    readonly prevent_outgoing: boolean
    readonly delay_until: number | null
  }
  readonly effect: {
    readonly sticky: number | null
    readonly cooldown: number | null
    readonly delay: number | null
  }
  readonly extra?: JsonRecord
  readonly ignoreBudget?: boolean
}

/** Explicit Tavern Helper worldbook selections; omitted fields retain imported defaults. */
export interface TavernWorldbookBindings {
  readonly global?: readonly string[]
  readonly character?: { readonly primary: string | null; readonly additional: readonly string[] }
  readonly chat?: string | null
}

/** One Tavern Helper chat message accepted from the isolated browser runtime. */
export interface TavernChatMessageInput {
  readonly message_id?: number
  readonly name?: string
  readonly role?: 'system' | 'assistant' | 'user'
  readonly is_hidden?: boolean
  readonly message?: string
  readonly data?: JsonRecord
  readonly extra?: JsonRecord
  readonly swipe_id?: number
  readonly swipes?: readonly string[]
  readonly swipes_data?: readonly JsonRecord[]
  readonly swipes_info?: readonly JsonRecord[]
}

/** One hidden prefix message retained for Tavern scripts but removed from model history. */
export interface TavernHiddenMessage {
  readonly seq: number
  readonly role: 'assistant' | 'user'
  readonly text: string
}

/** Browser request changing the model-visible roleplay transcript. */
export type TavernChatMutationRequest =
  | {
    readonly format: 0
    readonly operation: 'update-chat-metadata'
    readonly values: JsonRecord
    readonly reset: boolean
  }
  | { readonly format: 0; readonly operation: 'set-chat-messages'; readonly messages: readonly TavernChatMessageInput[] }
  | {
    readonly format: 0
    readonly operation: 'create-chat-messages'
    readonly messages: readonly TavernChatMessageInput[]
    readonly insertAt: number | 'end'
  }
  | { readonly format: 0; readonly operation: 'delete-chat-messages'; readonly messageIds: readonly number[] }
  | {
    readonly format: 0
    readonly operation: 'rotate-chat-messages'
    readonly begin: number
    readonly middle: number
    readonly end: number
  }
  | {
    readonly format: 0
    readonly operation: 'set-chat-hidden'
    readonly start: number
    readonly end: number
    readonly hidden: boolean
  }

/** Complete durable state written by one Tavern Helper variable mutation. */
export interface TavernHelperState {
  readonly format: 0
  readonly characterSourceId: string
  readonly presetSourceId?: string
  readonly presetScriptIds?: readonly string[]
  readonly revision: number
  readonly scopes: {
    readonly global: JsonRecord
    readonly preset: JsonRecord
    readonly character: JsonRecord
    readonly chat: JsonRecord
    readonly message: JsonRecord
    /** Extension variables are namespaced by the official extension_id. */
    readonly extension: TavernExtensionVariables
  }
  /** SillyTavern chat_metadata persisted with this Session. */
  readonly chatMetadata?: JsonRecord
  readonly scripts: Readonly<Record<string, JsonRecord>>
  /** Session-local script-tree replacements; imported source files remain unchanged. */
  readonly scriptTrees?: Readonly<Partial<Record<TavernScriptTreeScope, readonly TavernScriptTree[]>>>
  /** Script-authored prompts retained for subsequent model requests in this chat. */
  readonly injectedPrompts?: readonly TavernInjectedPrompt[]
  /** Contiguous transcript prefix excluded from the Session surface but retained for Tavern APIs. */
  readonly hiddenPrefix?: readonly TavernHiddenMessage[]
  /** Script-authored books and full replacements of imported books, keyed by visible name. */
  readonly worldbooks?: Readonly<Record<string, readonly TavernWorldbookEntry[]>>
  /** Names deleted by scripts, including immutable imported books hidden by a tombstone. */
  readonly deletedWorldbookNames?: readonly string[]
  readonly worldbookBindings?: TavernWorldbookBindings
  readonly lastMutation?: {
    readonly scope: TavernVariableScope | 'worldbook' | 'injection' | 'script-tree'
    readonly scriptId?: string
  }
}

/**
 * One validated model prompt owned by an isolated Tavern Helper script.
 *
 * `filter` is deliberately a boolean in the durable state. The official
 * Tavern Helper type accepts a function, but functions cannot safely cross
 * the iframe/JSON/session boundary. Runtime predicates are accepted by the
 * generation-selection helpers below instead.
 */
export interface TavernInjectedPrompt {
  readonly id: string
  readonly scriptId: string
  readonly position: TavernInjectedPromptPosition
  readonly depth: number
  readonly role: 'system' | 'assistant' | 'user'
  readonly content: string
  readonly shouldScan: boolean
  readonly once: boolean
  readonly order: number
  readonly filter?: boolean
}

/** JSON-safe prompt input shared by injectPrompts and mutation requests. */
export type TavernInjectedPromptInput = Omit<TavernInjectedPrompt, 'scriptId' | 'once' | 'order' | 'shouldScan'> & {
  readonly once?: boolean
  readonly order?: number
  /** Official Tavern Helper spelling; `shouldScan` remains accepted too. */
  readonly shouldScan?: boolean
  readonly should_scan?: boolean
}

/** A host-side filter equivalent to the official function-valued filter. */
export type TavernInjectionPredicate = (
  prompt: TavernInjectedPrompt,
) => boolean | PromiseLike<boolean>

export type TavernInjectionSyncPredicate = (prompt: TavernInjectedPrompt) => boolean

/** Options for the pure injectPrompts state transform. */
export interface TavernInjectPromptsOptions {
  readonly once?: boolean
}

/** A generation snapshot used to consume once-only prompts after generation. */
export interface TavernInjectedPromptSelection {
  readonly prompts: readonly TavernInjectedPrompt[]
  readonly oncePrompts: readonly Pick<TavernInjectedPrompt, 'id' | 'scriptId' | 'content'>[]
}

export interface TavernInjectedPromptSelectionOptions {
  /** Optional synchronous runtime predicate. */
  readonly filter?: TavernInjectionSyncPredicate
}

function isTavernInjectedPromptSelection(
  value: TavernInjectedPromptSelection | readonly string[],
): value is TavernInjectedPromptSelection {
  return !Array.isArray(value)
}

export interface TavernInjectedPromptAsyncSelectionOptions {
  /** Optional predicate matching the official sync/async filter contract. */
  readonly filter?: TavernInjectionPredicate
}

/** Browser request replacing one Tavern Helper variable namespace. */
export interface TavernHelperVariableMutationRequest {
  readonly format: 0
  readonly scope: TavernVariableScope
  readonly scriptId?: string
  readonly extensionId?: string
  readonly variables: JsonRecord
}

/** Browser request changing one script-visible worldbook or its current bindings. */
export type TavernWorldbookMutationRequest =
  | { readonly format: 0; readonly operation: 'replace-worldbook'; readonly name: string; readonly entries: readonly TavernWorldbookEntry[] }
  | { readonly format: 0; readonly operation: 'delete-worldbook'; readonly name: string }
  | { readonly format: 0; readonly operation: 'bind-global-worldbooks'; readonly names: readonly string[] }
  | { readonly format: 0; readonly operation: 'bind-character-worldbooks'; readonly primary: string | null; readonly additional: readonly string[] }
  | { readonly format: 0; readonly operation: 'bind-chat-worldbook'; readonly name: string | null }

/** Browser request replacing one Session-local Tavern Helper script tree. */
export interface TavernScriptTreeMutationRequest {
  readonly format: 0
  readonly operation: 'replace-script-trees'
  readonly scope: TavernScriptTreeScope
  readonly trees: readonly TavernScriptTree[]
}

/** Browser request replacing every prompt currently owned by one script. */
export interface TavernReplaceInjectionMutationRequest {
  readonly format: 0
  readonly operation: 'replace-script-injections'
  readonly scriptId: string
  readonly prompts: readonly TavernInjectedPromptInput[]
}

/** Browser request adding prompts without removing other prompts. */
export interface TavernInjectPromptsMutationRequest {
  readonly format: 0
  readonly operation: 'inject-prompts'
  readonly scriptId: string
  readonly prompts: readonly TavernInjectedPromptInput[]
  readonly once?: boolean
}

/** Browser request removing prompts by their globally unique ids. */
export interface TavernUninjectPromptsMutationRequest {
  readonly format: 0
  readonly operation: 'uninject-prompts'
  readonly ids: readonly string[]
}

/** Browser result of evaluating official function-valued prompt filters. */
export interface TavernInjectionFilterUpdate {
  readonly scriptId: string
  readonly promptId: string
  readonly enabled: boolean
}

/** Browser request applying the current generation's filter snapshot. */
export interface TavernUpdateInjectionFiltersMutationRequest {
  readonly format: 0
  readonly operation: 'update-injection-filters'
  readonly filters: readonly TavernInjectionFilterUpdate[]
}

export type TavernInjectionMutationRequest = TavernReplaceInjectionMutationRequest
  | TavernInjectPromptsMutationRequest
  | TavernUninjectPromptsMutationRequest
  | TavernUpdateInjectionFiltersMutationRequest

/** One validated mutation sent by an isolated Tavern Helper script. */
export type TavernHelperMutationRequest = TavernHelperVariableMutationRequest | TavernWorldbookMutationRequest
  | TavernChatMutationRequest | TavernInjectionMutationRequest | TavernScriptTreeMutationRequest

const STATE_PREFIX = 'agent-rp-tavern-helper-v0:'
const MAX_MUTATION_BYTES = 2 * 1024 * 1024
const MAX_WORLDBOOK_ENTRIES = 10_000
const MAX_CHAT_MESSAGES = 10_000
const MAX_INJECTED_PROMPTS = 256
const MAX_INJECTED_PROMPT_CHARS = 256 * 1024
const MAX_SCRIPT_TREES = 512

function record(value: unknown, name: string): JsonRecord {
  const snapshot = snapshotJsonValue(value) as JsonValue | undefined
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new Error(`${name} must be a JSON object`)
  }
  return snapshot
}

function text(value: unknown, label: string, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function finite(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function nullablePositive(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  const number = finite(value, label, 0)
  return number > 0 ? number : null
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label} must be a string array`)
  return [...new Set(value)] as string[]
}

function worldbookName(value: unknown): string {
  const name = text(value, 'Tavern Helper worldbook name').trim()
  if (name === '' || name.length > 512) throw new Error('Tavern Helper worldbook name is invalid')
  return name
}

function nested(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`)
  return Number(value)
}

function chatMessage(value: unknown, index: number, creating: boolean): TavernChatMessageInput {
  const message = nested(value)
  const role = message.role
  if (role !== undefined && role !== 'system' && role !== 'assistant' && role !== 'user') {
    throw new Error(`chat message[${index}].role is invalid`)
  }
  if (creating && role === undefined) throw new Error(`chat message[${index}].role is required`)
  const body = message.message === undefined ? undefined : text(message.message, `chat message[${index}].message`)
  if (creating && body === undefined) throw new Error(`chat message[${index}].message is required`)
  if (message.is_hidden !== undefined && typeof message.is_hidden !== 'boolean') {
    throw new Error(`chat message[${index}].is_hidden must be a boolean`)
  }
  const strings = (candidate: unknown, label: string): readonly string[] | undefined => {
    if (candidate === undefined) return undefined
    if (!Array.isArray(candidate) || candidate.some(item => typeof item !== 'string')) throw new Error(`${label} must be a string array`)
    return candidate
  }
  const records = (candidate: unknown, label: string): readonly JsonRecord[] | undefined => {
    if (candidate === undefined) return undefined
    if (!Array.isArray(candidate)) throw new Error(`${label} must be an object array`)
    return candidate.map((item, itemIndex) => record(item, `${label}[${itemIndex}]`))
  }
  const swipes = strings(message.swipes, `chat message[${index}].swipes`)
  const swipesData = records(message.swipes_data, `chat message[${index}].swipes_data`)
  const swipesInfo = records(message.swipes_info, `chat message[${index}].swipes_info`)
  return {
    ...(message.message_id === undefined ? {} : { message_id: integer(message.message_id, `chat message[${index}].message_id`) }),
    ...(message.name === undefined ? {} : { name: text(message.name, `chat message[${index}].name`) }),
    ...(role === undefined ? {} : { role }),
    ...(message.is_hidden === undefined ? {} : { is_hidden: message.is_hidden }),
    ...(body === undefined ? {} : { message: body }),
    ...(message.data === undefined ? {} : { data: record(message.data, `chat message[${index}].data`) }),
    ...(message.extra === undefined ? {} : { extra: record(message.extra, `chat message[${index}].extra`) }),
    ...(message.swipe_id === undefined ? {} : { swipe_id: integer(message.swipe_id, `chat message[${index}].swipe_id`) }),
    ...(swipes === undefined ? {} : { swipes }),
    ...(swipesData === undefined ? {} : { swipes_data: swipesData }),
    ...(swipesInfo === undefined ? {} : { swipes_info: swipesInfo }),
  }
}

function chatMessages(value: unknown, creating: boolean): readonly TavernChatMessageInput[] {
  if (!Array.isArray(value) || value.length > MAX_CHAT_MESSAGES) throw new Error('Tavern Helper chat messages are invalid')
  return value.map((message, index) => chatMessage(message, index, creating))
}

function scriptTreeId(value: unknown, label: string): string {
  const id = text(value, label).trim()
  if (id === '' || id.length > 512) throw new Error(`${label} is invalid`)
  return id
}

function scriptTreeBoolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function tavernScript(value: unknown, label: string, ids: Set<string>): TavernScript {
  const script = nested(value)
  if (script.type !== 'script') throw new Error(`${label}.type must be 'script'`)
  const id = scriptTreeId(script.id, `${label}.id`)
  if (ids.has(id)) throw new Error(`Tavern Helper script tree id '${id}' is duplicated`)
  ids.add(id)
  const button = nested(script.button)
  const rawButtons = button.buttons ?? []
  if (!Array.isArray(rawButtons) || rawButtons.length > 50) throw new Error(`${label}.button.buttons is invalid`)
  const buttons = rawButtons.map((value, index) => {
    const item = nested(value)
    return {
      name: text(item.name, `${label}.button.buttons[${index}].name`),
      visible: scriptTreeBoolean(item.visible, `${label}.button.buttons[${index}].visible`, true),
    }
  })
  const exported = nested(script.export_with)
  return {
    type: 'script',
    enabled: scriptTreeBoolean(script.enabled, `${label}.enabled`, false),
    name: text(script.name, `${label}.name`),
    id,
    content: text(script.content, `${label}.content`),
    info: text(script.info, `${label}.info`),
    button: {
      enabled: scriptTreeBoolean(button.enabled, `${label}.button.enabled`, true),
      buttons,
    },
    data: record(script.data ?? {}, `${label}.data`),
    export_with: {
      data: scriptTreeBoolean(exported.data, `${label}.export_with.data`, true),
      button: scriptTreeBoolean(exported.button, `${label}.export_with.button`, true),
    },
  }
}

function tavernScriptTrees(value: unknown, label = 'Tavern Helper script trees'): readonly TavernScriptTree[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const ids = new Set<string>()
  let count = 0
  const parseTree = (candidate: unknown, treeLabel: string): TavernScriptTree => {
    const tree = nested(candidate)
    count++
    if (count > MAX_SCRIPT_TREES) throw new Error('Tavern Helper script tree is too large')
    if (tree.type !== 'folder') return tavernScript(candidate, treeLabel, ids)
    const id = scriptTreeId(tree.id, `${treeLabel}.id`)
    if (ids.has(id)) throw new Error(`Tavern Helper script tree id '${id}' is duplicated`)
    ids.add(id)
    const children = tree.scripts ?? []
    if (!Array.isArray(children)) throw new Error(`${treeLabel}.scripts must be an array`)
    return {
      type: 'folder',
      enabled: scriptTreeBoolean(tree.enabled, `${treeLabel}.enabled`, false),
      name: text(tree.name, `${treeLabel}.name`),
      id,
      icon: text(tree.icon, `${treeLabel}.icon`, 'fa-solid fa-folder'),
      color: text(tree.color, `${treeLabel}.color`),
      scripts: children.map((child, childIndex) => parseTree(child, `${treeLabel}.scripts[${childIndex}]`)),
    }
  }
  return value.map((candidate, index) => parseTree(candidate, `${label}[${index}]`))
}

function extensionVariables(value: unknown, name: string): TavernExtensionVariables {
  const source = record(value ?? {}, name)
  return Object.fromEntries(Object.entries(source).map(([extensionId, variables]) => [
    extensionId,
    record(variables, `${name}.${extensionId}`),
  ]))
}

function flattenedTavernScripts(trees: readonly TavernScriptTree[]): readonly TavernScript[] {
  return trees.flatMap(tree => {
    if (tree.type === 'folder') return tree.enabled ? flattenedTavernScripts(tree.scripts) : []
    return tree.enabled ? [tree] : []
  })
}

function importedTavernHelperScriptTree(tree: ImportedTavernHelperScriptTree): TavernScriptTree {
  if (tree.type === 'folder') {
    return {
      type: 'folder',
      enabled: tree.enabled,
      name: tree.name,
      id: tree.id,
      icon: tree.icon,
      color: tree.color,
      scripts: tree.scripts.map(importedTavernHelperScriptTree),
    }
  }
  return {
    type: 'script',
    enabled: tree.enabled,
    name: tree.name,
    id: tree.id,
    content: tree.content,
    info: tree.info,
    button: {
      enabled: tree.button.enabled,
      buttons: tree.button.buttons,
    },
    data: tree.data,
    export_with: tree.export_with,
  }
}

function tavernScriptScopeIds(state: TavernHelperState, scope: TavernScriptTreeScope): Set<string> {
  const override = state.scriptTrees?.[scope]
  if (override !== undefined) return new Set(flattenedTavernScripts(override).map(script => script.id))
  if (scope === 'global') return new Set()
  if (scope === 'preset') return new Set(state.presetScriptIds ?? [])
  const excluded = new Set([
    ...(state.presetScriptIds ?? []),
    ...flattenedTavernScripts(state.scriptTrees?.global ?? []).map(script => script.id),
  ])
  return new Set(Object.keys(state.scripts).filter(id => !excluded.has(id)))
}

function worldbookEntry(value: unknown, index: number, used: Set<number>): TavernWorldbookEntry {
  const entry = nested(value)
  let uid = entry.uid === undefined ? index : finite(entry.uid, `worldbook[${index}].uid`, index)
  if (!Number.isSafeInteger(uid) || uid < 0 || uid >= 1_000_000) uid = index % 1_000_000
  while (used.has(uid)) uid = (uid + 1) % 1_000_000
  used.add(uid)
  const strategy = nested(entry.strategy)
  const secondary = nested(strategy.keys_secondary)
  const strategyType = strategy.type === 'selective' || strategy.type === 'vectorized' ? strategy.type : 'constant'
  const secondaryLogic = secondary.logic === 'and_all' || secondary.logic === 'not_all' || secondary.logic === 'not_any'
    ? secondary.logic : 'and_any'
  const scanDepth = strategy.scan_depth === 'same_as_global' || strategy.scan_depth === undefined
    ? 'same_as_global' as const : Math.max(0, finite(strategy.scan_depth, `worldbook[${index}].strategy.scan_depth`, 0))
  const position = nested(entry.position)
  const positionTypes = new Set([
    'before_character_definition', 'after_character_definition', 'before_example_messages', 'after_example_messages',
    'before_author_note', 'after_author_note', 'at_depth', 'outlet',
  ])
  const positionType = typeof position.type === 'string' && positionTypes.has(position.type)
    ? position.type as TavernWorldbookEntry['position']['type'] : 'at_depth'
  const role = position.role === 'assistant' || position.role === 'user' ? position.role : 'system'
  const recursion = nested(entry.recursion)
  const effect = nested(entry.effect)
  const extra = entry.extra === undefined ? undefined : record(entry.extra, `worldbook[${index}].extra`)
  return {
    uid,
    name: text(entry.name, `worldbook[${index}].name`),
    enabled: entry.enabled !== false,
    strategy: {
      type: strategyType,
      keys: stringArray(strategy.keys ?? [], `worldbook[${index}].strategy.keys`),
      keys_secondary: {
        logic: secondaryLogic,
        keys: stringArray(secondary.keys ?? [], `worldbook[${index}].strategy.keys_secondary.keys`),
      },
      scan_depth: scanDepth,
    },
    position: {
      type: positionType,
      role,
      depth: finite(position.depth, `worldbook[${index}].position.depth`, 4),
      order: finite(position.order, `worldbook[${index}].position.order`, 100),
    },
    content: text(entry.content, `worldbook[${index}].content`),
    probability: Math.min(100, Math.max(0, finite(entry.probability, `worldbook[${index}].probability`, 100))),
    recursion: {
      prevent_incoming: recursion.prevent_incoming === true,
      prevent_outgoing: recursion.prevent_outgoing === true,
      delay_until: nullablePositive(recursion.delay_until, `worldbook[${index}].recursion.delay_until`),
    },
    effect: {
      sticky: nullablePositive(effect.sticky, `worldbook[${index}].effect.sticky`),
      cooldown: nullablePositive(effect.cooldown, `worldbook[${index}].effect.cooldown`),
      delay: nullablePositive(effect.delay, `worldbook[${index}].effect.delay`),
    },
    ...(extra === undefined ? {} : { extra }),
    ...(entry.ignoreBudget === true ? { ignoreBudget: true } : {}),
  }
}

function worldbookEntries(value: unknown): readonly TavernWorldbookEntry[] {
  if (!Array.isArray(value) || value.length > MAX_WORLDBOOK_ENTRIES) throw new Error('Tavern Helper worldbook entries are invalid')
  const used = new Set<number>()
  return value.map((entry, index) => worldbookEntry(entry, index, used))
}

function injectedPrompt(
  value: unknown,
  index: number,
  scriptId?: string,
  onceOverride?: boolean,
): TavernInjectedPrompt {
  const prompt = nested(value)
  const id = text(prompt.id, `injected prompt[${index}].id`).trim()
  if (id === '' || id.length > 512) throw new Error(`injected prompt[${index}].id is invalid`)
  if (prompt.position !== 'before_prompt' && prompt.position !== 'in_prompt'
    && prompt.position !== 'in_chat' && prompt.position !== 'none') {
    throw new Error(`injected prompt[${index}].position is invalid`)
  }
  if (prompt.role !== 'system' && prompt.role !== 'assistant' && prompt.role !== 'user') {
    throw new Error(`injected prompt[${index}].role is invalid`)
  }
  const depth = integer(prompt.depth, `injected prompt[${index}].depth`)
  const content = text(prompt.content, `injected prompt[${index}].content`)
  if (depth < 0 || depth > 20_000 || content.length > MAX_INJECTED_PROMPT_CHARS) {
    throw new Error(`injected prompt[${index}] is too large`)
  }
  const owner = scriptId ?? text(prompt.scriptId, `injected prompt[${index}].scriptId`)
  if (owner === '') throw new Error(`injected prompt[${index}].scriptId is invalid`)
  if ((prompt.shouldScan !== undefined && typeof prompt.shouldScan !== 'boolean')
    || (prompt.should_scan !== undefined && typeof prompt.should_scan !== 'boolean')
    || (prompt.once !== undefined && typeof prompt.once !== 'boolean')
    || (prompt.filter !== undefined && typeof prompt.filter !== 'boolean')) {
    throw new Error(`injected prompt[${index}] flags are invalid`)
  }
  const order = finite(prompt.order, `injected prompt[${index}].order`, 100)
  if (Math.abs(order) > 1_000_000) throw new Error(`injected prompt[${index}].order is too large`)
  const once = onceOverride === undefined ? prompt.once === true : onceOverride
  return {
    id,
    scriptId: owner,
    position: prompt.position,
    depth,
    role: prompt.role,
    content,
    shouldScan: prompt.shouldScan === undefined ? prompt.should_scan === true : prompt.shouldScan === true,
    once,
    order,
    ...(prompt.filter === undefined ? {} : { filter: prompt.filter }),
  }
}

function injectedPrompts(
  value: unknown,
  scriptId?: string,
  onceOverride?: boolean,
): readonly TavernInjectedPrompt[] {
  if (!Array.isArray(value) || value.length > MAX_INJECTED_PROMPTS) {
    throw new Error('Tavern Helper injected prompts are invalid')
  }
  const prompts = value.map((prompt, index) => injectedPrompt(prompt, index, scriptId, onceOverride))
  if (new Set(prompts.map(prompt => prompt.id)).size !== prompts.length) {
    throw new Error('Tavern Helper injected prompt ids must be unique')
  }
  return prompts
}

/** Create the script state for one active card while retaining Session-wide namespaces. */
export function initializeTavernHelperState(
  frontend: ImportedCharacterFrontend,
  characterSourceId: string,
  previous?: TavernHelperState,
): TavernHelperState {
  const sameCharacter = previous?.characterSourceId === characterSourceId
  const characterOverride = sameCharacter ? previous?.scriptTrees?.character : undefined
  const importedCharacterTrees = (frontend.tavernHelperScriptTrees ?? [])
    .map(importedTavernHelperScriptTree)
  const characterScriptTrees = characterOverride ?? importedCharacterTrees
  const activeCharacterScripts = characterOverride === undefined
    ? frontend.tavernHelperScripts.filter(script => script.enabled) : flattenedTavernScripts(characterOverride)
  const activeGlobalScripts = flattenedTavernScripts(previous?.scriptTrees?.global ?? [])
  const globalScripts = Object.fromEntries(activeGlobalScripts.map(script => [
    script.id,
    previous?.scripts[script.id] ?? script.data,
  ]))
  const presetScripts = Object.fromEntries((previous?.presetScriptIds ?? []).flatMap(id => {
    const value = previous?.scripts[id]
    return value === undefined ? [] : [[id, value]]
  }))
  const scripts = {
    ...globalScripts,
    ...presetScripts,
    ...Object.fromEntries(activeCharacterScripts.map(script => [
      script.id,
      sameCharacter ? previous?.scripts[script.id] ?? script.data : script.data,
    ])),
  }
  const scriptIds = new Set(Object.keys(scripts))
  const prompts = previous?.injectedPrompts?.filter(prompt => scriptIds.has(prompt.scriptId))
  const scriptTrees = {
    ...(previous?.scriptTrees?.global === undefined ? {} : { global: previous.scriptTrees.global }),
    ...(previous?.scriptTrees?.preset === undefined ? {} : { preset: previous.scriptTrees.preset }),
    character: characterScriptTrees,
  }
  return {
    format: 0,
    characterSourceId,
    ...(previous?.presetSourceId === undefined ? {} : { presetSourceId: previous.presetSourceId }),
    ...(previous?.presetScriptIds === undefined ? {} : { presetScriptIds: previous.presetScriptIds }),
    revision: sameCharacter ? previous.revision : 0,
    scopes: {
      global: previous?.scopes.global ?? {},
      preset: previous?.scopes.preset ?? {},
      character: sameCharacter ? previous.scopes.character : frontend.tavernHelperVariables,
      chat: previous?.scopes.chat ?? {},
      message: sameCharacter ? previous.scopes.message : {},
      extension: previous?.scopes.extension ?? {},
    },
    chatMetadata: previous?.chatMetadata ?? {},
    scripts,
    scriptTrees,
    ...(prompts === undefined ? {} : { injectedPrompts: prompts }),
    ...(previous?.worldbooks === undefined ? {} : { worldbooks: previous.worldbooks }),
    ...(previous?.deletedWorldbookNames === undefined ? {} : { deletedWorldbookNames: previous.deletedWorldbookNames }),
    ...(previous?.worldbookBindings === undefined ? {} : { worldbookBindings: previous.worldbookBindings }),
    ...(previous?.hiddenPrefix === undefined ? {} : { hiddenPrefix: previous.hiddenPrefix }),
  }
}

/** Activate one preset's variables and scripts without resetting character or chat state. */
export function initializeTavernHelperPresetState(
  state: TavernHelperState,
  scripts: readonly ImportedTavernHelperScript[],
  variables: JsonRecord,
  presetSourceId: string,
): TavernHelperState {
  const samePreset = state.presetSourceId === presetSourceId
  const previousPresetIds = new Set(state.presetScriptIds ?? [])
  const characterScripts = Object.fromEntries(Object.entries(state.scripts)
    .filter(([id]) => !previousPresetIds.has(id)))
  const presetOverride = samePreset ? state.scriptTrees?.preset : undefined
  const activePresetScripts = presetOverride === undefined
    ? scripts.filter(script => script.enabled) : flattenedTavernScripts(presetOverride)
  const nextScripts = {
    ...characterScripts,
    ...Object.fromEntries(activePresetScripts.map(script => [
      script.id,
      samePreset ? state.scripts[script.id] ?? script.data : script.data,
    ])),
  }
  const scriptIds = new Set(Object.keys(nextScripts))
  const scriptTrees = state.scriptTrees === undefined ? undefined : samePreset
    ? state.scriptTrees
    : Object.fromEntries(Object.entries(state.scriptTrees).filter(([scope]) => scope !== 'preset'))
  return {
    ...state,
    presetSourceId,
    presetScriptIds: activePresetScripts.map(script => script.id),
    scopes: { ...state.scopes, preset: samePreset ? state.scopes.preset : variables },
    scripts: nextScripts,
    ...(scriptTrees === undefined ? {} : { scriptTrees }),
    ...(state.injectedPrompts === undefined
      ? {} : { injectedPrompts: state.injectedPrompts.filter(prompt => scriptIds.has(prompt.scriptId)) }),
  }
}

/** Options shared by the local equivalents of Tavern Helper script-tree APIs. */
export interface TavernScriptTreesOptions {
  readonly type: TavernScriptTreeScope
}

function cloneTavernScriptTree(tree: TavernScriptTree): TavernScriptTree {
  if (tree.type === 'folder') {
    return {
      ...tree,
      scripts: tree.scripts.map(cloneTavernScriptTree),
    }
  }
  return {
    ...tree,
    button: {
      ...tree.button,
      buttons: tree.button.buttons.map(button => ({ ...button })),
    },
  }
}

/** Get a snapshot of one Tavern Helper script tree scope. */
export function getScriptTrees(
  state: TavernHelperState,
  option: TavernScriptTreesOptions,
): TavernScriptTree[] {
  return (state.scriptTrees?.[option.type] ?? []).map(cloneTavernScriptTree)
}

/** Replace one Tavern Helper script tree scope and recompute active scripts. */
export function replaceScriptTrees(
  state: TavernHelperState,
  scriptTrees: readonly TavernScriptTree[],
  option: TavernScriptTreesOptions,
): TavernHelperState {
  const trees = tavernScriptTrees(scriptTrees, `Tavern Helper ${option.type} script trees`)
  return applyTavernHelperMutation(state, {
    format: 0,
    operation: 'replace-script-trees',
    scope: option.type,
    trees,
  })
}

/** Update one script tree scope with either a synchronous or asynchronous updater. */
export function updateScriptTreesWith(
  state: TavernHelperState,
  updater: (scriptTrees: TavernScriptTree[]) => readonly TavernScriptTree[] | PromiseLike<readonly TavernScriptTree[]>,
  option: TavernScriptTreesOptions,
): TavernHelperState | Promise<TavernHelperState> {
  const result = updater(getScriptTrees(state, option))
  if (isPromiseLike(result)) {
    return Promise.resolve(result).then(trees => replaceScriptTrees(state, trees, option))
  }
  return replaceScriptTrees(state, result, option)
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}

function assertInjectionScript(state: TavernHelperState, scriptId: string): void {
  if (scriptId.trim() === '' || !(scriptId in state.scripts)) {
    throw new Error('Tavern Helper injected prompts have an unknown scriptId')
  }
}

function normalizeInjectionInput(
  prompts: readonly TavernInjectedPromptInput[],
  scriptId: string,
  once?: boolean,
): readonly TavernInjectedPrompt[] {
  return injectedPrompts(prompts, scriptId, once)
}

/**
 * Pure equivalent of the official `injectPrompts` state operation.
 *
 * Prompt ids are global, so injecting an existing id replaces that prompt;
 * unrelated prompts (including prompts owned by other scripts) are retained.
 * `options.once` is applied to every prompt when supplied, matching the
 * official call-level option.
 */
export function injectPrompts(
  state: TavernHelperState,
  scriptId: string,
  prompts: readonly TavernInjectedPromptInput[],
  options: TavernInjectPromptsOptions = {},
): TavernHelperState {
  assertInjectionScript(state, scriptId)
  const normalized = normalizeInjectionInput(prompts, scriptId, options.once)
  if (normalized.length === 0) return state
  const ids = new Set(normalized.map(prompt => prompt.id))
  const retained = (state.injectedPrompts ?? []).filter(prompt => !ids.has(prompt.id))
  return {
    ...state,
    revision: state.revision + 1,
    injectedPrompts: [...retained, ...normalized],
    lastMutation: { scope: 'injection', scriptId },
  }
}

/** Pure equivalent of the official `uninjectPrompts(ids)` operation. */
export function uninjectPrompts(
  state: TavernHelperState,
  ids: readonly string[],
): TavernHelperState {
  const requested = new Set(ids)
  if (requested.size === 0 || state.injectedPrompts === undefined) return state
  const retained = state.injectedPrompts.filter(prompt => !requested.has(prompt.id))
  if (retained.length === state.injectedPrompts.length) return state
  return {
    ...state,
    revision: state.revision + 1,
    injectedPrompts: retained,
    lastMutation: { scope: 'injection' },
  }
}

/** Apply one generation's evaluated function filters without replacing prompts. */
export function updateTavernInjectedPromptFilters(
  state: TavernHelperState,
  filters: readonly TavernInjectionFilterUpdate[],
): TavernHelperState {
  if (filters.length === 0 || state.injectedPrompts === undefined) return state
  const updates = new Map(filters.map(filter => [`${filter.scriptId}\u0000${filter.promptId}`, filter.enabled] as const))
  let changed = false
  const injectedPrompts = state.injectedPrompts.map(prompt => {
    const enabled = updates.get(`${prompt.scriptId}\u0000${prompt.id}`)
    if (enabled === undefined || prompt.filter === enabled) return prompt
    changed = true
    return { ...prompt, filter: enabled }
  })
  if (!changed) return state
  const first = filters[0]
  return {
    ...state,
    revision: state.revision + 1,
    injectedPrompts,
    lastMutation: { scope: 'injection', ...(first?.scriptId === undefined ? {} : { scriptId: first.scriptId }) },
  }
}

function sortInjectedPrompts(prompts: readonly TavernInjectedPrompt[]): readonly TavernInjectedPrompt[] {
  return [...prompts].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
}

function injectionIsEligible(
  prompt: TavernInjectedPrompt,
  filter?: (prompt: TavernInjectedPrompt) => boolean,
): boolean {
  return prompt.filter !== false && (filter === undefined || filter(prompt))
}

function selectionFromPrompts(prompts: readonly TavernInjectedPrompt[]): TavernInjectedPromptSelection {
  const sorted = sortInjectedPrompts(prompts)
  return {
    prompts: sorted,
    oncePrompts: sorted
      .filter(prompt => prompt.once)
      .map(({ id, scriptId, content }) => ({ id, scriptId, content })),
  }
}

/**
 * Select the prompts for one generation without mutating durable state.
 * The returned snapshot is the only set that should be consumed after the
 * generation completes; prompts rejected by a filter remain available.
 */
export function selectTavernInjectedPrompts(
  state: TavernHelperState | undefined,
  options: TavernInjectedPromptSelectionOptions = {},
): TavernInjectedPromptSelection {
  return selectionFromPrompts((state?.injectedPrompts ?? []).filter(prompt =>
    injectionIsEligible(prompt, options.filter),
  ))
}

/** Async counterpart for the official promise-valued filter function. */
export async function selectTavernInjectedPromptsAsync(
  state: TavernHelperState | undefined,
  options: TavernInjectedPromptAsyncSelectionOptions = {},
): Promise<TavernInjectedPromptSelection> {
  const prompts = [] as TavernInjectedPrompt[]
  for (const prompt of state?.injectedPrompts ?? []) {
    if (prompt.filter === false) continue
    if (options.filter !== undefined && !(await options.filter(prompt))) continue
    prompts.push(prompt)
  }
  return selectionFromPrompts(prompts)
}

/**
 * Consume the once-only prompts that were actually selected for a completed
 * generation. Matching the script id and content prevents a late completion
 * from deleting a newer replacement that reused the same prompt id.
 *
 * When no selection is supplied, all currently eligible once prompts are
 * consumed. This keeps the helper convenient for hosts that selected the
 * default prompt set directly.
 */
export function consumeTavernInjectedPromptsAfterGeneration(
  state: TavernHelperState | undefined,
  selection?: TavernInjectedPromptSelection | readonly string[],
): TavernHelperState | undefined {
  if (state === undefined || state.injectedPrompts === undefined) return state
  let leases: readonly Pick<TavernInjectedPrompt, 'id' | 'scriptId' | 'content'>[]
  if (selection === undefined) {
    leases = state.injectedPrompts.filter(prompt => prompt.once && prompt.filter !== false)
      .map(({ id, scriptId, content }) => ({ id, scriptId, content }))
  } else if (isTavernInjectedPromptSelection(selection)) {
    leases = selection.oncePrompts
  } else {
    leases = state.injectedPrompts
      .filter(prompt => prompt.once && selection.includes(prompt.id))
      .map(({ id, scriptId, content }) => ({ id, scriptId, content }))
  }
  if (leases.length === 0) return state
  const leaseById = new Map(leases.map(lease => [lease.id, lease]))
  const retained = state.injectedPrompts.filter(prompt => {
    const lease = leaseById.get(prompt.id)
    return lease === undefined
      || !prompt.once
      || prompt.scriptId !== lease.scriptId
      || prompt.content !== lease.content
  })
  if (retained.length === state.injectedPrompts.length) return state
  return {
    ...state,
    revision: state.revision + 1,
    injectedPrompts: retained,
    lastMutation: { scope: 'injection' },
  }
}

/** Parse one browser-authored variable replacement. */
export function parseTavernHelperMutationRequest(raw: string): TavernHelperMutationRequest {
  if (new TextEncoder().encode(raw).byteLength > MAX_MUTATION_BYTES) throw new Error('Tavern Helper update is too large')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('Tavern Helper variable update is not valid JSON', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Tavern Helper variable update must be an object')
  }
  const value = parsed as Record<string, unknown>
  if (value.format === 0 && value.operation === 'set-chat-messages') {
    const messages = chatMessages(value.messages, false)
    if (messages.some(message => message.message_id === undefined)) throw new Error('set-chat-messages requires message_id')
    return { format: 0, operation: value.operation, messages }
  }
  if (value.format === 0 && value.operation === 'update-chat-metadata') {
    if (value.reset !== undefined && typeof value.reset !== 'boolean') {
      throw new Error('update-chat-metadata reset must be a boolean')
    }
    return {
      format: 0,
      operation: value.operation,
      values: record(value.values ?? {}, 'Tavern Helper chat metadata'),
      reset: value.reset === true,
    }
  }
  if (value.format === 0 && value.operation === 'create-chat-messages') {
    const rawInsertAt = value.insertAt ?? value.insert_at ?? 'end'
    const insertAt = rawInsertAt === 'end' ? rawInsertAt : integer(rawInsertAt, 'create-chat-messages insertAt')
    return { format: 0, operation: value.operation, messages: chatMessages(value.messages, true), insertAt }
  }
  if (value.format === 0 && value.operation === 'delete-chat-messages') {
    if (!Array.isArray(value.messageIds) || value.messageIds.some(messageId => !Number.isSafeInteger(messageId))) {
      throw new Error('delete-chat-messages requires integer messageIds')
    }
    return { format: 0, operation: value.operation, messageIds: value.messageIds as number[] }
  }
  if (value.format === 0 && value.operation === 'rotate-chat-messages') {
    return {
      format: 0,
      operation: value.operation,
      begin: integer(value.begin, 'rotate-chat-messages begin'),
      middle: integer(value.middle, 'rotate-chat-messages middle'),
      end: integer(value.end, 'rotate-chat-messages end'),
    }
  }
  if (value.format === 0 && value.operation === 'set-chat-hidden') {
    const start = integer(value.start, 'set-chat-hidden start')
    const end = integer(value.end, 'set-chat-hidden end')
    if (start < 0 || end < start || typeof value.hidden !== 'boolean') {
      throw new Error('set-chat-hidden requires a valid non-negative range and hidden flag')
    }
    return { format: 0, operation: value.operation, start, end, hidden: value.hidden }
  }
  if (value.format === 0 && value.operation === 'replace-script-trees') {
    if (value.scope !== 'global' && value.scope !== 'preset' && value.scope !== 'character') {
      throw new Error('Tavern Helper script tree scope is invalid')
    }
    return {
      format: 0,
      operation: value.operation,
      scope: value.scope,
      trees: tavernScriptTrees(value.trees),
    }
  }
  if (value.format === 0 && value.operation === 'replace-worldbook') {
    return { format: 0, operation: value.operation, name: worldbookName(value.name), entries: worldbookEntries(value.entries) }
  }
  if (value.format === 0 && value.operation === 'delete-worldbook') {
    return { format: 0, operation: value.operation, name: worldbookName(value.name) }
  }
  if (value.format === 0 && value.operation === 'bind-global-worldbooks') {
    return { format: 0, operation: value.operation, names: stringArray(value.names, 'global worldbook names').map(worldbookName) }
  }
  if (value.format === 0 && value.operation === 'bind-character-worldbooks') {
    const primary = value.primary === null ? null : worldbookName(value.primary)
    return {
      format: 0,
      operation: value.operation,
      primary,
      additional: stringArray(value.additional, 'additional character worldbook names').map(worldbookName),
    }
  }
  if (value.format === 0 && value.operation === 'bind-chat-worldbook') {
    return { format: 0, operation: value.operation, name: value.name === null ? null : worldbookName(value.name) }
  }
  if (value.format === 0 && (value.operation === 'replace-script-injections' || value.operation === 'inject-prompts')) {
    if (typeof value.scriptId !== 'string' || value.scriptId === '') {
      throw new Error('Tavern Helper injected prompts require a scriptId')
    }
    if (value.operation === 'inject-prompts'
      && value.once !== undefined && typeof value.once !== 'boolean') {
      throw new Error('Tavern Helper injectPrompts once must be a boolean')
    }
    const operationOnce = value.operation === 'inject-prompts' && typeof value.once === 'boolean'
      ? value.once : undefined
    const prompts = injectedPrompts(
      value.prompts,
      value.scriptId,
      operationOnce,
    ).map(({ scriptId: _scriptId, ...prompt }) => prompt)
    if (value.operation === 'inject-prompts') {
      return {
        format: 0,
        operation: 'inject-prompts',
        scriptId: value.scriptId,
        prompts,
        ...(operationOnce === undefined ? {} : { once: operationOnce }),
      }
    }
    return { format: 0, operation: 'replace-script-injections', scriptId: value.scriptId, prompts }
  }
  if (value.format === 0 && value.operation === 'uninject-prompts') {
    return { format: 0, operation: value.operation, ids: stringArray(value.ids, 'Tavern Helper injected prompt ids') }
  }
  if (value.format === 0 && value.operation === 'update-injection-filters') {
    if (!Array.isArray(value.filters)) throw new Error('update-injection-filters requires filters')
    const filters = value.filters.map((raw, index) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`injection filter ${index} is invalid`)
      const item = raw as Record<string, unknown>
      if (typeof item.scriptId !== 'string' || item.scriptId.trim() === '') throw new Error(`injection filter ${index} scriptId is invalid`)
      if (typeof item.promptId !== 'string' || item.promptId.trim() === '') throw new Error(`injection filter ${index} promptId is invalid`)
      if (typeof item.enabled !== 'boolean') throw new Error(`injection filter ${index} enabled is invalid`)
      return { scriptId: item.scriptId.trim(), promptId: item.promptId.trim(), enabled: item.enabled }
    })
    return { format: 0, operation: value.operation, filters }
  }
  if (value.format !== 0 || (value.scope !== 'global' && value.scope !== 'preset'
    && value.scope !== 'character' && value.scope !== 'chat' && value.scope !== 'message'
    && value.scope !== 'script' && value.scope !== 'extension')) {
    throw new Error('Tavern Helper variable update has an unsupported scope')
  }
  if (value.scriptId !== undefined && typeof value.scriptId !== 'string') {
    throw new Error('Tavern Helper scriptId must be a string')
  }
  if (value.extension_id !== undefined && typeof value.extension_id !== 'string') {
    throw new Error('Tavern Helper extension_id must be a string')
  }
  if (value.scope === 'extension' && (typeof value.extension_id !== 'string' || value.extension_id.trim() === '')) {
    throw new Error('Tavern Helper extension variables require an extension_id')
  }
  return {
    format: 0,
    scope: value.scope,
    ...(value.scriptId === undefined ? {} : { scriptId: value.scriptId }),
    ...(value.extension_id === undefined ? {} : { extensionId: value.extension_id }),
    variables: record(value.variables, 'Tavern Helper variables'),
  }
}

/** Apply one validated namespace replacement. */
export function applyTavernHelperMutation(
  state: TavernHelperState,
  request: TavernHelperMutationRequest,
): TavernHelperState {
  if ('operation' in request) {
    if (request.operation === 'update-chat-metadata') {
      return {
        ...state,
        revision: state.revision + 1,
        chatMetadata: request.reset ? request.values : { ...(state.chatMetadata ?? {}), ...request.values },
        lastMutation: { scope: 'chat' },
      }
    }
    if (request.operation === 'set-chat-messages' || request.operation === 'create-chat-messages'
      || request.operation === 'delete-chat-messages' || request.operation === 'rotate-chat-messages'
      || request.operation === 'set-chat-hidden') {
      return { ...state, revision: state.revision + 1, lastMutation: { scope: 'chat' } }
    }
    if (request.operation === 'replace-script-trees') {
      const scriptTrees = { ...state.scriptTrees, [request.scope]: request.trees }
      const scopeIds = {
        global: request.scope === 'global'
          ? new Set(flattenedTavernScripts(request.trees).map(script => script.id))
          : tavernScriptScopeIds(state, 'global'),
        preset: request.scope === 'preset'
          ? new Set(flattenedTavernScripts(request.trees).map(script => script.id))
          : tavernScriptScopeIds(state, 'preset'),
        character: request.scope === 'character'
          ? new Set(flattenedTavernScripts(request.trees).map(script => script.id))
          : tavernScriptScopeIds(state, 'character'),
      }
      const activeIds = new Set([...scopeIds.global, ...scopeIds.preset, ...scopeIds.character])
      const scripts = Object.fromEntries(Object.entries(state.scripts).filter(([id]) => activeIds.has(id)))
      for (const script of flattenedTavernScripts(request.trees)) scripts[script.id] = script.data
      return {
        ...state,
        revision: state.revision + 1,
        ...(request.scope === 'preset' ? { presetScriptIds: [...scopeIds.preset] } : {}),
        scripts,
        scriptTrees,
        ...(state.injectedPrompts === undefined
          ? {} : { injectedPrompts: state.injectedPrompts.filter(prompt => activeIds.has(prompt.scriptId)) }),
        lastMutation: { scope: 'script-tree' },
      }
    }
    if (request.operation === 'inject-prompts') {
      return request.once === undefined
        ? injectPrompts(state, request.scriptId, request.prompts)
        : injectPrompts(state, request.scriptId, request.prompts, { once: request.once })
    }
    if (request.operation === 'uninject-prompts') {
      return uninjectPrompts(state, request.ids)
    }
    if (request.operation === 'update-injection-filters') {
      return updateTavernInjectedPromptFilters(state, request.filters)
    }
    if (request.operation === 'replace-script-injections') {
      if (!(request.scriptId in state.scripts)) throw new Error('Tavern Helper injected prompts have an unknown scriptId')
      const normalized = normalizeInjectionInput(request.prompts, request.scriptId)
      const replacedIds = new Set(normalized.map(prompt => prompt.id))
      return {
        ...state,
        revision: state.revision + 1,
        injectedPrompts: [
          ...(state.injectedPrompts ?? []).filter(prompt => prompt.scriptId !== request.scriptId && !replacedIds.has(prompt.id)),
          ...normalized,
        ],
        lastMutation: { scope: 'injection', scriptId: request.scriptId },
      }
    }
    if (request.operation === 'replace-worldbook') {
      const deleted = new Set(state.deletedWorldbookNames ?? [])
      deleted.delete(request.name)
      return {
        ...state,
        revision: state.revision + 1,
        worldbooks: { ...state.worldbooks, [request.name]: request.entries },
        deletedWorldbookNames: [...deleted],
        lastMutation: { scope: 'worldbook' },
      }
    }
    if (request.operation === 'delete-worldbook') {
      const worldbooks = Object.fromEntries(Object.entries(state.worldbooks ?? {}).filter(([name]) => name !== request.name))
      return {
        ...state,
        revision: state.revision + 1,
        worldbooks,
        deletedWorldbookNames: [...new Set([...(state.deletedWorldbookNames ?? []), request.name])],
        lastMutation: { scope: 'worldbook' },
      }
    }
    const bindings = state.worldbookBindings ?? {}
    const worldbookBindings: TavernWorldbookBindings = request.operation === 'bind-global-worldbooks'
      ? { ...bindings, global: request.names }
      : request.operation === 'bind-character-worldbooks'
        ? { ...bindings, character: { primary: request.primary, additional: request.additional } }
        : { ...bindings, chat: request.name }
    return { ...state, revision: state.revision + 1, worldbookBindings, lastMutation: { scope: 'worldbook' } }
  }
  if (request.scope === 'script') {
    const scriptId = request.scriptId
    if (scriptId === undefined || !(scriptId in state.scripts)) {
      throw new Error('Tavern Helper script variable update has an unknown scriptId')
    }
    return {
      ...state,
      revision: state.revision + 1,
      scripts: { ...state.scripts, [scriptId]: request.variables },
      lastMutation: { scope: 'script', scriptId },
    }
  }
  if (request.scope === 'extension') {
    const extensionId = request.extensionId?.trim()
    if (extensionId === undefined || extensionId === '') {
      throw new Error('Tavern Helper extension variable update requires an extensionId')
    }
    return {
      ...state,
      revision: state.revision + 1,
      scopes: {
        ...state.scopes,
        extension: { ...state.scopes.extension, [extensionId]: request.variables },
      },
      lastMutation: { scope: 'extension' },
    }
  }
  return {
    ...state,
    revision: state.revision + 1,
    scopes: { ...state.scopes, [request.scope]: request.variables },
    lastMutation: { scope: request.scope },
  }
}

/** Serialize one state snapshot into a private command result. */
export function encodeTavernHelperState(state: TavernHelperState): string {
  return `${STATE_PREFIX}${JSON.stringify(state)}`
}

/** Decode a Tavern Helper state from an unrelated-or-matching command result. */
export function decodeTavernHelperState(text: string | undefined): TavernHelperState | undefined {
  if (text === undefined || !text.startsWith(STATE_PREFIX)) return undefined
  const parsed = JSON.parse(text.slice(STATE_PREFIX.length)) as Record<string, unknown>
  if (parsed.format !== 0 || typeof parsed.characterSourceId !== 'string'
    || typeof parsed.revision !== 'number' || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) {
    throw new Error('Tavern Helper state header is invalid')
  }
  const scopes = record(parsed.scopes, 'Tavern Helper scopes') as Record<string, JsonValue>
  const scripts = record(parsed.scripts, 'Tavern Helper scripts')
  const required = ['global', 'preset', 'character', 'chat', 'message'] as const
  const parsedScopes = Object.fromEntries(required.map(key => [
    key,
    record(scopes[key] ?? {}, `Tavern Helper ${key} variables`),
  ])) as Omit<TavernHelperState['scopes'], 'extension'>
  const parsedScopeSet = {
    ...parsedScopes,
    // Older v0 snapshots did not have extension variables; decode them as an
    // empty namespace so existing sessions remain readable.
    extension: extensionVariables(scopes.extension, 'Tavern Helper extension variables'),
  } satisfies TavernHelperState['scopes']
  const parsedChatMetadata = parsed.chatMetadata === undefined
    ? undefined : record(parsed.chatMetadata, 'Tavern Helper chat metadata')
  const parsedScripts = Object.fromEntries(Object.entries(scripts).map(([id, value]) => [
    id,
    record(value, `Tavern Helper script ${id} variables`),
  ]))
  const parsedScriptTrees = parsed.scriptTrees === undefined ? undefined : (() => {
    const scopes = record(parsed.scriptTrees, 'Tavern Helper script trees')
    const unsupported = Object.keys(scopes).find(scope => scope !== 'global' && scope !== 'preset' && scope !== 'character')
    if (unsupported !== undefined) throw new Error(`Tavern Helper script tree scope '${unsupported}' is invalid`)
    return Object.fromEntries(Object.entries(scopes).map(([scope, trees]) => [
      scope,
      tavernScriptTrees(trees, `Tavern Helper ${scope} script trees`),
    ])) as TavernHelperState['scriptTrees']
  })()
  if (parsedScriptTrees !== undefined && Object.values(parsedScriptTrees)
    .flatMap(trees => flattenedTavernScripts(trees ?? [])).some(script => !(script.id in parsedScripts))) {
    throw new Error('Tavern Helper script trees reference missing script variables')
  }
  const parsedWorldbooks = parsed.worldbooks === undefined
    ? undefined
    : Object.fromEntries(Object.entries(record(parsed.worldbooks, 'Tavern Helper worldbooks'))
      .map(([name, entries]) => [worldbookName(name), worldbookEntries(entries)]))
  const parsedInjectedPrompts = parsed.injectedPrompts === undefined
    ? undefined : injectedPrompts(parsed.injectedPrompts)
  if (parsedInjectedPrompts?.some(prompt => !(prompt.scriptId in parsedScripts)) === true) {
    throw new Error('Tavern Helper injected prompts reference an unknown scriptId')
  }
  const deletedWorldbookNames = parsed.deletedWorldbookNames === undefined
    ? undefined : stringArray(parsed.deletedWorldbookNames, 'Tavern Helper deleted worldbook names').map(worldbookName)
  let hiddenPrefix: readonly TavernHiddenMessage[] | undefined
  if (parsed.hiddenPrefix !== undefined) {
    if (!Array.isArray(parsed.hiddenPrefix) || parsed.hiddenPrefix.length > MAX_CHAT_MESSAGES) {
      throw new Error('Tavern Helper hidden chat prefix is invalid')
    }
    hiddenPrefix = parsed.hiddenPrefix.map((item, index) => {
      const message = nested(item)
      const seq = integer(message.seq, `hidden chat message[${index}].seq`)
      if (seq < 0 || (message.role !== 'assistant' && message.role !== 'user')) {
        throw new Error(`hidden chat message[${index}] is invalid`)
      }
      if (typeof message.text !== 'string') throw new Error(`hidden chat message[${index}].text must be a string`)
      return { seq, role: message.role, text: message.text }
    })
  }
  let worldbookBindings: TavernWorldbookBindings | undefined
  if (parsed.worldbookBindings !== undefined) {
    const bindings = record(parsed.worldbookBindings, 'Tavern Helper worldbook bindings') as Record<string, JsonValue>
    const global = bindings.global === undefined ? undefined : stringArray(bindings.global, 'global worldbook names').map(worldbookName)
    const chat = bindings.chat === undefined || bindings.chat === null ? bindings.chat : worldbookName(bindings.chat)
    const characterValue = bindings.character === undefined ? undefined : record(bindings.character, 'character worldbook bindings')
    const primary = characterValue?.primary === undefined || characterValue.primary === null
      ? characterValue?.primary as undefined | null : worldbookName(characterValue.primary)
    const additional = characterValue === undefined
      ? undefined : stringArray(characterValue.additional, 'additional character worldbook names').map(worldbookName)
    worldbookBindings = {
      ...(global === undefined ? {} : { global }),
      ...(characterValue === undefined ? {} : { character: { primary: primary ?? null, additional: additional ?? [] } }),
      ...(chat === undefined ? {} : { chat }),
    }
  }
  if (parsed.presetSourceId !== undefined && typeof parsed.presetSourceId !== 'string') {
    throw new Error('Tavern Helper preset source is invalid')
  }
  if (parsed.presetScriptIds !== undefined && (!Array.isArray(parsed.presetScriptIds)
    || parsed.presetScriptIds.some(value => typeof value !== 'string'))) {
    throw new Error('Tavern Helper preset script ids are invalid')
  }
  const mutation = parsed.lastMutation
  let lastMutation: TavernHelperState['lastMutation']
  if (mutation !== undefined) {
    if (typeof mutation !== 'object' || mutation === null || Array.isArray(mutation)) {
      throw new Error('Tavern Helper last mutation is invalid')
    }
    const value = mutation as Record<string, unknown>
    if (value.scope !== 'global' && value.scope !== 'preset' && value.scope !== 'character'
      && value.scope !== 'chat' && value.scope !== 'message' && value.scope !== 'script'
      && value.scope !== 'extension'
      && value.scope !== 'worldbook' && value.scope !== 'injection' && value.scope !== 'script-tree') {
      throw new Error('Tavern Helper last mutation scope is invalid')
    }
    if (value.scriptId !== undefined && typeof value.scriptId !== 'string') {
      throw new Error('Tavern Helper last mutation scriptId is invalid')
    }
    lastMutation = { scope: value.scope, ...(value.scriptId === undefined ? {} : { scriptId: value.scriptId }) }
  }
  return {
    format: 0,
    characterSourceId: parsed.characterSourceId,
    ...(parsed.presetSourceId === undefined ? {} : { presetSourceId: parsed.presetSourceId }),
    ...(parsed.presetScriptIds === undefined ? {} : { presetScriptIds: parsed.presetScriptIds as string[] }),
    revision: parsed.revision,
    scopes: parsedScopeSet,
    ...(parsedChatMetadata === undefined ? {} : { chatMetadata: parsedChatMetadata }),
    scripts: parsedScripts,
    ...(parsedScriptTrees === undefined ? {} : { scriptTrees: parsedScriptTrees }),
    ...(parsedInjectedPrompts === undefined ? {} : { injectedPrompts: parsedInjectedPrompts }),
    ...(hiddenPrefix === undefined ? {} : { hiddenPrefix }),
    ...(parsedWorldbooks === undefined ? {} : { worldbooks: parsedWorldbooks }),
    ...(deletedWorldbookNames === undefined ? {} : { deletedWorldbookNames }),
    ...(worldbookBindings === undefined ? {} : { worldbookBindings }),
    ...(lastMutation === undefined ? {} : { lastMutation }),
  }
}

/** Project durable script injections into the existing in-chat prompt inserter. */
export function tavernInjectedInChatPrompts(
  state: TavernHelperState | undefined,
  options: TavernInjectedPromptSelectionOptions = {},
): readonly {
  readonly role: 'system' | 'assistant' | 'user'
  readonly content: string
  readonly depth: number
  readonly order: number
}[] {
  return selectTavernInjectedPrompts(state, options).prompts.flatMap(prompt => prompt.position === 'in_chat' && prompt.content.trim() !== ''
    ? [{ role: prompt.role, content: prompt.content, depth: prompt.depth, order: prompt.order }]
    : [])
}

/**
 * Return the non-chat extension prompt content for ST's IN_PROMPT and
 * BEFORE_PROMPT anchors after applying the current filter snapshot.
 */
export function tavernInjectedPromptContent(
  state: TavernHelperState | undefined,
  position: Exclude<TavernInjectedPromptPosition, 'in_chat' | 'none'>,
  options: TavernInjectedPromptSelectionOptions = {},
): string {
  return selectTavernInjectedPrompts(state, options).prompts
    .filter(prompt => prompt.position === position && prompt.content.trim() !== '')
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(prompt => prompt.content.trim())
    .join('\n')
}

/**
 * Apply the official Tavern Helper `in_chat` prompts to an oldest-to-newest
 * chat-completion message array. ST performs this operation on a reversed
 * array, inserts at `depth + totalInsertedMessages`, and reverses it back;
 * keeping that detail is important because depth 0 is the generation-side
 * boundary after the newest message. Prompts are grouped by depth, then by
 * descending injection order and finally by ST's system → user → assistant
 * role order. `position:'none'` is intentionally excluded: it participates
 * in World Info scanning through {@link tavernInjectedScanText} but is never
 * sent to the model as a prompt message.
 */
export function applyTavernInjectedInChatPrompts(
  baseMessages: readonly ChatMessage[],
  state: TavernHelperState | undefined,
  options: TavernInjectedPromptSelectionOptions = {},
): ChatMessage[] {
  const selected = selectTavernInjectedPrompts(state, options)
  const byDepth = new Map<number, TavernInjectedPrompt[]>()
  for (const prompt of selected.prompts) {
    if (prompt.position !== 'in_chat' || prompt.content.trim().length === 0) continue
    const depth = Math.max(0, Math.trunc(prompt.depth))
    const bucket = byDepth.get(depth) ?? []
    bucket.push(prompt)
    byDepth.set(depth, bucket)
  }
  if (byDepth.size === 0) return baseMessages.map(message => ({ ...message }))

  const messages = baseMessages.map(message => ({ ...message })).reverse()
  let totalInsertedMessages = 0
  const roleOrder: readonly TavernInjectedPrompt['role'][] = ['system', 'user', 'assistant']
  for (const depth of [...byDepth.keys()].sort((left, right) => left - right)) {
    const prompts = byDepth.get(depth) ?? []
    const orders = [...new Set(prompts.map(prompt => prompt.order))].sort((left, right) => right - left)
    const roleMessages: ChatMessage[] = []
    for (const order of orders) {
      const orderPrompts = prompts.filter(prompt => prompt.order === order)
      for (const role of roleOrder) {
        const content = orderPrompts
          .filter(prompt => prompt.role === role)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(prompt => prompt.content.trim())
          .filter(Boolean)
          .join('\n')
        if (content.length > 0) roleMessages.push({ role, content })
      }
    }
    if (roleMessages.length === 0) continue
    const index = Math.min(depth + totalInsertedMessages, messages.length)
    messages.splice(index, 0, ...roleMessages)
    totalInsertedMessages += roleMessages.length
  }
  return messages.reverse()
}

/** Return script prompt text that participates in the next lorebook scan. */
export function tavernInjectedScanText(
  state: TavernHelperState | undefined,
  options: TavernInjectedPromptSelectionOptions = {},
): readonly string[] {
  return selectTavernInjectedPrompts(state, options).prompts.flatMap(prompt => prompt.shouldScan && prompt.content.trim() !== ''
    ? [prompt.content]
    : [])
}

/** Fold the latest Tavern Helper state from private command results. */
export function readTavernHelperState(events: readonly SessionEvent[]): TavernHelperState | undefined {
  let state: TavernHelperState | undefined
  for (const event of events as readonly CompatibleSessionEvent[]) {
    if (event.type !== 'command/done' || event.data.kind !== 'success') continue
    const decoded = decodeTavernHelperState(event.data.text)
    if (decoded !== undefined) state = decoded
  }
  return state
}
