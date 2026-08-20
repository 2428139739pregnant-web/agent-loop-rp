/** LLM provider abstraction for the agent loop. */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface SwipeInfo {
  readonly send_date?: number
  readonly gen_started?: number
  readonly gen_finished?: number
  readonly extra?: Readonly<Record<string, unknown>>
}

export interface ChatMessage {
  role: ChatRole
  content: string
  /** Stable SillyTavern floor id when a card supplies one. */
  message_id?: number
  /** Optional OpenAI-compatible message name, used by ST example/group messages. */
  name?: string
  /** SillyTavern hidden-floor marker. Hidden floors remain durable but are not rendered by the chat surface. */
  is_hidden?: boolean
  /** Card/plugin-owned message metadata retained across Tavern Helper mutations. */
  data?: Record<string, unknown>
  extra?: Record<string, unknown>
  /** SillyTavern-compatible assistant alternatives. User/system messages do not use swipes. */
  swipe_id?: number
  swipes?: string[]
  swipe_info?: SwipeInfo[]
  swipes_data?: Record<string, unknown>[]
  swipes_info?: Record<string, unknown>[]
}

/** OpenAI-compatible tool definition used by Tavern Helper auxiliary calls. */
export interface ToolDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description?: string
    readonly parameters?: Record<string, unknown>
  }
}

export type ToolChoice = 'auto' | 'required' | 'none' | 'any' | {
  readonly type: 'function'
  readonly function: { readonly name: string }
}

export interface JsonSchemaDefinition {
  readonly name: string
  readonly description?: string
  readonly value: Record<string, unknown>
  readonly strict?: boolean
}

export interface ChatOptions {
  model?: string
  temperature?: number
  /** OpenAI-compatible completion cap; the response prompt still carries the soft length target. */
  max_tokens?: number
  response_format?: { type: 'json_object' } | { type: 'text' }
  /** Optional OpenAI-compatible function calling for isolated helper generation. */
  tools?: readonly ToolDefinition[]
  tool_choice?: ToolChoice
  /** Host-neutral schema; providers translate it to their wire format. */
  json_schema?: JsonSchemaDefinition
}

export interface LLMUsage {
  prompt_tokens: number
  completion_tokens: number
}

export interface LLMResult {
  content: string
  usage?: LLMUsage
  tool_calls?: readonly {
    readonly id: string
    readonly type: 'function'
    readonly function: { readonly name: string; readonly arguments: string }
  }[]
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResult>
}
