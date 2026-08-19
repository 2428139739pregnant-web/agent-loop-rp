/** Schemastery schemas for agent-loop data contracts. */

import z from '@deepseek-ai/schemastery'

/** Structured intent extracted from one user turn. */
export interface IntentOutput {
  userNarration: string
  metaCommands: string[]
  involvedCharacters: string[]
  keywords: string[]
}

/** One worldbook entry that matched the user turn's keywords. */
export interface WorldbookMatch {
  path: string
  order: number
  weight: number
  content: string
  /** Where the final activation decision came from. */
  source?: 'st' | 'agent' | 'plugin' | 'st+agent'
  /** ST World Info insertion position retained through activation. */
  position?: number
  /** atDepth position metadata, when supplied by the source book. */
  depth?: number
  /** Tavern Helper prompt role for position-aware entries. */
  role?: WorldbookPromptRole
}

export type WorldbookPromptRole = 'system' | 'user' | 'assistant'

/** A deterministic prompt-message insertion planned by the compatibility lane. */
export type WorldbookPromptPlacement =
  | { kind: 'absolute'; position: number }
  | { kind: 'target'; targetRole: WorldbookPromptRole; targetIndex: number; at: 'before' | 'after' }
  | { kind: 'regex'; pattern: string; at: 'before' | 'after' }
  /** Used by [GENERATE:*] and decorator aliases to modify one existing message. */
  | { kind: 'message'; messageIndex: number; at: 'before' | 'after' }

export interface WorldbookPromptInjection {
  path: string
  content: string
  role: WorldbookPromptRole
  order: number
  placement: WorldbookPromptPlacement
}

/** A display-only directive; it must not be sent back to the model. */
export interface WorldbookRenderDirective {
  path: string
  content: string
  order: number
  placement: 'before' | 'after'
}

export interface WorldbookPluginOutput {
  promptInjections: WorldbookPromptInjection[]
  renderDirectives: WorldbookRenderDirective[]
  /** Entries intentionally retained but not executable by this compatibility slice. */
  skipped: Array<{ path: string; reason: string }>
}

/** A wrapping payload returned by 2.1. */
export interface WorldbookMatchOutput {
  matches: WorldbookMatch[]
  /** Deterministic ST-Prompt-Template compatibility artifacts. */
  plugin?: WorldbookPluginOutput
}

/** How one historical/context segment should be injected into the reply prompt. */
export interface ContextSegment {
  id: number
  mode: 'full' | 'summary' | 'drop'
}

/** A wrapping payload returned by 2.2. */
export interface ContextSegmentOutput {
  segments: ContextSegment[]
}

/** Final reply returned to the user plus light diagnostics. */
export interface ReplyResult {
  reply: string
  /** Display-only rendering of `reply`; storage and reroll keep the raw reply. */
  displayReply?: string
  sessionId: string
  turn: number
  usedWorldbook: boolean
  usedContextSegmentation: boolean
}

export const IntentOutputSchema: z<IntentOutput> = z.object({
  userNarration: z.string().default(''),
  metaCommands: z.array(z.string()).default([]),
  involvedCharacters: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
})

export const WorldbookMatchOutputSchema: z<WorldbookMatchOutput> = z.object({
  matches: z.array(z.object({
    path: z.string(),
    order: z.number().default(0),
    weight: z.number().default(0),
    content: z.string().default(''),
  })).default([]),
})

export const ContextSegmentOutputSchema: z<ContextSegmentOutput> = z.object({
  segments: z.array(z.object({
    id: z.number(),
    mode: z.union(['full', 'summary', 'drop'] as const).default('drop'),
  })).default([]),
})

export const ReplyResultSchema: z<ReplyResult> = z.object({
  reply: z.string().default(''),
  sessionId: z.string().default(''),
  turn: z.number().default(0),
  usedWorldbook: z.boolean().default(false),
  usedContextSegmentation: z.boolean().default(false),
})

/** One span-replacement edit emitted by a postprocess pass. */
export interface SpanEdit {
  anchor: string
  replacement: string
  op: string
  reason?: string
}

/** Wrapping payload returned by every postprocess pass (A/B/C). */
export interface SpanEditOutput {
  edits: SpanEdit[]
}

const SpanEditSchema: z<SpanEdit> = z.object({
  anchor: z.string().default(''),
  replacement: z.string().default(''),
  op: z.string().default('?'),
  reason: z.string().default(''),
})

export const SpanEditOutputSchema: z<SpanEditOutput> = z.object({
  edits: z.array(SpanEditSchema).default([]),
})

