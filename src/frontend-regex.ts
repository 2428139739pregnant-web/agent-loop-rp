/** SillyTavern-compatible character regex execution for prompt and display views. */

import type { ImportedCharacterFrontend, ImportedRegexScript } from './import/types.ts'
export {
  compileCharacterDisplay,
  hasCharacterDisplayFrontend,
  normalizeLegacyCardHtml,
  normalizeSillyTavernMarkdown,
  splitCharacterDisplay,
  type CardDisplayDiagnostic,
  type CharacterDisplaySegment,
  type CompiledCharacterDisplay,
} from './card-display-compiler.ts'

/** Message-source field identifying a logged model-only prompt-regex replacement. */
export const PROMPT_REGEX_SOURCE_MARKER = 'dshAgentRpPromptRegex'

/** Minimal identity needed by a character-owned regex script. */
export interface RegexCharacter {
  readonly name: string
  readonly nickname?: string
  readonly frontend: ImportedCharacterFrontend
}

/** Non-sensitive compatibility summary for one imported character regex. */
export interface CharacterRegexScriptSummary {
  readonly scriptName: string
  readonly enabled: boolean
  readonly state: 'active' | 'partial' | 'disabled' | 'unsupported' | 'invalid'
  readonly placement: readonly number[]
  readonly unsupportedPlacement: readonly number[]
  readonly display: boolean
  readonly prompt: boolean
  readonly runOnEdit: boolean
  readonly minDepth: number | null
  readonly maxDepth: number | null
}

/** Why one regex script did or did not affect a prompt message. */
export type PromptRegexOutcome =
  | 'applied'
  | 'disabled'
  | 'display-only'
  | 'placement'
  | 'depth'
  | 'invalid'
  | 'no-match'

/** Prompt rendering result with one non-sensitive outcome per ordered script. */
export interface PromptRegexTrace {
  readonly text: string
  readonly scripts: readonly {
    readonly index: number
    readonly scriptName: string
    readonly outcome: PromptRegexOutcome
  }[]
}

/** Non-sensitive result of the latest model-facing regex pass. */
export interface PromptRegexTraceRecord {
  readonly format: 0
  readonly turn: number
  readonly step: number
  readonly messageCount: number
  readonly replacementCount: number
  readonly scripts: readonly {
    readonly source: 'preset' | 'character'
    readonly index: number
    readonly scriptName: string
    readonly outcome: PromptRegexOutcome
    readonly affectedMessages: number
  }[]
}

/** Metadata carried by the latest model-only surface replacement. */
export interface PromptRegexSourceMarker {
  readonly format: 0
  readonly originalSeq: number
  readonly trace?: PromptRegexTraceRecord
}

const PROMPT_REGEX_OUTCOMES = new Set<PromptRegexOutcome>([
  'applied',
  'disabled',
  'display-only',
  'placement',
  'depth',
  'invalid',
  'no-match',
])

function promptRegexTraceRecord(value: unknown): PromptRegexTraceRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.format !== 0
    || typeof record.turn !== 'number' || !Number.isSafeInteger(record.turn) || record.turn < 0
    || typeof record.step !== 'number' || !Number.isSafeInteger(record.step) || record.step < 0
    || typeof record.messageCount !== 'number' || !Number.isSafeInteger(record.messageCount) || record.messageCount < 0
    || typeof record.replacementCount !== 'number' || !Number.isSafeInteger(record.replacementCount) || record.replacementCount < 0
    || !Array.isArray(record.scripts)) return undefined
  const scripts: PromptRegexTraceRecord['scripts'][number][] = []
  for (const value of record.scripts) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const script = value as Record<string, unknown>
    if ((script.source !== 'preset' && script.source !== 'character')
      || typeof script.index !== 'number' || !Number.isSafeInteger(script.index) || script.index < 0
      || typeof script.scriptName !== 'string'
      || typeof script.outcome !== 'string' || !PROMPT_REGEX_OUTCOMES.has(script.outcome as PromptRegexOutcome)
      || typeof script.affectedMessages !== 'number' || !Number.isSafeInteger(script.affectedMessages)
      || script.affectedMessages < 0) return undefined
    scripts.push({
      source: script.source,
      index: script.index,
      scriptName: script.scriptName,
      outcome: script.outcome as PromptRegexOutcome,
      affectedMessages: script.affectedMessages,
    })
  }
  return {
    format: 0,
    turn: record.turn,
    step: record.step,
    messageCount: record.messageCount,
    replacementCount: record.replacementCount,
    scripts,
  }
}

/** Read model-only replacement metadata without trusting durable source fields. */
export function readPromptRegexSourceMarker(value: unknown): PromptRegexSourceMarker | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.format !== 0 || typeof record.originalSeq !== 'number'
    || !Number.isSafeInteger(record.originalSeq) || record.originalSeq < 0) return undefined
  const trace = promptRegexTraceRecord(record.trace)
  return { format: 0, originalSeq: record.originalSeq, ...(trace === undefined ? {} : { trace }) }
}

