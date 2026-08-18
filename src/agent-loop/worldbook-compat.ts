/**
 * Worldbook compatibility classification.
 *
 * This module deliberately contains no provider access and no prompt code.
 * It answers one question only: which subsystem owns the activation decision
 * for an entry in the current turn?
 */

import type { WorldbookEntry } from './session.ts'

export type WorldbookEntryOwner = 'st' | 'agent' | 'plugin' | 'disabled'

export type WorldbookPluginKind =
  | 'ejs'
  | 'inject'
  | 'generate'
  | 'render'
  | 'decorator'
  | 'initial-variables'

export interface WorldbookEntryClassification {
  readonly owner: WorldbookEntryOwner
  readonly pluginKinds: readonly WorldbookPluginKind[]
  readonly reasons: readonly string[]
  readonly agentEligible: boolean
}

/** Detect executable/template syntax used by ST-Prompt-Template. */
function hasEjs(content: string): boolean {
  return /<%[=_-]?[\s\S]*?%>/u.test(content)
}

/** The extension places these directives in the entry title/memo. */
function directiveText(entry: WorldbookEntry): string {
  return `${entry.comment ?? ''}\n${entry.path}`
}

function pushUnique(list: WorldbookPluginKind[], value: WorldbookPluginKind): void {
  if (!list.includes(value)) list.push(value)
}

/**
 * Classify an entry conservatively.
 *
 * Native ST regex keys remain in the deterministic ST lane. Special template
 * directives and EJS remain in the plugin lane so an LLM cannot reinterpret
 * them as ordinary lore. Ordinary keyed entries are eligible for the agent
 * lane; the effective worldbook mode decides whether ST also supplies a base.
 */
export function classifyWorldbookEntry(entry: WorldbookEntry): WorldbookEntryClassification {
  const kinds: WorldbookPluginKind[] = []
  const reasons: string[] = []
  const directives = directiveText(entry)

  if (hasEjs(entry.content)) {
    pushUnique(kinds, 'ejs')
    reasons.push('content contains EJS template syntax')
  }
  if (/^\s*@INJECT\b/imu.test(directives)) {
    pushUnique(kinds, 'inject')
    reasons.push('entry title uses @INJECT')
  }
  if (/\[GENERATE(?::[^\]]*)?\]/iu.test(directives)) {
    pushUnique(kinds, 'generate')
    reasons.push('entry title uses [GENERATE:*]')
  }
  if (/\[RENDER(?::[^\]]*)?\]/iu.test(directives)) {
    pushUnique(kinds, 'render')
    reasons.push('entry title uses [RENDER:*]')
  }
  if (/^\s*\[INITIALVARIABLES\]/imu.test(directives)) {
    pushUnique(kinds, 'initial-variables')
    reasons.push('entry title uses [InitialVariables]')
  }
  if (entry.hasDecorators === true) {
    pushUnique(kinds, 'decorator')
    reasons.push('entry contains an ST decorator')
  }

  // EJS changes how content is rendered, not who decides whether an ordinary
  // keyed entry activates. Keep EJS-only entries in the normal ST/agent lane;
  // response/prompt rendering will evaluate the template after activation.
  const hasControlDirective = kinds.some(kind => kind !== 'ejs')
  // ST-Prompt-Template can deliberately mark special entries disabled and
  // still execute them from its extension lane. Ordinary disabled entries
  // remain disabled; only explicit control syntax gets this exception.
  if (entry.enabled === false && !hasControlDirective) {
    return { owner: 'disabled', pluginKinds: kinds, reasons: [...reasons, 'disabled'], agentEligible: false }
  }
  if (hasControlDirective) {
    return {
      owner: 'plugin',
      pluginKinds: kinds,
      reasons: entry.enabled === false ? [...reasons, 'disabled special entry handled by plugin lane'] : reasons,
      agentEligible: false,
    }
  }
  if (entry.constant === true) {
    return { owner: 'st', pluginKinds: kinds, reasons: [...reasons, 'constant entry'], agentEligible: false }
  }
  if (entry.useRegex === true) {
    return { owner: 'st', pluginKinds: kinds, reasons: [...reasons, 'native ST regex key'], agentEligible: false }
  }
  return { owner: 'agent', pluginKinds: kinds, reasons: [...reasons, 'ordinary keyed entry'], agentEligible: true }
}
