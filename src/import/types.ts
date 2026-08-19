/** Neutral, lossless Character Card import vocabulary. */

import type { JsonValue } from '@deepseek-ai/dsh-session'

/** Character Card generation selected at the import boundary. */
export type CharacterCardVersion = 1 | 2 | 3

/** One feature preserved from a card but not fully represented or executed. */
export const CHARACTER_IMPORT_DEGRADATIONS = [
  'character-assets',
  'future-card-version',
  'group-greetings',
  'lorebook-decorators',
  'lorebook-regex',
  'lorebook-recursion',
  'remote-assets',
] as const

/** One feature preserved from a card but deliberately not executed. */
export type CharacterImportDegradation = typeof CHARACTER_IMPORT_DEGRADATIONS[number]

/** One SillyTavern character-scoped regex retained for display and prompt views. */
export interface ImportedRegexScript {
  readonly id?: string
  readonly scriptName: string
  readonly findRegex: string
  readonly replaceString: string
  readonly trimStrings: readonly string[]
  readonly placement: readonly number[]
  readonly disabled: boolean
  readonly markdownOnly: boolean
  readonly promptOnly: boolean
  readonly runOnEdit: boolean
  readonly substituteRegex: number
  readonly minDepth: number | null
  readonly maxDepth: number | null
}

/** One Tavern Helper button retained with its owning script. */
export interface ImportedTavernHelperButton {
  readonly name: string
  readonly visible: boolean
}

/** One flattened Tavern Helper script retained from a card script tree. */
export interface ImportedTavernHelperScript {
  readonly id: string
  readonly name: string
  readonly content: string
  readonly info: string
  /** Effective enablement after applying all parent-folder switches. */
  readonly enabled: boolean
  readonly buttonEnabled: boolean
  readonly buttons: readonly ImportedTavernHelperButton[]
  readonly data: Readonly<Record<string, JsonValue>>
}

/** One normalized script node retained in the original Tavern Helper tree. */
export interface ImportedTavernHelperScriptTreeScript {
  readonly type: 'script'
  /** The script's own switch; parent-folder switches are applied when flattened. */
  readonly enabled: boolean
  readonly name: string
  readonly id: string
  readonly content: string
  readonly info: string
  readonly button: {
    readonly enabled: boolean
    readonly buttons: readonly ImportedTavernHelperButton[]
  }
  readonly data: Readonly<Record<string, JsonValue>>
  readonly export_with: { readonly data: boolean; readonly button: boolean }
}

/** One normalized folder node retained in the original Tavern Helper tree. */
export interface ImportedTavernHelperScriptTreeFolder {
  readonly type: 'folder'
  /** The folder's own switch; descendants inherit it when flattened. */
  readonly enabled: boolean
  readonly name: string
  readonly id: string
  readonly icon: string
  readonly color: string
  readonly scripts: readonly ImportedTavernHelperScriptTree[]
}

/** Lossless normalized Tavern Helper script tree used by card compatibility APIs. */
export type ImportedTavernHelperScriptTree =
  | ImportedTavernHelperScriptTreeScript
  | ImportedTavernHelperScriptTreeFolder

/** Non-sensitive Tavern Helper counts shown by reusable-library interfaces. */
export interface TavernHelperLibrarySummary {
  readonly format?: 'object' | 'entries'
  readonly scriptCount: number
  readonly enabledScriptCount: number
  readonly expectedScriptCount?: number
  readonly variableCount?: number
  readonly ignoredFieldCount?: number
}

/** Source encoding and non-sensitive counts retained from one Tavern Helper extension. */
export interface TavernHelperImportSummary extends TavernHelperLibrarySummary {
  readonly format: 'object' | 'entries'
  readonly variableCount: number
  readonly ignoredFieldCount: number
}

/** Character-owned lightweight frontend resources preserved at import. */
export interface ImportedCharacterFrontend {
  readonly regexScripts: readonly ImportedRegexScript[]
  readonly tavernHelperScriptNames: readonly string[]
  readonly tavernHelperScripts: readonly ImportedTavernHelperScript[]
  /** Original card tree, including disabled folders and scripts. */
  readonly tavernHelperScriptTrees?: readonly ImportedTavernHelperScriptTree[]
  readonly tavernHelperVariables: Readonly<Record<string, JsonValue>>
  readonly tavernHelper?: TavernHelperImportSummary
}

/** One Character Card V3 asset declaration retained independently of its transport. */
export interface ImportedCharacterAsset {
  readonly type: string
  readonly uri: string
  readonly name: string
  readonly ext: string
}

