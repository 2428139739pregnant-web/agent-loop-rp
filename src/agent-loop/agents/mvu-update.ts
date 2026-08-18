/** Dedicated MVU variable-analysis call.
 *
 * This deliberately lives outside responseAgent. The roleplay model writes
 * user-visible prose; this model only inspects that prose and emits a
 * validated machine-readable update block.
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { PreprocessedCharacter } from '../character-loader.ts'
import { normalizeMvuSupplement, renderMvuUpdateInstructions } from '../../mvu.ts'
import type { AgentContext } from './types.ts'

export interface MvuRuntimeSettings {
  readonly enabled: boolean
  /** Empty means reuse the main API model, while remaining a separate call. */
  readonly model: string
  readonly temperature: number
  /** Prompt file stem; the server only exposes safe prompt names. */
  readonly promptName: string
}

export interface MvuUpdateInput {
  readonly character: PreprocessedCharacter
  readonly userInput: string
  readonly assistantReply: string
  readonly statData: JsonValue
}

export interface MvuUpdateResult {
  readonly update: string | undefined
  readonly rules: string | undefined
}

const TEMPLATE_VAR_RE = /\{\{(mvu_state|user_input|assistant_reply|mvu_update_rules)\}\}/gu

function renderPrompt(template: string, input: MvuUpdateInput, rules: string): string {
  const values: Record<string, string> = {
    mvu_state: JSON.stringify(input.statData, null, 2),
    user_input: input.userInput,
    assistant_reply: input.assistantReply,
    mvu_update_rules: rules,
  }
  return template.replace(TEMPLATE_VAR_RE, (_match, key: string) => values[key] ?? '')
}

/** Run the extra MVU completion. The caller owns state mutation/persistence. */
export async function runMvuUpdate(
  input: MvuUpdateInput,
  ctx: AgentContext,
  settings: MvuRuntimeSettings,
): Promise<MvuUpdateResult> {
  const rules = renderMvuUpdateInstructions(input.character.raw, input.statData)
  if (!settings.enabled || rules === undefined) return { update: undefined, rules }

  let template = await ctx.prompts.load(settings.promptName)
  if (ctx.renderTemplate !== undefined) {
    const rendered = ctx.renderTemplate(template)
    if (rendered.ok === true) template = rendered.text
  }
  const prompt = renderPrompt(template, input, rules)
  const model = settings.model.trim() || ctx.model
  const result = await ctx.provider.chat(
    [
      {
        role: 'system',
        content: [
          '你是独立的 MVU 变量处理器，不是角色扮演正文生成器。',
          '你只能根据卡片规则分析正文并输出一个机器可解析的变量更新块。',
          '不要续写、改写或评价正文；没有变量变化时输出空 JSON Patch。',
        ].join('\n'),
      },
      { role: 'user', content: prompt },
    ],
    { model, temperature: settings.temperature },
  )

  return {
    rules,
    update: normalizeMvuSupplement(input.statData, result.content),
  }
}

