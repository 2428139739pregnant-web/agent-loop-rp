/** Safe, session-independent generation primitives for Tavern Helper. */

import type {
  ChatMessage,
  ChatOptions,
  JsonSchemaDefinition,
  LLMProvider,
  LLMResult,
  ToolChoice,
  ToolDefinition,
} from './provider.ts'
import { applyWorldbookPromptInjections } from './worldbook-plugin.ts'
import type { WorldbookPromptInjection } from './schema.ts'

const MAX_PROMPTS = 256
const MAX_PROMPT_CHARS = 512 * 1024
const MAX_MODEL_CHARS = 256
const MAX_INJECTS = 256

/** The placeholder names documented by JS-Slash-Runner's generate API. */
export type TavernPromptPlaceholder =
  | 'world_info_before'
  | 'persona_description'
  | 'char_description'
  | 'char_personality'
  | 'scenario'
  | 'world_info_after'
  | 'dialogue_examples'
  | 'chat_history'
  | 'user_input'

export const TAVERN_PLACEHOLDER_DEFAULT_ORDER: readonly TavernPromptPlaceholder[] = [
  'world_info_before',
  'persona_description',
  'char_description',
  'char_personality',
  'scenario',
  'world_info_after',
  'dialogue_examples',
  'chat_history',
  'user_input',
]

export type TavernGenerationPrompt = TavernPromptPlaceholder | ChatMessage

export interface TavernGenerationOverrides {
  readonly world_info_before?: string
  readonly persona_description?: string
  readonly char_description?: string
  readonly char_personality?: string
  readonly scenario?: string
  readonly world_info_after?: string
  readonly dialogue_examples?: string
  readonly chat_history?: {
    readonly with_depth_entries?: boolean
    readonly author_note?: string
    readonly prompts?: readonly ChatMessage[]
  }
}

/** JSON-safe subset of the official InjectionPrompt accepted by generate(). */
export interface TavernGenerationInject {
  readonly content: string
  readonly position: 'before_prompt' | 'in_prompt' | 'in_chat' | 'none'
  readonly depth: number
  readonly role: 'system' | 'assistant' | 'user'
  readonly order: number
  readonly shouldScan: boolean
}

/** Prompt sources reconstructed from the active Agent RP session. */
export interface TavernGenerationSources {
  readonly world_info_before?: string
  readonly persona_description?: string
  readonly char_description?: string
  readonly char_personality?: string
  readonly scenario?: string
  readonly world_info_after?: string
  readonly dialogue_examples?: string | readonly ChatMessage[]
  readonly chat_history?: readonly ChatMessage[]
  readonly chat_history_depth_entries?: readonly ChatMessage[]
  readonly author_note?: string
  /** Prompt-Template injections selected from the active Tavern Helper state. */
  readonly worldbook_prompt_injections?: readonly WorldbookPromptInjection[]
  /** Script-authored Tavern Helper injections selected for this generation. */
  readonly injected_prompts?: readonly TavernGenerationInject[]
  readonly user_input?: string
}

/** JSON-safe custom API subset from Tavern Helper's GenerateConfig. */
export interface TavernCustomApiConfig {
  readonly proxy_preset?: string
  readonly apiurl?: string
  readonly key?: string
  readonly model?: string
  readonly source?: string
  readonly max_tokens?: 'same_as_preset' | 'unset' | number
  readonly temperature?: 'same_as_preset' | 'unset' | number
}

export interface TavernGenerateRawRequest {
  readonly ordered_prompts?: readonly TavernGenerationPrompt[]
  readonly generation_id?: string
  readonly user_input?: string
  readonly overrides?: TavernGenerationOverrides
  readonly injects?: readonly TavernGenerationInject[]
  readonly max_chat_history?: 'all' | number
  readonly custom_api?: TavernCustomApiConfig
  readonly tools?: readonly ToolDefinition[]
  readonly tool_choice?: ToolChoice
  readonly json_schema?: JsonSchemaDefinition
  readonly model?: string
  readonly temperature?: number
  readonly max_tokens?: number
  readonly response_format?: ChatOptions['response_format']
  readonly should_stream?: boolean
  readonly should_silence?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function boundedString(value: unknown, label: string, max = MAX_PROMPT_CHARS): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  if (value.length > max) throw new Error(`${label} is too large`)
  return value
}

