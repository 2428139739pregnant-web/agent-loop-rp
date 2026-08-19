/**
 * Deterministic compatibility for ST-Prompt-Template's special World Info
 * entries.  This module deliberately has no provider access: it turns
 * special-entry declarations into a prompt/display plan that the response
 * stage can apply locally.
 */

import type { ChatMessage } from './provider.ts'
import type {
  WorldbookPluginOutput,
  WorldbookPromptInjection,
  WorldbookPromptPlacement,
  WorldbookPromptRole,
  WorldbookRenderDirective,
} from './schema.ts'
import { substituteUserCharMacros } from './persona-store.ts'
import type { AgentContext } from './agents/types.ts'

export interface WorldbookPluginCandidate {
  path: string
  comment: string
  content?: string
  order: number
  weight: number
  probability?: number
  useProbability?: boolean
  constant?: boolean
  /** Whether ST's ordinary keyword lane activated this special entry. */
  active?: boolean
  pluginKinds?: readonly string[]
}

interface ParsedDecorator {
  name: string
  argument: string
}

interface ContentPreparation {
  content: string
  decorators: ParsedDecorator[]
  skip?: string
}

function leadingDecorators(source: string): { body: string; decorators: ParsedDecorator[] } {
  const lines = source.split(/\r?\n/u)
  const decorators: ParsedDecorator[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const match = /^@@(?!@)(\S+)(?:\s+([\s\S]*))?$/u.exec(line.trim())
    if (match === null) break
    decorators.push({ name: (match[1] ?? '').toLowerCase(), argument: (match[2] ?? '').trim() })
    index += 1
  }
  return { body: lines.slice(index).join('\n'), decorators }
}

function renderContent(candidate: WorldbookPluginCandidate, ctx: AgentContext): ContentPreparation {
  const parsed = leadingDecorators(candidate.content ?? ctx.worldbook.getContent(candidate.path) ?? '')
  if (parsed.decorators.some(d => d.name === 'dont_activate' || d.name === 'only_preload')) {
    return { content: '', decorators: parsed.decorators, skip: 'decorator prevents generation-time activation' }
  }

  let source = parsed.body
  const condition = parsed.decorators.find(d => d.name === 'if')
  if (condition !== undefined) {
    // The isolated EJS renderer already exposes the same variable scope used
    // by response prompts. Wrapping the body keeps @@if local and adds no LLM
    // work. Without a renderer we fail closed rather than activating unknown
    // conditional content.
    if (ctx.renderTemplate === undefined || condition.argument.length === 0) {
      return { content: '', decorators: parsed.decorators, skip: '@@if requires the isolated template renderer' }
    }
    source = `<% if (${condition.argument}) { %>${source}<% } %>`
  }

  if (ctx.renderTemplate !== undefined) {
    const rendered = ctx.renderTemplate(source, { worldInfoBookId: candidate.path })
    if (rendered.ok === false) {
      return { content: '', decorators: parsed.decorators, skip: `EJS render failed: ${rendered.kind}` }
    }
    source = rendered.text
  }

  const macro = (text: string): string => substituteUserCharMacros(
    text,
    ctx.macros?.user ?? null,
    ctx.macros?.char ?? null,
  )
  return { content: macro(source), decorators: parsed.decorators }
}

function passesProbability(candidate: WorldbookPluginCandidate): boolean {
  if (candidate.useProbability === false) return true
  const probability = candidate.probability ?? 100
  if (probability >= 100) return true
  if (probability <= 0) return false
  return Math.random() * 100 <= probability
}

function role(value: string | undefined, fallback: WorldbookPromptRole = 'system'): WorldbookPromptRole {
  return value === 'user' || value === 'assistant' || value === 'system' ? value : fallback
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/** Split comma-separated @INJECT parameters while preserving quoted regexes. */
function splitAssignments(source: string): string[] {
  const out: string[] = []
  let start = 0
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quote !== null) { escaped = true; continue }
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char !== ',') continue
    // Unquoted regexes may contain commas. Treat a comma as a separator only
    // when the following text begins another parameter assignment.
    if (/^\s*[A-Za-z_][\w-]*\s*=/u.test(source.slice(i + 1))) {
      out.push(source.slice(start, i).trim())
      start = i + 1
    }
  }
  const tail = source.slice(start).trim()
  if (tail.length > 0) out.push(tail)
  return out
}

