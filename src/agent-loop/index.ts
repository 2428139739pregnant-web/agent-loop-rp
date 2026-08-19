/** Public surface of the agent-loop module. Re-exports types and implementations. */

export type { LLMProvider, ChatMessage, ChatOptions, LLMResult, SwipeInfo } from './provider.ts'

export { DeepSeekProvider } from './providers/deepseek.ts'
export { MockProvider } from './providers/mock.ts'

export type { AgentContext, Agent, PromptLoader, PostprocessRuntimeSettings, WorldbookSettings, WorldbookMatchMode } from './agents/types.ts'
export { FilePromptLoader, InMemoryPromptLoader, parseJson, DEFAULT_WORLDBOOK_SETTINGS, resolveWorldbookMatchMode } from './agents/types.ts'

export type { SessionStore } from './session.ts'
export { MemorySessionStore } from './session.ts'
export type { WorldbookStore, WorldbookEntry } from './session.ts'
export { MemoryWorldbookStore } from './session.ts'
export { classifyWorldbookEntry, type WorldbookEntryClassification, type WorldbookEntryOwner, type WorldbookPluginKind } from './worldbook-compat.ts'
export { resolveWorldbookMatches, type WorldbookActivationSource, type WorldbookResolverInput } from './worldbook-resolver.ts'
export {
  applyWorldbookPromptInjections,
  applyWorldbookRenderDirectives,
  buildWorldbookPluginOutput,
  type WorldbookPluginCandidate,
} from './worldbook-plugin.ts'

export type {
  IntentOutput,
  WorldbookMatch,
  WorldbookMatchOutput,
  ContextSegment,
  ContextSegmentOutput,
  ReplyResult,
  WorldbookPluginOutput,
  WorldbookPromptInjection,
  WorldbookPromptPlacement,
  WorldbookPromptRole,
  WorldbookRenderDirective,
  SpanEdit,
  SpanEditOutput,
} from './schema.ts'
export {
  IntentOutputSchema,
  WorldbookMatchOutputSchema,
  ContextSegmentOutputSchema,
  ReplyResultSchema,
  SpanEditOutputSchema,
} from './schema.ts'

export type { AgentLoopConfig } from './config.ts'
export { readConfig } from './config.ts'

export type { PreprocessedCharacter, CharacterLorebookSplit } from './character-loader.ts'
export {
  loadCharacterCardFromPng,
  loadCharacterCardFromJson,
  loadCharacterCardFromJsonBytes,
  preprocessCharacterCard,
  classifyLorebookEntries,
  classifyLorebookEntry,
  entryStPosition,
} from './character-loader.ts'

export type { WorldbookIndexEntry } from './worldbook-loader.ts'
export { loadWorldbookFromDir, parseWorldbookIndex } from './worldbook-loader.ts'

export type { ToolDefinition } from './tools.ts'
export { ToolRegistry } from './tools.ts'

export { runLoop } from './loop.ts'
export type { RunLoopDeps, RunLoopAgents, ResponseInput, ContextProcessInput } from './loop.ts'

// Agent implementations — exported for the demo and for callers that want
// to wire up the chain manually instead of constructing their own.
export { intentAgent } from './agents/intent.ts'
export {
  worldbookMatchAgent,
  buildWorldbookMatchInput,
  deterministicWorldbookMatch,
  recursiveWorldbookMatch,
  rollProbability,
  formatCandidates,
  formatRecentMessages,
  formatStBaseline,
  type WorldbookMatchInput,
  type WorldbookMatchCandidate,
  type WorldbookScanMessage,
} from './agents/worldbook-match.ts'
export {
  buildWorldbookKeyIndex,
  renderWorldbookKeyOnlyMd,
  type WorldbookKeyIndexEntry,
  type WorldbookKeyIndexMacros,
} from './worldbook-key-index.ts'
export {
  canEvaluateTimedEffect,
  filterTimedEffectCandidates,
  isTimedEffectCoolingDown,
  isTimedEffectStickyActive,
  normalizeTimedEffectState,
  pruneTimedEffectState,
  recordTimedEffectActivations,
  type TimedEffectCandidate,
  type TimedEffectRecord,
  type TimedEffectState,
} from './worldbook-timed-effects.ts'
export { contextProcessAgent, type ContextReader, type ConversationSegment, type SummarySegment } from './agents/context-process.ts'
export {
  responseAgent,
  renderTemplate,
  buildContextBlock,
  buildWorldbookBlock,
  splitWorldbookMatches,
  type WorldbookMatchPlacementBuckets,
  buildConstantWorldbookBlocks,
  listConstantWorldbookEntries,
  constantWorldbookDoc,
} from './agents/response.ts'
export { runMvuUpdate, type MvuRuntimeSettings, type MvuUpdateInput, type MvuUpdateResult } from './agents/mvu-update.ts'
export {
  DEFAULT_RESPONSE_PERSPECTIVES,
  DEFAULT_RESPONSE_SETTINGS,
  RESPONSE_LENGTH_RANGES,
  buildResponseSettingsInstruction,
  normalizeResponseSettings,
  responseMaxTokens,
  type ResponseGenerationSettings,
  type ResponseLengthPreset,
  type ResponsePerspective,
  type ResponsePerspectiveOption,
} from './response-settings.ts'
export {
  postprocessAgent,
  POSTPROCESS_DENSITY_MAX,
  POSTPROCESS_MAX_ROUNDS,
  runPostprocessPipeline,
  parseJsonLoose,
  applyEdits,
  gate,
  density,
  programmaticChecks,
  ImageryStore,
  // 原子 LLM 调用(无事件),供 ui-server 编排独立 stage 用
  runPostprocessPassA,
  runPostprocessPassB,
  runPostprocessPassC,
  runPostprocessExtract,
  type EditStats,
  type HardFix,
  type PostprocessPipelineOptions,
  type PostprocessImageryStore,
  type PostprocessRoundResult,
  type PostprocessStageName,
  type PostprocessStageRunner,
} from './agents/postprocess.ts'
export { summarizeAgent, triggerSummarize } from './agents/summarize.ts'
