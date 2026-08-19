/** LLM provider abstraction for the agent loop. */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatMessage {
  role: ChatRole
  content: string
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