function parseAssignments(source: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const assignment of splitAssignments(source)) {
    const separator = assignment.indexOf('=')
    if (separator < 1) continue
    const key = assignment.slice(0, separator).trim().toLowerCase()
    result.set(key, unquote(assignment.slice(separator + 1)))
  }
  return result
}

function injectParameters(comment: string): Map<string, string> | undefined {
  const match = /^\s*@INJECT\b\s*(?:\[([\s\S]*)\]|([\s\S]*))?$/iu.exec(comment)
  if (match === null) return undefined
  return parseAssignments((match[1] ?? match[2] ?? '').trim())
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseAt(value: string | undefined): 'before' | 'after' {
  return value?.toLowerCase() === 'after' ? 'after' : 'before'
}

function parseInject(comment: string): WorldbookPromptPlacement | undefined {
  const params = injectParameters(comment)
  if (params === undefined) return undefined
  const position = params.get('pos')
  if (position !== undefined) {
    return { kind: 'absolute', position: parseInteger(position, 0) }
  }
  const targetRole = params.get('target')
  if (targetRole !== undefined && (targetRole === 'system' || targetRole === 'user' || targetRole === 'assistant')) {
    return {
      kind: 'target',
      targetRole,
      targetIndex: parseInteger(params.get('index'), 1),
      at: parseAt(params.get('at')),
    }
  }
  const regex = params.get('regex')
  if (regex !== undefined && regex.length > 0) {
    return { kind: 'regex', pattern: regex, at: parseAt(params.get('at')) }
  }
  // `@INJECT role=system` is the extension's default target: before the
  // first user message. It is useful for cards that omit target explicitly.
  return { kind: 'target', targetRole: 'user', targetIndex: 1, at: 'before' }
}

function generatePlacement(spec: string | undefined): WorldbookPromptPlacement | undefined {
  const value = (spec ?? '').trim().toUpperCase()
  if (value === 'BEFORE') return { kind: 'message', messageIndex: 0, at: 'before' }
  if (value === 'AFTER' || value === '') return { kind: 'message', messageIndex: -1, at: 'after' }
  const indexed = /^(-?\d+):(BEFORE|AFTER)$/u.exec(value)
  if (indexed !== null) {
    return {
      kind: 'message',
      messageIndex: Number.parseInt(indexed[1] ?? '0', 10),
      at: indexed[2]?.toLowerCase() === 'after' ? 'after' : 'before',
    }
  }
  if (value.startsWith('REGEX:')) {
    const pattern = spec?.trim().slice('REGEX:'.length) ?? ''
    return pattern.length > 0 ? { kind: 'regex', pattern, at: 'before' } : undefined
  }
  return undefined
}

function renderPlacement(spec: string | undefined): 'before' | 'after' {
  return (spec ?? '').trim().toUpperCase() === 'BEFORE' ? 'before' : 'after'
}

function directive(comment: string, name: 'GENERATE' | 'RENDER'): string | undefined {
  const re = new RegExp(`^\\s*\\[${name}(?::([^\\]]*))?\\]`, 'iu')
  const match = re.exec(comment)
  return match === null ? undefined : (match[1] ?? '')
}

function decoratorPlacement(
  decorators: readonly ParsedDecorator[],
  prefix: 'generate' | 'render',
): string | undefined {
  const hit = decorators.find(d => d.name === `${prefix}_before` || d.name === `${prefix}_after`)
  if (hit === undefined) return undefined
  return hit.name.endsWith('_before') ? 'BEFORE' : 'AFTER'
}

function outputWith(
  promptInjections: WorldbookPromptInjection[],
  renderDirectives: WorldbookRenderDirective[],
  skipped: Array<{ path: string; reason: string }>,
): WorldbookPluginOutput {
  promptInjections.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))
  renderDirectives.sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))
  return { promptInjections, renderDirectives, skipped }
}

