/**
 * A deliberately small, side-effect-free STscript boundary.
 *
 * This module does not execute slash commands.  It only recognizes the
 * commands that can be represented safely as data for a later UI bridge.
 * Runtime macros, pipes, closures, and every command outside the allowlist
 * are rejected rather than being guessed or evaluated.
 */

export const MAX_TRIGGER_SLASH_SOURCE_LENGTH = 64 * 1024
export const MAX_WAIT_MILLISECONDS = 60_000

const SUPPORTED_ECHO_SEVERITIES = ['info', 'warning', 'error', 'success'] as const
const SUPPORTED_COMMANDS = ['echo', 'pass', 'wait', 'delay', 'sleep'] as const

export type SlashEchoSeverity = typeof SUPPORTED_ECHO_SEVERITIES[number]
export type SupportedSlashCommand = typeof SUPPORTED_COMMANDS[number]

export type SlashUnsupportedReason =
  | 'input-too-large'
  | 'pipeline'
  | 'macro-resolution-required'
  | 'closure'
  | 'unknown-command'
  | 'side-effect-command'
  | 'unsupported-argument'

export type SlashInvalidReason =
  | 'not-a-command'
  | 'empty-command'
  | 'malformed-quoting'
  | 'missing-argument'
  | 'invalid-severity'
  | 'invalid-delay'
  | 'delay-out-of-range'

export interface SlashParseBase {
  readonly source: string
  readonly status: 'supported'
  readonly command: SupportedSlashCommand
  /** Canonical command name (`wait` for `/wait`, `/delay`, and `/sleep`). */
  readonly canonicalCommand: 'echo' | 'pass' | 'wait'
}

export interface SlashEchoResult extends SlashParseBase {
  readonly canonicalCommand: 'echo'
  readonly command: 'echo'
  readonly severity: SlashEchoSeverity
  /** Text that a future UI bridge may display; it is never interpreted as HTML here. */
  readonly text: string
  readonly output: string
}

export interface SlashPassResult extends SlashParseBase {
  readonly canonicalCommand: 'pass'
  readonly command: 'pass'
  /** Literal pipe value. Macros and expressions are intentionally not resolved. */
  readonly value: string
  readonly output: string
}

export interface SlashWaitResult extends SlashParseBase {
  readonly canonicalCommand: 'wait'
  readonly command: SupportedSlashCommand
  readonly delayMs: number
  /** Always empty: waiting is described, never performed by this module. */
  readonly output: ''
}

export type SupportedSlashParseResult = SlashEchoResult | SlashPassResult | SlashWaitResult

export interface SlashUnsupportedResult {
  readonly source: string
  readonly status: 'unsupported'
  readonly command?: string
  readonly reason: SlashUnsupportedReason
}

export interface SlashInvalidResult {
  readonly source: string
  readonly status: 'invalid'
  readonly command?: string
  readonly reason: SlashInvalidReason
}

export interface SlashEmptyResult {
  readonly source: string
  readonly status: 'empty'
}

export type TriggerSlashParseResult =
  | SupportedSlashParseResult
  | SlashUnsupportedResult
  | SlashInvalidResult
  | SlashEmptyResult

interface TokenizeResult {
  readonly tokens: string[]
  readonly hasPipe: boolean
  readonly malformedQuoting: boolean
}

function tokenizeArguments(value: string): TokenizeResult {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | undefined
  let escaped = false

  const push = (): void => {
    if (started) tokens.push(current)
    current = ''
    started = false
  }

  for (const character of value) {
    if (escaped) {
      current += character
      started = true
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      started = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      started = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
      continue
    }
    if (character === '|') return { tokens, hasPipe: true, malformedQuoting: false }
    if (/\s/u.test(character)) {
      push()
      continue
    }
    current += character
    started = true
  }

  if (escaped || quote !== undefined) return { tokens: [], hasPipe: false, malformedQuoting: true }
  push()
  return { tokens, hasPipe: false, malformedQuoting: false }
}

function hasMacroSyntax(source: string): boolean {
  // Being conservative here is intentional.  Resolving a macro would need
  // chat/session state, and treating escaped macro-looking text as dynamic is
  // safer than accidentally evaluating it in a later bridge.
  return source.includes('{{') || source.includes('}}')
}

function hasClosureSyntax(source: string): boolean {
  return source.includes('{:') || source.includes(':}') || source.includes('/*') || source.includes('*|')
}

function unsupported(source: string, reason: SlashUnsupportedReason, command?: string): SlashUnsupportedResult {
  return { source, status: 'unsupported', ...(command === undefined ? {} : { command }), reason }
}

function invalid(source: string, reason: SlashInvalidReason, command?: string): SlashInvalidResult {
  return { source, status: 'invalid', ...(command === undefined ? {} : { command }), reason }
}