/** Supported runtime behavior of one lorebook entry. */
export interface ImportedLorebookEntry {
  /** Stable source-local identifier retained for display and diagnostics. */
  readonly sourceId: string
  /** Optional author-facing entry title. */
  readonly name?: string
  /** Optional author note shown only in management UI. */
  readonly comment?: string
  readonly keys: readonly string[]
  readonly secondaryKeys: readonly string[]
  readonly content: string
  readonly enabled: boolean
  readonly insertionOrder: number
  readonly selective: boolean
  readonly constant: boolean
  readonly caseSensitive: boolean
  readonly matchWholeWords: boolean
  readonly secondaryLogic: 'and-any' | 'and-all' | 'not-any' | 'not-all'
  readonly scanDepth?: number
  /** ST `extensions.exclude_recursion`: this entry may activate normally, but not from recursive text. */
  readonly excludeRecursion?: boolean
  /** ST `extensions.prevent_recursion`: this entry activates normally, but its content is not scanned recursively. */
  readonly preventRecursion?: boolean
  /** ST `extensions.delay_until_recursion`: false/0 means normal; true maps to recursion level 1. */
  readonly delayUntilRecursion?: boolean | number
  /** ST/Tavern Helper timed effect: keep active for N subsequent messages. */
  readonly sticky?: number
  /** ST/Tavern Helper timed effect: block activation for N subsequent messages. */
  readonly cooldown?: number
  /** ST/Tavern Helper timed effect: require N chat messages before activation. */
  readonly delay?: number
  /** ST inclusion-group name(s), comma-separated in the source format. */
  readonly group?: string
  /** ST inclusion-group priority override. */
  readonly groupOverride?: boolean
  /** Weighted-random weight inside an inclusion group. */
  readonly groupWeight?: number
  /** Enable ST key-score filtering for this entry's inclusion group. */
  readonly useGroupScoring?: boolean
  readonly position: 'before_char' | 'after_char'
  /**
   * SillyTavern position 枚举原值(0=before,1=after,2=ANTop,3=ANBottom,
   * 4=atDepth,5=EMTop,6=EMBottom,7=outlet)。来源 `extensions.position ??`
   * (数字 position==='before_char'?0:1),与 ST world-info.js:5517 换算一致。
   * 本项目用它做 constant 条目 → 三文档 的简化映射(见 docs/st-adaptation-research.md §8)。
   */
  readonly stPosition?: number
  /**
   * SillyTavern 激活概率 %(默认 100)。本项目语义:绿灯条目由 2.1 LLM agent
   * 选中后,由代码按 `Math.random()*100 <= probability` 掷骰收尾(ST 同款公式,
   * world-info.js:4907-4925);蓝灯条目不掷骰(与 ST 的差异:ST 对 constant
   * 也会掷骰,本项目蓝灯严格无条件常驻)。
   */
  readonly probability?: number
  /** 概率开关(ST 默认 true;false = 跳过掷骰恒激活)。 */
  readonly useProbability?: boolean
  readonly priority?: number
  /** Card extension flag allowing this entry to bypass the ordinary lorebook token budget. */
  readonly ignoreBudget: boolean
  /** V3 key-matching mode retained from the card transport. */
  readonly useRegex: boolean
  /** Executable template or decorator syntax remains exportable but never activates. */
  readonly hasDecorators: boolean
}

/** Character-specific lorebook normalized for deterministic activation. */
export interface ImportedLorebook {
  readonly name?: string
  readonly scanDepth?: number
  readonly tokenBudget?: number
  readonly recursiveScanning: boolean
  readonly entries: readonly ImportedLorebookEntry[]
}

/** One SillyTavern World Info feature retained in raw JSON but not fully executed. */
export const WORLD_INFO_IMPORT_DEGRADATIONS = [
  'entry-advanced-matching',
  'entry-decorators',
  'entry-probability',
  'entry-regex',
  'entry-unsupported-position',
  'lorebook-recursion',
  'timed-effects',
  'vector-matching',
] as const

/** One SillyTavern World Info feature retained in raw JSON but not executed. */
export type WorldInfoImportDegradation = typeof WORLD_INFO_IMPORT_DEGRADATIONS[number]

/** Lossless standalone SillyTavern World Info import. */
export interface ImportedWorldInfo {
  readonly format: 0
  readonly name?: string
  readonly lorebook: ImportedLorebook
  readonly degradations: readonly WorldInfoImportDegradation[]
  /** Exact parsed JSON, including unsupported fields and extension namespaces. */
  readonly raw: JsonValue
}

/** Canonical imported card persisted with the native tool result. */
export interface ImportedCharacterCard {
  readonly format: 0
  readonly version: CharacterCardVersion
  readonly specVersion: string
  readonly name: string
  readonly nickname?: string
  readonly description: string
  readonly personality: string
  readonly scenario: string
  readonly firstMessage: string
  readonly messageExample: string
  readonly alternateGreetings: readonly string[]
  readonly systemPrompt: string
  readonly postHistoryInstructions: string
  readonly assets?: readonly ImportedCharacterAsset[]
  readonly lorebook?: ImportedLorebook
  readonly frontend: ImportedCharacterFrontend
  readonly degradations: readonly CharacterImportDegradation[]
  /** Exact parsed JSON, including unknown fields and extension namespaces. */
  readonly raw: JsonValue
}

/** SillyTavern chat header retained independently from model-visible history. */
export interface ImportedSillyTavernChatHeader {
  readonly userName?: string
  readonly characterName?: string
  readonly createDate?: JsonValue
  readonly chatMetadata: JsonValue
  /** Exact parsed header object, including unknown fields. */
  readonly raw: JsonValue
}

/** One parsed SillyTavern chat row before conversion to a DSH Session log. */
export interface ImportedSillyTavernChatMessage {
  readonly line: number
  readonly name?: string
  readonly text: string
  readonly kind: 'user' | 'assistant' | 'narrator' | 'system'
  readonly swipes: readonly string[]
  readonly swipeId?: number
  readonly extra?: JsonValue
  /** Exact parsed message object, including unknown fields. */
  readonly raw: JsonValue
}

/** Lossless SillyTavern JSONL import with an explicit model-history projection. */
export interface ImportedSillyTavernChat {
  readonly format: 0
  readonly header: ImportedSillyTavernChatHeader
  readonly messages: readonly ImportedSillyTavernChatMessage[]
}

/** Result of decoding one PNG transport before card validation. */
export interface CharacterCardPngPayload {
  readonly keyword: 'ccv3' | 'chara'
  readonly json: string
}