function isActivated(candidate: WorldbookPluginCandidate): boolean {
  // ST-Prompt-Template defines @INJECT as an extension-owned directive. It
  // is processed regardless of the entry's blue/green activation state; the
  // extension's own settings decide whether disabled special entries are
  // honoured. Do not force it through the ordinary World Info key matcher.
  const isInject = candidate.pluginKinds?.includes('inject')
    || /^\s*@INJECT\b/iu.test(candidate.comment)
  return isInject === true || candidate.constant === true || candidate.active === true
}

function canApplyGeneration(
  candidate: WorldbookPluginCandidate,
  placement: WorldbookPromptPlacement,
): boolean {
  // REGEX placement performs its own activation against the final message
  // array, matching ST-Prompt-Template's [GENERATE:REGEX:*] behavior.
  if (placement.kind === 'regex') return true
  // BEFORE is a blue-light-only feature; AFTER accepts an activated green
  // entry as well as a constant blue entry.
  if (placement.kind === 'message' && placement.at === 'before') {
    return candidate.constant === true
  }
  return isActivated(candidate)
}

function canApplyRender(candidate: WorldbookPluginCandidate, placement: 'before' | 'after'): boolean {
  return placement === 'before' ? candidate.constant === true : isActivated(candidate)
}

/** Build the local plugin plan. This function never calls `ctx.provider.chat`. */
export function buildWorldbookPluginOutput(
  candidates: readonly WorldbookPluginCandidate[],
  ctx: AgentContext,
): WorldbookPluginOutput {
  const promptInjections: WorldbookPromptInjection[] = []
  const renderDirectives: WorldbookRenderDirective[] = []
  const skipped: Array<{ path: string; reason: string }> = []

  for (const candidate of candidates) {
    if (!isActivated(candidate)) {
      skipped.push({ path: candidate.path, reason: 'entry was not activated by ST key/constant rules' })
      continue
    }
    if (!passesProbability(candidate)) {
      skipped.push({ path: candidate.path, reason: 'trigger probability did not pass' })
      continue
    }
    const prepared = renderContent(candidate, ctx)
    if (prepared.skip !== undefined) {
      skipped.push({ path: candidate.path, reason: prepared.skip })
      continue
    }
    const content = prepared.content
    if (content.length === 0) {
      skipped.push({ path: candidate.path, reason: 'empty special-entry content' })
      continue
    }

    const injectPlacement = parseInject(candidate.comment)
    if (injectPlacement !== undefined) {
      const params = injectParameters(candidate.comment)
      promptInjections.push({
        path: candidate.path,
        content,
        role: role(params?.get('role')),
        order: candidate.order,
        placement: injectPlacement,
      })
      continue
    }

    const generateSpec = directive(candidate.comment, 'GENERATE')
      ?? decoratorPlacement(prepared.decorators, 'generate')
    const generatePlacement = generatePlacementForCandidate(generateSpec)
    if (generatePlacement !== undefined && canApplyGeneration(candidate, generatePlacement)) {
      promptInjections.push({
        path: candidate.path,
        content,
        role: 'system',
        order: candidate.order,
        placement: generatePlacement,
      })
      continue
    }

    const renderSpec = directive(candidate.comment, 'RENDER')
      ?? decoratorPlacement(prepared.decorators, 'render')
    const renderPlacementValue = renderPlacement(renderSpec)
    if ((renderSpec !== undefined || prepared.decorators.some(d => d.name === 'render'))
      && canApplyRender(candidate, renderPlacementValue)) {
      renderDirectives.push({
        path: candidate.path,
        content,
        order: candidate.order,
        placement: renderPlacementValue,
      })
      continue
    }

    // @@activate turns an otherwise ordinary decorated entry into a blue
    // prompt block. Keep it visible to the model instead of dropping it.
    if (prepared.decorators.some(d => d.name === 'activate' || d.name === 'always_enabled')) {
      promptInjections.push({
        path: candidate.path,
        content,
        role: 'system',
        order: candidate.order,
        placement: { kind: 'message', messageIndex: 0, at: 'after' },
      })
      continue
    }

    skipped.push({ path: candidate.path, reason: 'decorator/control syntax is preserved but has no runtime mapping' })
  }

  return outputWith(promptInjections, renderDirectives, skipped)
}

