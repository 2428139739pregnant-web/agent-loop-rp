/** Safe, session-independent generation primitives for Tavern Helper. */

import type { ChatMessage, ChatOptions, LLMProvider, LLMResult } from './provider.ts'

const MAX_PROMPTS = 256
const MAX_PROMPT_CHARS = 512 * 1024
const MAX_MODEL_CHARS = 256

export interface TavernGenerateRawRequest {
  readonly ordered_prompts: readonly ChatMessage[]
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

/** Validate only the ordered-prompt subset that can be represented by the provider. */
export function parseTavernGenerateRawRequest(value: unknown): TavernGenerateRawRequest {
  if (!isRecord(value) || !Array.isArray(value.ordered_prompts)) {
    throw new Error('generateRaw requires ordered_prompts')
  }
  if (value.ordered_prompts.length === 0 || value.ordered_prompts.length > MAX_PROMPTS) {
    throw new Error(`generateRaw ordered_prompts must contain 1-${MAX_PROMPTS} messages`)
  }
  let chars = 0
  const ordered_prompts = value.ordered_prompts.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`generateRaw ordered_prompts[${index}] must be an object`)
    const role = raw.role
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new Error(`generateRaw ordered_prompts[${index}].role is invalid`)
    }
    if (typeof raw.content !== 'string') throw new Error(`generateRaw ordered_prompts[${index}].content must be a string`)
    chars += raw.content.length
    if (chars > MAX_PROMPT_CHARS) throw new Error('generateRaw ordered_prompts are too large')
    return {
      role,
      content: raw.content,
      ...(typeof raw.name === 'string' ? { name: raw.name.slice(0, MAX_MODEL_CHARS) } : {}),
    } satisfies ChatMessage
  })
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
    ...(model === undefined ? {} : { model }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(normalizedResponseFormat === undefined ? {} : { response_format: normalizedResponseFormat }),
    ...(value.should_stream === undefined ? {} : { should_stream: value.should_stream === true }),
    ...(value.should_silence === undefined ? {} : { should_silence: value.should_silence === true }),
  }
}

/** Call the provider once without entering the Agent RP pipeline or session history. */
export async function generateTavernRaw(
  provider: LLMProvider,
  request: TavernGenerateRawRequest,
): Promise<LLMResult> {
  const options: ChatOptions = {
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.max_tokens === undefined ? {} : { max_tokens: request.max_tokens }),
    ...(request.response_format === undefined ? {} : { response_format: request.response_format }),
  }
  return provider.chat(request.ordered_prompts.map(message => ({ ...message })), options)
}