function boundedOptionalString(value: unknown, label: string, max = MAX_MODEL_CHARS): string | undefined {
  if (value === undefined) return undefined
  return boundedString(value, label, max)
}

function parseJsonRecord(value: unknown, label: string, maxChars = MAX_PROMPT_CHARS): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  let serialized: string
  try { serialized = JSON.stringify(value) } catch { throw new Error(`${label} is not JSON-safe`) }
  if (serialized.length > maxChars) throw new Error(`${label} is too large`)
  return JSON.parse(serialized) as Record<string, unknown>
}

function parseRolePrompt(value: unknown, label: string): ChatMessage {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  const role = value.role
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    throw new Error(`${label}.role is invalid`)
  }
  const content = boundedString(value.content, `${label}.content`)
  return {
    role,
    content,
    ...(typeof value.name === 'string' ? { name: value.name.slice(0, MAX_MODEL_CHARS) } : {}),
  }
}

function parseOverrides(value: unknown): TavernGenerationOverrides | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('generate overrides must be an object')
  const textKeys = [
    'world_info_before', 'persona_description', 'char_description',
    'char_personality', 'scenario', 'world_info_after', 'dialogue_examples',
  ] as const
  const out: Record<string, unknown> = {}
  for (const key of textKeys) {
    if (value[key] !== undefined) out[key] = boundedString(value[key], `generate overrides.${key}`)
  }
  if (value.chat_history !== undefined) {
    if (!isRecord(value.chat_history)) throw new Error('generate overrides.chat_history must be an object')
    const chatHistory: Record<string, unknown> = {}
    if (value.chat_history.with_depth_entries !== undefined) {
      if (typeof value.chat_history.with_depth_entries !== 'boolean') {
        throw new Error('generate overrides.chat_history.with_depth_entries must be boolean')
      }
      chatHistory.with_depth_entries = value.chat_history.with_depth_entries
    }
    if (value.chat_history.author_note !== undefined) {
      chatHistory.author_note = boundedString(value.chat_history.author_note, 'generate overrides.chat_history.author_note')
    }
    if (value.chat_history.prompts !== undefined) {
      if (!Array.isArray(value.chat_history.prompts) || value.chat_history.prompts.length > MAX_PROMPTS) {
        throw new Error('generate overrides.chat_history.prompts is invalid')
      }
      chatHistory.prompts = value.chat_history.prompts.map((prompt, index) =>
        parseRolePrompt(prompt, `generate overrides.chat_history.prompts[${index}]`))
    }
    out.chat_history = chatHistory
  }
  return out as TavernGenerationOverrides
}

function parseInjects(value: unknown): readonly TavernGenerationInject[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_INJECTS) throw new Error('generate injects is invalid')
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`generate injects[${index}] must be an object`)
    const position = raw.position
    if (position !== 'before_prompt' && position !== 'in_prompt' && position !== 'in_chat' && position !== 'none') {
      throw new Error(`generate injects[${index}].position is invalid`)
    }
    const role = raw.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new Error(`generate injects[${index}].role is invalid`)
    }
    const depth = finiteNumber(raw.depth, `generate injects[${index}].depth`) ?? 0
    const order = finiteNumber(raw.order, `generate injects[${index}].order`) ?? 100
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > 65535) {
      throw new Error(`generate injects[${index}].depth is invalid`)
    }
    if (!Number.isSafeInteger(order) || order < -1_000_000 || order > 1_000_000) {
      throw new Error(`generate injects[${index}].order is invalid`)
    }
    const shouldScan = raw.shouldScan ?? raw.should_scan
    if (shouldScan !== undefined && typeof shouldScan !== 'boolean') {
      throw new Error(`generate injects[${index}].should_scan is invalid`)
    }
    return {
      content: boundedString(raw.content, `generate injects[${index}].content`),
      position,
      depth,
      role,
      order,
      shouldScan: shouldScan !== false,
    }
  })
}