function substituteCardMacros(
  value: string,
  card: RegexCharacter,
  userName = '用户',
  transform: (replacement: string) => string = replacement => replacement,
): string {
  const name = card.nickname?.trim() || card.name
  return value
    .replace(/\{\{char\}\}|<char>|<bot>/giu, transform(name))
    .replace(/\{\{user\}\}|<user>/giu, transform(userName))
}

/** SillyTavern regex placement for a human-authored message. */
export const USER_INPUT_PLACEMENT = 1
/** SillyTavern regex placement for a character-authored message. */
export const AI_OUTPUT_PLACEMENT = 2

function compileRegex(value: string): RegExp | undefined {
  try {
    const literal = value.match(/^\/([\s\S]*)\/([a-z]*)$/iu)
    if (literal === null) return new RegExp(value)
    const flags = literal[2] ?? ''
    if (flags !== '' && !/^(?!.*?(.).*?\1)[dgimsuvy]+$/u.test(flags)) return new RegExp(value)
    return new RegExp(literal[1] ?? '', flags)
  } catch (_invalidRegex) {
    return undefined
  }
}

/** Describe executable coverage without returning a script expression or replacement. */
export function summarizeCharacterRegexScript(script: ImportedRegexScript): CharacterRegexScriptSummary {
  const placement = [...new Set(script.placement)]
  const supportedPlacement = placement.filter(value => value === USER_INPUT_PLACEMENT || value === AI_OUTPUT_PLACEMENT)
  const unsupportedPlacement = placement.filter(value => value !== USER_INPUT_PLACEMENT && value !== AI_OUTPUT_PLACEMENT)
  const valid = script.findRegex !== '' && compileRegex(script.findRegex) !== undefined
  const substitutionSupported = [0, 1, 2].includes(Number(script.substituteRegex))
  const state = script.disabled ? 'disabled' as const
    : !valid ? 'invalid' as const
      : supportedPlacement.length === 0 ? 'unsupported' as const
        : unsupportedPlacement.length > 0 || !substitutionSupported ? 'partial' as const
          : 'active' as const
  return {
    scriptName: script.scriptName,
    enabled: !script.disabled,
    state,
    placement,
    unsupportedPlacement,
    display: script.markdownOnly || (!script.markdownOnly && !script.promptOnly),
    prompt: script.promptOnly || (!script.markdownOnly && !script.promptOnly),
    runOnEdit: script.runOnEdit,
    minDepth: script.minDepth,
    maxDepth: script.maxDepth,
  }
}

function escapeRegexMacro(value: string): string {
  return value.replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gu, character => {
    switch (character) {
      case '\n': return '\\n'
      case '\r': return '\\r'
      case '\t': return '\\t'
      case '\v': return '\\v'
      case '\f': return '\\f'
      case '\0': return '\\0'
      default: return `\\${character}`
    }
  })
}

function substitutedFindRegex(script: ImportedRegexScript, card: RegexCharacter, userName?: string): string {
  switch (Number(script.substituteRegex)) {
    case 1: return substituteCardMacros(script.findRegex, card, userName)
    case 2: return substituteCardMacros(script.findRegex, card, userName, escapeRegexMacro)
    default: return script.findRegex
  }
}

function inDepth(script: ImportedRegexScript, depth: number | undefined): boolean {
  if (depth === undefined) return true
  if (script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) return false
  return script.maxDepth === null || script.maxDepth < 0 || depth <= script.maxDepth
}

function filterMatch(value: string, trimStrings: readonly string[], card: RegexCharacter, userName?: string): string {
  return trimStrings.reduce((text, trim) => text.replaceAll(substituteCardMacros(trim, card, userName), ''), value)
}

function applyScript(
  raw: string,
  script: ImportedRegexScript,
  card: RegexCharacter,
  userName?: string,
): string {
  return applyScriptWithOutcome(raw, script, card, userName).text
}

function applyScriptWithOutcome(
  raw: string,
  script: ImportedRegexScript,
  card: RegexCharacter,
  userName?: string,
): { readonly text: string; readonly outcome: 'applied' | 'invalid' | 'no-match' } {
  const find = compileRegex(substitutedFindRegex(script, card, userName))
  if (find === undefined || script.findRegex === '') return { text: raw, outcome: 'invalid' }
  if (raw === '') return { text: raw, outcome: 'no-match' }
  let matched = false
  const text = raw.replace(find, (...args: unknown[]) => {
    matched = true
    const groups = typeof args.at(-1) === 'object' && args.at(-1) !== null
      ? args.at(-1) as Record<string, string | undefined>
      : undefined
    const replacement = script.replaceString.replace(/\{\{match\}\}/giu, '$0').replace(
      /\$(\d+)|\$<([^>]+)>/gu,
      (_token, numeric: string | undefined, named: string | undefined) => {
        const match = numeric === undefined ? groups?.[named ?? ''] : args[Number(numeric)]
        return typeof match === 'string' ? filterMatch(match, script.trimStrings, card, userName) : ''
      },
    )
    return substituteCardMacros(replacement, card, userName)
  })
  return { text, outcome: matched ? 'applied' : 'no-match' }
}

