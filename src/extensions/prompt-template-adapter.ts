/** Stable project-side contract for ST-Prompt-Template compatibility. */

import type { AgentContext } from '../agent-loop/agents/types.ts'
import { applyWorldbookPromptInjections, buildWorldbookPluginOutput } from '../agent-loop/worldbook-plugin.ts'
import type { ChatMessage } from '../agent-loop/provider.ts'
import type { WorldbookPluginCandidate } from '../agent-loop/worldbook-plugin.ts'
import type { WorldbookPluginOutput } from '../agent-loop/schema.ts'

export const PROMPT_TEMPLATE_ADAPTER = Object.freeze({
  id: 'prompt-template' as const,
  officialRepository: 'zonde306/ST-Prompt-Template',
  officialManifest: 'https://raw.githubusercontent.com/zonde306/ST-Prompt-Template/main/manifest.json',
  adapterVersion: 'agent-rp-prompt-template-v1',
  execution: 'isolated-quickjs' as const,
  parallelizable: true,
  capabilities: Object.freeze([
    'EJS prompt rendering',
    '[GENERATE:*] and [RENDER:*] directives',
    '@INJECT positional/target/regex placement',
    '[InitialVariables] declaration',
  ]),
})

/** Local deterministic extension lane; it never creates an LLM call. */
export function resolvePromptTemplateExtension(
  candidates: readonly WorldbookPluginCandidate[],
  ctx: AgentContext,
): WorldbookPluginOutput {
  return buildWorldbookPluginOutput(candidates, ctx)
}

export function applyPromptTemplateInjections(
  messages: readonly ChatMessage[],
  output: WorldbookPluginOutput,
): ChatMessage[] {
  return applyWorldbookPromptInjections(messages, output.promptInjections)
}