function parseCustomApi(value: unknown): TavernCustomApiConfig | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('generate custom_api must be an object')
  const numberOrSentinel = (raw: unknown, label: string): 'same_as_preset' | 'unset' | number | undefined => {
    if (raw === undefined) return undefined
    if (raw === 'same_as_preset' || raw === 'unset') return raw
    const number = finiteNumber(raw, label)
    if (number === undefined || number < 0 || number > 131072) throw new Error(`${label} is invalid`)
    return number
  }
  const apiurl = boundedOptionalString(value.apiurl, 'generate custom_api.apiurl', 2_048)
  if (apiurl !== undefined) {
    let parsed: URL
    try { parsed = new URL(apiurl) } catch { throw new Error('generate custom_api.apiurl is invalid') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('generate custom_api.apiurl must use http or https')
  }
  const key = boundedOptionalString(value.key, 'generate custom_api.key', 4_096)
  const model = boundedOptionalString(value.model, 'generate custom_api.model')
  const proxyPreset = boundedOptionalString(value.proxy_preset, 'generate custom_api.proxy_preset')
  const source = boundedOptionalString(value.source, 'generate custom_api.source', 64)
  const maxTokens = numberOrSentinel(value.max_tokens, 'generate custom_api.max_tokens')
  const temperature = numberOrSentinel(value.temperature, 'generate custom_api.temperature')
  return {
    ...(proxyPreset === undefined ? {} : { proxy_preset: proxyPreset }),
    ...(apiurl === undefined ? {} : { apiurl }),
    ...(key === undefined ? {} : { key }),
    ...(model === undefined ? {} : { model }),
    ...(source === undefined ? {} : { source }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
  }
}

function parseTools(value: unknown): readonly ToolDefinition[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 64) throw new Error('generate tools is invalid')
  return value.map((raw, index) => {
    if (!isRecord(raw) || raw.type !== 'function' || !isRecord(raw.function)) {
      throw new Error(`generate tools[${index}] is invalid`)
    }
    const name = boundedString(raw.function.name, `generate tools[${index}].function.name`, 256)
    const description = boundedOptionalString(raw.function.description, `generate tools[${index}].function.description`, MAX_PROMPT_CHARS)
    const parameters = raw.function.parameters === undefined
      ? undefined : parseJsonRecord(raw.function.parameters, `generate tools[${index}].function.parameters`, 128 * 1024)
    return {
      type: 'function' as const,
      function: {
        name,
        ...(description === undefined ? {} : { description }),
        ...(parameters === undefined ? {} : { parameters }),
      },
    }
  })
}

function parseToolChoice(value: unknown): ToolChoice | undefined {
  if (value === undefined) return undefined
  if (value === 'auto' || value === 'required' || value === 'none' || value === 'any') return value
  if (!isRecord(value) || value.type !== 'function' || !isRecord(value.function)) {
    throw new Error('generate tool_choice is invalid')
  }
  return {
    type: 'function',
    function: { name: boundedString(value.function.name, 'generate tool_choice.function.name', 256) },
  }
}

function parseJsonSchema(value: unknown): JsonSchemaDefinition | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('generate json_schema must be an object')
  const name = boundedString(value.name, 'generate json_schema.name', 256)
  const description = boundedOptionalString(value.description, 'generate json_schema.description', MAX_PROMPT_CHARS)
  const schema = parseJsonRecord(value.value, 'generate json_schema.value', 256 * 1024)
  if (value.strict !== undefined && typeof value.strict !== 'boolean') throw new Error('generate json_schema.strict must be boolean')
  return { name, ...(description === undefined ? {} : { description }), value: schema, ...(value.strict === undefined ? {} : { strict: value.strict }) }
}