function splitNamedArgument(token: string): { name: string; value: string } | undefined {
  const separator = token.indexOf('=')
  if (separator <= 0) return undefined
  const name = token.slice(0, separator)
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name)) return undefined
  return { name: name.toLowerCase(), value: token.slice(separator + 1) }
}

function isEchoSeverity(value: string): value is SlashEchoSeverity {
  return (SUPPORTED_ECHO_SEVERITIES as readonly string[]).includes(value)
}

function parseSupportedCommand(source: string, command: string, argumentText: string): TriggerSlashParseResult {
  const tokenized = tokenizeArguments(argumentText)
  if (tokenized.hasPipe) return unsupported(source, 'pipeline', command)
  if (tokenized.malformedQuoting) return invalid(source, 'malformed-quoting', command)

  if (command === 'echo') {
    let severity: SlashEchoSeverity = 'info'
    let tokenIndex = 0
    while (true) {
      const token = tokenized.tokens[tokenIndex]
      const named = token === undefined ? undefined : splitNamedArgument(token)
      if (named === undefined) break
      if (named.name !== 'severity') return unsupported(source, 'unsupported-argument', command)
      if (tokenIndex > 0) return unsupported(source, 'unsupported-argument', command)
      if (!isEchoSeverity(named.value)) return invalid(source, 'invalid-severity', command)
      severity = named.value
      tokenIndex += 1
    }
    const text = tokenized.tokens.slice(tokenIndex).join(' ')
    return {
      source,
      status: 'supported',
      command: 'echo',
      canonicalCommand: 'echo',
      severity,
      text,
      output: text,
    }
  }

  if (command === 'pass') {
    if (tokenized.tokens.length === 0) return invalid(source, 'missing-argument', command)
    const value = tokenized.tokens.join(' ')
    return {
      source,
      status: 'supported',
      command: 'pass',
      canonicalCommand: 'pass',
      value,
      output: value,
    }
  }

  if (tokenized.tokens.length !== 1) {
    return tokenized.tokens.length === 0
      ? invalid(source, 'missing-argument', command)
      : invalid(source, 'invalid-delay', command)
  }
  const delayText = tokenized.tokens[0] ?? ''
  if (!/^\d+$/u.test(delayText)) return invalid(source, 'invalid-delay', command)
  const delayMs = Number(delayText)
  if (!Number.isSafeInteger(delayMs)) return invalid(source, 'invalid-delay', command)
  if (delayMs > MAX_WAIT_MILLISECONDS) return invalid(source, 'delay-out-of-range', command)
  return {
    source,
    status: 'supported',
    command: command as SupportedSlashCommand,
    canonicalCommand: 'wait',
    delayMs,
    output: '',
  }
}

/**
 * Parse one STscript command without executing it.
 *
 * The parser intentionally accepts one command only.  A pipe is returned as
 * `unsupported` so a future caller cannot mistake a partial parse for a safe
 * execution plan.  No macro, JavaScript, network, file, DOM, or model access
 * occurs in this function.
 */
export function parseTriggerSlash(source: string): TriggerSlashParseResult {
  if (source.trim().length === 0) return { source, status: 'empty' }
  if (source.length > MAX_TRIGGER_SLASH_SOURCE_LENGTH) return unsupported(source, 'input-too-large')

  const trimmed = source.trim()
  if (!trimmed.startsWith('/')) return invalid(source, 'not-a-command')
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)/u.exec(trimmed)
  if (match === null) return invalid(source, 'empty-command')
  const command = match[1]?.toLowerCase()
  if (command === undefined) return invalid(source, 'empty-command')

  if (hasMacroSyntax(trimmed)) return unsupported(source, 'macro-resolution-required', command)
  if (hasClosureSyntax(trimmed)) return unsupported(source, 'closure', command)

  const supported = (SUPPORTED_COMMANDS as readonly string[]).includes(command)
  if (!supported) {
    const sideEffectCommands = new Set([
      'js', 'javascript', 'eval', 'run', 'fetch', 'websearch', 'import', 'export',
      'file', 'send', 'sendas', 'trigger', 'generate', 'genraw', 'reload-page',
    ])
    return unsupported(source, sideEffectCommands.has(command) ? 'side-effect-command' : 'unknown-command', command)
  }

  const argumentText = trimmed.slice(match[0].length)
  return parseSupportedCommand(source, command, argumentText)
}

/** Alias with the shorter name used by parser-focused callers. */
export const parseSlashCommand = parseTriggerSlash

/** The command names this pure layer is willing to classify as executable data. */
export const CONTROLLED_TRIGGER_SLASH_COMMANDS: readonly SupportedSlashCommand[] = Object.freeze([...SUPPORTED_COMMANDS])
