/** Agent ④ — Async summarizer (fire-and-forget).
 *
 * Condenses one conversational turn (typically a user+assistant pair) into a
 * 100-200 字 prose summary and writes it to the per-session summary file
 * returned by {@link SessionStore.summaryPath}. Runs detached from the main
 * loop: callers should not `await` it, and any failure is swallowed with a
 * log line so a broken summarizer can never take the response pipeline down.
 *
 * The next time 2.2 looks for a summary and finds none, it falls back to the
 * raw history — so a missed or failed summary is non-fatal by design.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChatMessage } from '../provider.ts'
import type { Agent, AgentContext } from './types.ts'

/** Input for the summarizer. Just the slice of the conversation to compress. */
export interface SummarizeInput {
  /** This turn's messages (usually a user + assistant pair). */
  messages: readonly ChatMessage[]
  /** Optional persona for the active character; helps the model keep the summary in-character. */
  character?: { name: string; persona: string }
}

/** Replace `{{key}}` placeholders in the prompt template. No escaping — inputs are controlled. */
function renderTemplate(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value)
  }
  return out
}

/** Render a message list as markdown suitable for prompt input. */
function formatMessages(messages: readonly ChatMessage[]): string {
  return messages
    .map(m => `**${m.role}**: ${m.content}`)
    .join('\n\n')
}

/** Write the summary to disk. Never throws — logs and returns.
 *
 *  `SessionStore.summaryPath` returns a single file path
 *  (`summary/<sessionId>.md`); we overwrite it in place. The parent directory
 *  is created on first write so the caller doesn't have to bootstrap it.
 */
async function persistSummary(ctx: AgentContext, summary: string): Promise<void> {
  try {
    const target = ctx.session.summaryPath(ctx.sessionId)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, summary, 'utf-8')
  } catch (err) {
    console.error('[summarize-agent] persist failed:', err)
  }
}

/** Fire-and-forget entrypoint. Returns a Promise the caller can either await
 *  or detach from. Internally catches every error so a thrown rejection can
 *  never reach the main reply flow.
 */
export async function triggerSummarize(input: SummarizeInput, ctx: AgentContext): Promise<void> {
  try {
    const template = await ctx.prompts.load('summarize')

    const systemPrompt = renderTemplate(template, {
      character_name: input.character?.name ?? '角色',
      character_persona: input.character?.persona ?? '',
      messages: formatMessages(input.messages),
    })

    const result = await ctx.provider.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请生成上述对话的摘要。' },
      ],
      {
        model: ctx.model,
        temperature: 0.2,
      },
    )

    await persistSummary(ctx, result.content)
  } catch (err) {
    // Fire-and-forget: never let a summary failure crash the main flow.
    console.error('[summarize-agent] failed:', err)
  }
}

/** Pure-LLM variant matching the standard `Agent<I, O>` contract — returns the
 *  summary string instead of writing it. Useful for tests / one-off tooling.
 *  The hot path uses {@link triggerSummarize}.
 */
export const summarizeAgent: Agent<SummarizeInput, string> = {
  name: 'summarize',

  async run(input: SummarizeInput, ctx: AgentContext): Promise<string> {
    const template = await ctx.prompts.load('summarize')
    const systemPrompt = renderTemplate(template, {
      character_name: input.character?.name ?? '角色',
      character_persona: input.character?.persona ?? '',
      messages: formatMessages(input.messages),
    })
    const result = await ctx.provider.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请生成上述对话的摘要。' },
      ],
      {
        model: ctx.model,
        temperature: 0.2,
      },
    )
    return result.content
  },
}