function runScripts(
  raw: string,
  card: RegexCharacter,
  placement: number,
  view: 'display' | 'prompt',
  depth?: number,
  userName?: string,
  presetScripts: readonly ImportedRegexScript[] = [],
): string {
  const scripts = [...presetScripts, ...card.frontend.regexScripts]
  const normalized = scripts.reduce((text, script) => {
    if (script.disabled || !script.placement.includes(placement) || !inDepth(script, depth)) return text
    return !script.markdownOnly && !script.promptOnly ? applyScript(text, script, card, userName) : text
  }, raw)
  return scripts.reduce((text, script) => {
    if (script.disabled || !script.placement.includes(placement) || !inDepth(script, depth)) return text
    return (view === 'display' ? script.markdownOnly : script.promptOnly)
      ? applyScript(text, script, card, userName)
      : text
  }, normalized)
}

function removeVisibleTextToken(value: string, token: string): string {
  if (token === '') return value
  let result = ''
  let cursor = 0
  let index = value.indexOf(token)
  while (index >= 0) {
    result += value.slice(cursor, index)
    const lower = value.toLocaleLowerCase()
    const insideTag = value.lastIndexOf('<', index) > value.lastIndexOf('>', index)
    const insideRawElement = ['script', 'style', 'template'].some(tag =>
      lower.lastIndexOf(`<${tag}`, index) > lower.lastIndexOf(`</${tag}`, index))
    if (insideTag || insideRawElement) result += token
    cursor = index + token.length
    index = value.indexOf(token, cursor)
  }
  return result + value.slice(cursor)
}

function stripDisplayOnlyCharacterMediaFields(value: string, raw: string): string {
  const fields = [...raw.matchAll(/<角色图片(?:\s[^<>]*?)?>[\s\S]*?<\/角色图片\s*>/giu)].map(match => match[0])
  const filenames = fields.flatMap(field => [...field.matchAll(
    /<img(?:\s[^<>]*?)?>([^<>]*?\.(?:avif|gif|jpe?g|png|webp))<\/img\s*>/giu,
  )].map(match => match[1]?.trim() ?? '').filter(Boolean))
  let visible = value.replace(/<角色图片(?:\s[^<>]*?)?>([\s\S]*?)<\/角色图片\s*>/giu, (_field, content: string) =>
    /<img\b[^>]*\bsrc\s*=/iu.test(content) ? content : '')
  for (const filename of new Set(filenames)) visible = removeVisibleTextToken(visible, filename)
  return visible
}

/** Apply character display-only scripts without executing their HTML. */
export function renderCharacterDisplay(
  raw: string,
  card: RegexCharacter,
  placement: number,
  depth?: number,
  userName?: string,
  presetScripts?: readonly ImportedRegexScript[],
): string {
  return stripDisplayOnlyCharacterMediaFields(
    runScripts(raw, card, placement, 'display', depth, userName, presetScripts),
    raw,
  )
}

/** Apply character prompt-only scripts before model context leaves the roleplay boundary. */
export function renderCharacterPromptView(
  raw: string,
  card: RegexCharacter,
  placement: number,
  depth?: number,
  userName?: string,
  presetScripts?: readonly ImportedRegexScript[],
): string {
  return runScripts(raw, card, placement, 'prompt', depth, userName, presetScripts)
}

/** Render the prompt view and explain each script without exposing its expression or replacement. */
export function traceCharacterPromptView(
  raw: string,
  card: RegexCharacter,
  placement: number,
  depth?: number,
  userName?: string,
  presetScripts: readonly ImportedRegexScript[] = [],
): PromptRegexTrace {
  const scripts = [...presetScripts, ...card.frontend.regexScripts]
  const outcomes = new Map<number, PromptRegexOutcome>()
  let text = raw
  for (const [index, script] of scripts.entries()) {
    if (script.disabled) outcomes.set(index, 'disabled')
    else if (!script.placement.includes(placement)) outcomes.set(index, 'placement')
    else if (!inDepth(script, depth)) outcomes.set(index, 'depth')
    else if (script.markdownOnly || script.promptOnly) {
      if (script.markdownOnly && !script.promptOnly) outcomes.set(index, 'display-only')
    } else {
      const result = applyScriptWithOutcome(text, script, card, userName)
      text = result.text
      outcomes.set(index, result.outcome)
    }
  }
  for (const [index, script] of scripts.entries()) {
    if (outcomes.has(index)) continue
    if (!script.promptOnly) {
      outcomes.set(index, 'display-only')
      continue
    }
    const result = applyScriptWithOutcome(text, script, card, userName)
    text = result.text
    outcomes.set(index, result.outcome)
  }
  return {
    text,
    scripts: scripts.map((script, index) => ({
      index,
      scriptName: script.scriptName,
      outcome: outcomes.get(index) ?? 'no-match',
    })),
  }
}

/** Remove a single outer Markdown HTML fence emitted by card display scripts. */
export function unwrapHtmlFence(value: string): string {
  const match = value.trim().match(/^```html\s*([\s\S]*?)\s*```$/iu)
  return match?.[1] ?? value
}
