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
  /** Optional OpenAI-compatible message name, used by ST example/group messages. */
  name?: string
  /** SillyTavern-compatible assistant alternatives. User/system messages do not use swipes. */
  swipe_id?: number
  swipes?: string[]
  swipe_info?: SwipeInfo[]
}

export interface ChatOptions {
  model?: string
  temperature?: number
  /** OpenAI-compatible completion cap; the response prompt still carries the soft length target. */
  max_tokens?: number
  response_format?: { type: 'json_object' } | { type: 'text' }
}

export interface LLMUsage {
  prompt_tokens: number
  completion_tokens: number
}

export interface LLMResult {
  content: string
  usage?: LLMUsage
}

export interface LLMProvider {
  readonly name: string
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResult>
}