function generatePlacementForCandidate(spec: string | undefined): WorldbookPromptPlacement | undefined {
  if (spec === undefined) return undefined
  if (spec?.trim().toUpperCase().startsWith('REGEX:') === true) {
    const pattern = spec.trim().slice('REGEX:'.length)
    return pattern.length > 0 ? { kind: 'regex', pattern, at: 'before' } : undefined
  }
  return generatePlacement(spec)
}

function normalizeMessageIndex(index: number, length: number): number | undefined {
  if (length === 0) return undefined
  const normalized = index < 0 ? length + index : index
  if (normalized < 0 || normalized >= length) return undefined
  return normalized
}

function absoluteIndex(position: number, length: number): number {
  if (position <= 1 && position >= 0) return 0
  if (position > 1) return Math.min(length, position - 1)
  return Math.max(0, Math.min(length, length + position))
}

function targetIndex(messages: readonly ChatMessage[], roleName: WorldbookPromptRole, index: number): number | undefined {
  const hits = messages.flatMap((message, messageIndex) => message.role === roleName ? [messageIndex] : [])
  if (hits.length === 0) return undefined
  const offset = index < 0 ? hits.length + index : index - 1
  return hits[offset]
}

function insertAt(messages: ChatMessage[], index: number, injection: WorldbookPromptInjection): void {
  messages.splice(Math.max(0, Math.min(index, messages.length)), 0, {
    role: injection.role,
    content: injection.content,
  })
}

/** Apply a previously built plan to the exact message array sent to the LLM. */
export function applyWorldbookPromptInjections(
  baseMessages: readonly ChatMessage[],
  injections: readonly WorldbookPromptInjection[],
): ChatMessage[] {
  const messages = baseMessages.map(message => ({ ...message }))
  for (const injection of [...injections].sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))) {
    const placement = injection.placement
    if (placement.kind === 'message') {
      const index = normalizeMessageIndex(placement.messageIndex, messages.length)
      if (index === undefined) continue
      const message = messages[index]
      if (message === undefined) continue
      message.content = placement.at === 'before'
        ? `${injection.content}\n\n${message.content}`
        : `${message.content}\n\n${injection.content}`
      continue
    }
    if (placement.kind === 'absolute') {
      insertAt(messages, absoluteIndex(placement.position, messages.length), injection)
      continue
    }
    if (placement.kind === 'target') {
      const target = targetIndex(messages, placement.targetRole, placement.targetIndex)
      if (target === undefined) continue
      insertAt(messages, placement.at === 'after' ? target + 1 : target, injection)
      continue
    }
    let regex: RegExp
    try { regex = new RegExp(placement.pattern, 'iu') } catch { continue }
    const hits = messages.flatMap((message, index) => regex.test(message.content) ? [index] : [])
    for (const hit of hits.reverse()) {
      insertAt(messages, placement.at === 'after' ? hit + 1 : hit, injection)
    }
  }
  return messages
}

/** Apply display-only [RENDER] directives after the model reply is complete. */
export function applyWorldbookRenderDirectives(
  reply: string,
  directives: readonly WorldbookRenderDirective[],
): string {
  let result = reply
  for (const directive of [...directives].sort((a, b) => a.order - b.order || a.path.localeCompare(b.path))) {
    result = directive.placement === 'before'
      ? `${directive.content}\n\n${result}`
      : `${result}\n\n${directive.content}`
  }
  return result
}