/** Validate the JSON-safe part of the official generateRaw contract. */
export function parseTavernGenerateRawRequest(value: unknown): TavernGenerateRawRequest {
  if (!isRecord(value)) throw new Error('generateRaw request must be an object')
  const rawPrompts = value.ordered_prompts === undefined ? ['user_input'] : value.ordered_prompts
  if (!Array.isArray(rawPrompts) || rawPrompts.length > MAX_PROMPTS) throw new Error(`generateRaw ordered_prompts must contain 0-${MAX_PROMPTS} messages`)
  let chars = 0
  const ordered_prompts = rawPrompts.map((raw, index) => {
    if (typeof raw === 'string') {
      if (!TAVERN_PLACEHOLDER_DEFAULT_ORDER.includes(raw as TavernPromptPlaceholder)) {
        throw new Error(`generateRaw ordered_prompts[${index}] placeholder is invalid`)
      }
      chars += raw.length
      return raw as TavernPromptPlaceholder
    }
    const message = parseRolePrompt(raw, `generateRaw ordered_prompts[${index}]`)
    chars += message.content.length
    if (chars > MAX_PROMPT_CHARS) throw new Error('generateRaw ordered_prompts are too large')
    return message
  })
  if (typeof value.user_input === 'string' && value.user_input.length > MAX_PROMPT_CHARS) {
    throw new Error('generate user_input is too large')
  }
  if (value.user_input !== undefined && typeof value.user_input !== 'string') {
    throw new Error('generate user_input must be a string')
  }
  const generationId = value.generation_id === undefined ? undefined : boundedString(value.generation_id, 'generate generation_id', 256)
  const maxChatHistory = value.max_chat_history
  if (maxChatHistory !== undefined && maxChatHistory !== 'all'
    && (typeof maxChatHistory !== 'number' || !Number.isSafeInteger(maxChatHistory)
      || maxChatHistory < 0 || maxChatHistory > MAX_PROMPTS)) {
    throw new Error('generate max_chat_history is invalid')
  }
  const overrides = parseOverrides(value.overrides)
  const injects = parseInjects(value.injects)
  const customApi = parseCustomApi(value.custom_api)
  const tools = parseTools(value.tools)
  const toolChoice = parseToolChoice(value.tool_choice)
  const jsonSchema = parseJsonSchema(value.json_schema)
  if (tools !== undefined && jsonSchema !== undefined) throw new Error('generate tools and json_schema are mutually exclusive')
  const model = value.model === undefined ? undefined : typeof value.model === 'string' && value.model.length <= MAX_MODEL_CHARS
    ? value.model : (() => { throw new Error('generateRaw model is invalid') })()
  const temperature = finiteNumber(value.temperature, 'generateRaw temperature')
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) throw new Error('generateRaw temperature must be between 0 and 2')
  const maxTokens = finiteNumber(value.max_tokens, 'generateRaw max_tokens')
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 131072)) {
    throw new Error('generateRaw max_tokens is invalid')
  }
  const responseFormat = value.response_format
  const normalizedResponseFormat = responseFormat === undefined ? undefined
    : isRecord(responseFormat) && (responseFormat.type === 'json_object' || responseFormat.type === 'text')
      ? { type: responseFormat.type } as ChatOptions['response_format']
      : (() => { throw new Error('generateRaw response_format is invalid') })()
  return {
    ordered_prompts,
    ...(generationId === undefined ? {} : { generation_id: generationId }),
    ...(value.user_input === undefined ? {} : { user_input: value.user_input }),
    ...(overrides === undefined ? {} : { overrides }),
    ...(injects === undefined ? {} : { injects }),
    ...(maxChatHistory === undefined ? {} : { max_chat_history: maxChatHistory }),
    ...(customApi === undefined ? {} : { custom_api: customApi }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(jsonSchema === undefined ? {} : { json_schema: jsonSchema }),
    ...(model === undefined ? {} : { model }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(normalizedResponseFormat === undefined ? {} : { response_format: normalizedResponseFormat }),
    ...(value.should_stream === undefined ? {} : { should_stream: value.should_stream === true }),
    ...(value.should_silence === undefined ? {} : { should_silence: value.should_silence === true }),
  }
}

/** Apply the official placeholder/override semantics before the provider call. */
export function expandTavernGenerateRequest(
  request: TavernGenerateRawRequest,
  sources: TavernGenerationSources = {},
): ChatMessage[] {
  const overrides = request.overrides ?? {}
  const valueFor = (key: Exclude<TavernPromptPlaceholder, 'chat_history' | 'user_input' | 'dialogue_examples'>): string => {
    const override = overrides[key]
    if (override !== undefined) return override
    return sources[key] ?? ''
  }
  const historyOverride = overrides.chat_history?.prompts
  const depthEntries = overrides.chat_history?.with_depth_entries === false
    ? [] : [...(sources.chat_history_depth_entries ?? [])]
  const history = historyOverride === undefined
    ? [...(sources.chat_history ?? []), ...depthEntries]
    : [...historyOverride]
  const authorNote = overrides.chat_history?.author_note ?? sources.author_note
  if (authorNote !== undefined && authorNote.trim().length > 0) history.push({ role: 'system', content: authorNote })
  const historyLimit = request.max_chat_history
  const limitedHistory = historyLimit === undefined || historyLimit === 'all'
    ? history
    : history.slice(-historyLimit)
  const userInput = request.user_input ?? sources.user_input ?? ''
  const expanded: ChatMessage[] = []
  for (const prompt of request.ordered_prompts ?? ['user_input']) {
    if (typeof prompt !== 'string') {
      expanded.push({ ...prompt })
      continue
    }
    switch (prompt) {
      case 'chat_history':
        expanded.push(...limitedHistory.map(message => ({ ...message })))
        break
      case 'dialogue_examples':
        if (Array.isArray(sources.dialogue_examples)) {
          expanded.push(...sources.dialogue_examples.map(message => ({ ...message })))
        } else {
          const dialogue = overrides.dialogue_examples
            ?? (typeof sources.dialogue_examples === 'string' ? sources.dialogue_examples : '')
          if (dialogue.length > 0) expanded.push({ role: 'system', content: dialogue })
        }
        break
      case 'user_input':
        expanded.push({ role: 'user', content: userInput })
        break
      default: {
        const content = valueFor(prompt)
        if (content.length > 0) expanded.push({ role: 'system', content })
        break
      }
    }
  }
  return applyGenerationInjects(
    expanded,
    [...(sources.injected_prompts ?? []), ...(request.injects ?? [])],
  )
}

function applyGenerationInjects(
  baseMessages: readonly ChatMessage[],
  injects: readonly TavernGenerationInject[],
): ChatMessage[] {
  const ordered = [...injects]
    .filter(inject => inject.position !== 'none' && inject.content.trim().length > 0)
    .sort((left, right) => left.order - right.order)
  const beforePrompt = ordered.filter(inject => inject.position === 'before_prompt')
  const inPrompt = ordered.filter(inject => inject.position === 'in_prompt')
  const inChat = ordered.filter(inject => inject.position === 'in_chat')
  const messages = baseMessages.map(message => ({ ...message }))
  if (inPrompt.length > 0) messages.unshift(...inPrompt.map(inject => ({ role: inject.role, content: inject.content })))
  if (beforePrompt.length > 0) {
    const userIndex = messages.findIndex(message => message.role === 'user')
    const index = userIndex < 0 ? messages.length : userIndex
    messages.splice(index, 0, ...beforePrompt.map(inject => ({ role: inject.role, content: inject.content })))
  }
  if (inChat.length === 0) return messages
  const reversed = messages.reverse()
  let inserted = 0
  for (const depth of [...new Set(inChat.map(inject => inject.depth))].sort((left, right) => left - right)) {
    const prompts = inChat.filter(inject => inject.depth === depth)
    const index = Math.min(depth + inserted, reversed.length)
    reversed.splice(index, 0, ...prompts.map(inject => ({ role: inject.role, content: inject.content })))
    inserted += prompts.length
  }
  return reversed.reverse()
}

/** Call the provider once without entering the Agent RP pipeline or session history. */
export async function generateTavernRaw(
  provider: LLMProvider,
  request: TavernGenerateRawRequest,
  sources: TavernGenerationSources = {},
): Promise<LLMResult> {
  const model = request.model ?? request.custom_api?.model
  const temperature = request.temperature ?? (typeof request.custom_api?.temperature === 'number' ? request.custom_api.temperature : undefined)
  const maxTokens = request.max_tokens ?? (typeof request.custom_api?.max_tokens === 'number' ? request.custom_api.max_tokens : undefined)
  const options: ChatOptions = {
    ...(model === undefined ? {} : { model }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(request.response_format === undefined ? {} : { response_format: request.response_format }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
    ...(request.json_schema === undefined ? {} : { json_schema: request.json_schema }),
  }
  const expanded = expandTavernGenerateRequest(request, sources)
  const messages = applyWorldbookPromptInjections(
    expanded,
    sources.worldbook_prompt_injections ?? [],
  )
  return provider.chat(messages, options)
}
