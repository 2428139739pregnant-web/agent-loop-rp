/** DeepSeek provider using the OpenAI-compatible chat completions API. */

import type { AgentLoopConfig } from '../config.ts'
import type { ChatMessage, ChatOptions, LLMProvider, LLMResult } from '../provider.ts'

interface DeepSeekResponse {
  id?: string
  choices?: Array<{ message?: { role?: string; content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek'
  constructor(private readonly config: AgentLoopConfig) {}

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResult> {
    if (this.config.apiKey === undefined) {
      throw new Error(
        'DeepSeekProvider requires DEEPSEEK_API_KEY; set it in env or use MockProvider for demos.',
      )
    }
    const body = {
      model: options?.model ?? this.config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
      ...(options?.response_format !== undefined ? { response_format: options.response_format } : {}),
    }
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>')
      throw new Error(`DeepSeek chat failed: ${response.status} ${response.statusText} — ${text}`)
    }
    const payload = await response.json() as DeepSeekResponse
    const content = payload.choices?.[0]?.message?.content ?? ''
    const usage = payload.usage
    return {
      content,
      ...(usage?.prompt_tokens !== undefined && usage.completion_tokens !== undefined
        ? { usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } }
        : {}),
    }
  }
}
