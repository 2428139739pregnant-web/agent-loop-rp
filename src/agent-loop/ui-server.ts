/** Minimal HTTP server that exposes the agent-loop module over JSON + a static UI.
 *
 *  This is a prototype / demo harness: it boots a `MockProvider` (or
 *  `DeepSeekProvider` when `DEEPSEEK_API_KEY` is set), pre-loads the worldbook
 *  fixtures, keeps a single `MemorySessionStore` in-process, and serves a
 *  single-page React UI from `scripts/agent-loop-ui/`.
 *
 *  It is intentionally self-contained — no Cordis, no DSH, no other modules
 *  in this repo are touched at runtime. The only contract with the rest of
 *  the codebase is the public `agent-loop` surface re-exported by
 *  `index.ts`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdir, readFile, writeFile, unlink, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-session'

import {
  FilePromptLoader,
  InMemoryPromptLoader,
  MemorySessionStore,
  MemoryWorldbookStore,
  MockProvider,
  DEFAULT_WORLDBOOK_SETTINGS,
  applyWorldbookRenderDirectives,
  buildWorldbookPluginOutput,
  buildWorldbookMatchInput,
  classifyLorebookEntry,
  contextProcessAgent,
  deterministicWorldbookMatch,
  intentAgent,
  loadCharacterCardFromJson,
  loadCharacterCardFromPng,
  loadWorldbookFromDir,
  POSTPROCESS_DENSITY_MAX,
  postprocessAgent,
  preprocessCharacterCard,
  readConfig,
  responseAgent,
  listConstantWorldbookEntries,
  runMvuUpdate,
  runLoop,
  runPostprocessPipeline as runPostprocessPipelineCore,
  triggerSummarize,
  worldbookMatchAgent,
  type ChatMessage,
  type SwipeInfo,
  type ChatOptions,
  type ContextReader,
  type LLMProvider,
  type LLMResult,
  type MvuRuntimeSettings,
  type PreprocessedCharacter,
  type PostprocessRuntimeSettings,
  type ReplyResult,
  type WorldbookEntry,
  type WorldbookMatchMode,
  type WorldbookSettings,
  type WorldbookGlobalScanData,
  type WorldbookStore,
} from './index.ts'

import type { ImportedLorebook, ImportedLorebookEntry } from '../import/types.ts'
import {
  createEjsWorldInfoBooks,
  EjsTemplateEngine,
  type EjsTemplateResult,
  type EjsTemplateTarget,
} from '../ejs-template.ts'
import {
  extractMvuStatData,
  normalizeMvuJsonValue,
  readInitialMvuState,
  readMvuStateFromMessages,
  readMvuStateWithSessionOverride,
  type MvuMacroContext,
} from '../mvu.ts'
import { generateTavernRaw, parseTavernGenerateRawRequest } from './tavern-generation.ts'
import { PersonaStore, substituteUserCharMacros } from './persona-store.ts'
import { RegexScriptStore, applyRegexScripts, type RegexPlacement } from './regex-scripts.ts'
import {
  applyTavernHelperMutation,
  decodeTavernHelperState,
  encodeTavernHelperState,
  initializeTavernHelperState,
  parseTavernHelperMutationRequest,
  consumeTavernInjectedPromptsAfterGeneration,
  selectTavernInjectedPrompts,
  type TavernHelperVariableMutationRequest,
  type TavernHelperMutationRequest,
  type TavernHelperState,
  type TavernChatMessageInput,
  type TavernWorldbookEntry,
} from '../tavern-helper.ts'
import { buildWorldbookKeyIndex, renderWorldbookKeyOnlyMd } from './worldbook-key-index.ts'
import { tavernHelperWorldbookMetadata } from './worldbook-position.ts'
import {
  normalizeTimedEffectState,
  pruneTimedEffectState,
  recordTimedEffectActivations,
  type TimedEffectState,
} from './worldbook-timed-effects.ts'
import {
  DEFAULT_RESPONSE_SETTINGS,
  normalizeResponseSettings,
  type ResponseGenerationSettings,
} from './response-settings.ts'
import { ExtensionRegistry } from '../extensions/registry.ts'
import type { ExtensionId } from '../extensions/types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI-compatible provider + runtime API config
// ─────────────────────────────────────────────────────────────────────────────

/** OpenAI-compatible provider: works with OpenAI / DeepSeek / Azure / Moonshot / etc.
 *
 *  Functionally similar to `DeepSeekProvider`, but kept separate for two reasons:
 *  1. `DeepSeekProvider` carries a single hardcoded `name = 'deepseek'` and reads
 *     its baseUrl/model out of the env-driven `AgentLoopConfig`. The UI server
 *     needs to spin up a provider from arbitrary user-supplied `baseUrl`/`apiKey`
 *     at runtime, without a `AgentLoopConfig` envelope.
 *  2. The wire format here is the generic OpenAI `/v1/chat/completions` shape
 *     with no provider-specific header (DeepSeek historically added `api-key`
 *     instead of `Authorization: Bearer` for its own gateway; we standardize on
 *     the OpenAI form, which DeepSeek's v1 endpoint also accepts).
 */
class OpenAICompatibleProvider implements LLMProvider {
  readonly name = 'openai-compatible'
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string, // e.g. 'https://api.openai.com/v1'
  ) {}
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResult> {
    const url = `${this.baseUrl.replace(/\/+$/u, '')}/chat/completions`
    const body: Record<string, unknown> = {
      model: options?.model ?? 'gpt-4o-mini',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
      ...(options?.response_format !== undefined ? { response_format: options.response_format } : {}),
    }
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '<unreadable>')
      throw new Error(`openai-compatible chat ${resp.status}: ${text}`)
    }
    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const content = data.choices?.[0]?.message?.content ?? ''
    const usage = data.usage
    if (usage?.prompt_tokens !== undefined && usage.completion_tokens !== undefined) {
      return { content, usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens } }
    }
    return { content }
  }
}

// ─── /api/run — SSE stage protocol ───────────────────────────────────────────

/** 顶层 5 阶段 + 后处理 5 个独立子 stage + summarize + final。
 *  ⑤ postprocess 不再作为一个外层 stage,正文链路由 5 个独立 stage
 *  (gate / pass-a / pass-b / pass-c)各跑各的 trace；extract
 *  作为后台任务执行，不阻塞最终回复。
 *  这样前端能像 5 阶段一样独立追踪每个修订调用,不用等全跑完才能看。 */
type StageName =
  | 'intent' | 'worldbook' | 'context' | 'response' | 'mvu'
  | 'postprocess-gate' | 'postprocess-pass-a' | 'postprocess-pass-b'
  | 'postprocess-pass-c' | 'postprocess-extract'
  | 'summarize' | 'final' | 'error'
type StageStatus = 'start' | 'done' | 'error'

/** Single SSE event payload sent on the `stage` (or `error`) channel. */
type StageEvent =
  | { name: Exclude<StageName, 'final' | 'error'>; status: StageStatus; result?: Record<string, unknown> }
  | { name: 'final'; status: 'done'; result: ReplyResult }
  | { name: 'error'; status: 'error'; message: string }

/** Per-stage token accounting exposed in traces and turn summaries. */
interface TokenUsageStats {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  calls: number
  /** True when the provider did not return usage (or mock mode used a heuristic). */
  estimated: boolean
}

interface AgentTokenStats extends TokenUsageStats {
  reused?: boolean
  deferred?: boolean
  reusedFromRunId?: string
}

/** One exact provider request captured for trace inspection. */
interface PromptTraceCall {
  messages: ChatMessage[]
  options?: ChatOptions
}

interface ReusableTurnArtifacts {
  intent: import('./schema.ts').IntentOutput
  worldbook: import('./schema.ts').WorldbookMatchOutput
  /** Context segmentation is deterministic for the same user turn/history. */
  context?: import('./schema.ts').ContextSegmentOutput
}

interface TurnStatsRecord {
  runId: string
  turn: number
  reroll: boolean
  ts: string
  userInput: string
  assistantLength: number
  total: TokenUsageStats
  agents: Record<string, AgentTokenStats>
  reusable?: ReusableTurnArtifacts
  reusedFromRunId?: string
}

const EMPTY_TOKEN_USAGE: TokenUsageStats = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  calls: 0,
  estimated: false,
}

function cloneTokenUsage(value: TokenUsageStats): TokenUsageStats {
  return { ...value }
}

function estimateTokens(text: string): number {
  if (text.length === 0) return 0
  // Cheap fallback only. Real OpenAI-compatible responses normally provide
  // prompt_tokens/completion_tokens; use a conservative chars/4 estimate when
  // they do not (and in MockProvider mode, whose usage is intentionally fake).
  return Math.max(1, Math.ceil([...text].length / 4))
}

function addTokenUsage(target: TokenUsageStats, usage: { promptTokens: number; completionTokens: number; estimated: boolean }): void {
  target.promptTokens += usage.promptTokens
  target.completionTokens += usage.completionTokens
  target.totalTokens = target.promptTokens + target.completionTokens
  target.calls += 1
  target.estimated = target.estimated || usage.estimated
}

function subtractTokenUsage(after: TokenUsageStats, before: TokenUsageStats): TokenUsageStats {
  return {
    promptTokens: Math.max(0, after.promptTokens - before.promptTokens),
    completionTokens: Math.max(0, after.completionTokens - before.completionTokens),
    totalTokens: Math.max(0, after.totalTokens - before.totalTokens),
    calls: Math.max(0, after.calls - before.calls),
    estimated: after.estimated,
  }
}

/** Provider decorator that attributes every LLM call to the active stage. */
class UsageTrackingProvider implements LLMProvider {
  readonly name: string
  private activeStage: string | null = null
  private readonly byStage = new Map<string, TokenUsageStats>()
  private readonly promptsByStage = new Map<string, PromptTraceCall[]>()

  constructor(private readonly inner: LLMProvider) {
    this.name = inner.name
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResult> {
    const stage = this.activeStage
    if (stage !== null) {
      const calls = this.promptsByStage.get(stage) ?? []
      calls.push({
        messages: messages.map(message => ({ ...message })),
        ...(options === undefined ? {} : { options: { ...options } }),
      })
      this.promptsByStage.set(stage, calls)
    }
    const result = await this.inner.chat(messages, options)
    if (stage === null) return result
    const reported = this.inner.name !== 'mock'
      && result.usage !== undefined
      && Number.isFinite(result.usage.prompt_tokens)
      && Number.isFinite(result.usage.completion_tokens)
    const usage = reported
      ? {
          promptTokens: Math.max(0, result.usage?.prompt_tokens ?? 0),
          completionTokens: Math.max(0, result.usage?.completion_tokens ?? 0),
          estimated: false,
        }
      : {
          promptTokens: estimateTokens(messages.map(m => m.content).join('\n')),
          completionTokens: estimateTokens(result.content),
          estimated: true,
        }
    const bucket = this.byStage.get(stage) ?? cloneTokenUsage(EMPTY_TOKEN_USAGE)
    addTokenUsage(bucket, usage)
    this.byStage.set(stage, bucket)
    return result
  }

  async inStage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.activeStage
    this.activeStage = name
    try {
      return await fn()
    } finally {
      this.activeStage = previous
    }
  }

  snapshot(name: string): TokenUsageStats {
    return cloneTokenUsage(this.byStage.get(name) ?? EMPTY_TOKEN_USAGE)
  }

  snapshotAll(): Record<string, TokenUsageStats> {
    return Object.fromEntries([...this.byStage.entries()].map(([name, usage]) => [name, cloneTokenUsage(usage)]))
  }

  /** Return the exact request message arrays sent during one stage. */
  promptTrace(name: string): readonly PromptTraceCall[] {
    return (this.promptsByStage.get(name) ?? []).map(call => ({
      messages: call.messages.map(message => ({ ...message })),
      ...(call.options === undefined ? {} : { options: { ...call.options } }),
    }))
  }
}

const DEFAULT_TEMPERATURE = 0.7

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Mirrors `loop.ts` buildContext — local copy so we don't need to export it.
 *  macros( {{user}}/{{char}} 宏源)与 worldbookSettings(绿灯扫描深度)为
 *  2.1/3 的 ST 语义适配新增,可选参数。 */
function buildAgentContext(deps: {
  provider: LLMProvider
  model: string
  prompts: FilePromptLoader
  session: MemorySessionStore
  worldbook: WorldbookStore
  sessionId: string
  /** {{user}}/{{char}} 宏替换源(未配置 persona / 无角色时对应侧 null)。 */
  macros?: { user: string | null; char: string | null }
  /** 世界书全局设置(扫描深度等);缺省 ST 默认 scanDepth=2。 */
  worldbookSettings?: WorldbookSettings
  /** 当前 response preset 的上下文窗口,供 World Info budget 计算。 */
  responseSettings?: ResponseGenerationSettings
  /** Session-local sticky/cooldown/delay snapshot. */
  worldbookTimedEffects?: TimedEffectState
  /** ST World Info chat-independent scan fields. */
  worldbookGlobalScanData?: WorldbookGlobalScanData
  /** Session-owned Tavern Helper prompts and scan-text injections. */
  tavernHelperState?: TavernHelperState
  /** ⑤ postprocess preset 当前值。 */
  postprocessSettings?: PostprocessRuntimeSettings
  /** 进度回调:多步骤 agent 在每个子步骤时调用。 */
  onProgress?: import('./agents/types.ts').AgentProgressCallback
  /** Isolated EJS renderer bound to the active card/session. */
  renderTemplate?: (template: string, target?: EjsTemplateTarget) => EjsTemplateResult
  /** Current MVU stat_data for this card/session. */
  statData?: import('@deepseek-ai/dsh-session').JsonValue
}): import('./agents/types.ts').AgentContext {
  return {
    provider: deps.provider,
    model: deps.model,
    temperature: DEFAULT_TEMPERATURE,
    prompts: deps.prompts,
    session: deps.session,
    worldbook: deps.worldbook,
    sessionId: deps.sessionId,
    // exactOptionalPropertyTypes: 可选字段用条件展开,不显式赋 undefined。
    ...(deps.macros !== undefined ? { macros: deps.macros } : {}),
    ...(deps.worldbookSettings !== undefined ? { worldbookSettings: deps.worldbookSettings } : {}),
    ...(deps.responseSettings !== undefined ? { responseSettings: deps.responseSettings } : {}),
    ...(deps.worldbookTimedEffects === undefined ? {} : { worldbookTimedEffects: deps.worldbookTimedEffects }),
    ...(deps.worldbookGlobalScanData === undefined ? {} : { worldbookGlobalScanData: deps.worldbookGlobalScanData }),
    ...(deps.tavernHelperState === undefined ? {} : { tavernHelperState: deps.tavernHelperState }),
    ...(deps.postprocessSettings !== undefined ? { postprocessSettings: deps.postprocessSettings } : {}),
    ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
    ...(deps.renderTemplate !== undefined ? { renderTemplate: deps.renderTemplate } : {}),
    ...(deps.statData === undefined ? {} : { statData: deps.statData }),
  }
}

/**
 * Build display-only [RENDER] artifacts without running intent/worldbook
 * agents. History reads and the live SSE result must render the same view,
 * while SessionStore keeps the canonical raw assistant text for rerolls.
 */
function displayRenderDirectives(
  state: AppState,
  sessionId: string,
  character: PreprocessedCharacter,
): import('./schema.ts').WorldbookRenderDirective[] {
  const helperState = state.sessionRecords.get(sessionId)?.tavernHelperState
  const templateRenderer = buildCharacterTemplateRenderer(
    state,
    character,
    state.sessions,
    sessionId,
    getCurrentUserPersona(state)?.name ?? '用户',
  )
  const config = getGlobalConfig(state)
  const ctx = buildAgentContext({
    provider: resolveProvider(config),
    model: config.model,
    prompts: new FilePromptLoader(),
    session: state.sessions,
    worldbook: state.worldbook,
    sessionId,
    macros: { user: getCurrentUserPersona(state)?.name ?? null, char: character.name },
    worldbookSettings: state.worldbookSettings,
    responseSettings: state.responseSettings,
    ...(helperState === undefined ? {} : { tavernHelperState: helperState }),
    ...(templateRenderer === undefined ? {} : { renderTemplate: templateRenderer }),
  })
  const input = buildWorldbookMatchInput({
    userNarration: '',
    metaCommands: [],
    involvedCharacters: [],
    keywords: [],
  }, ctx)
  return input.pluginCandidates === undefined
    ? []
    : buildWorldbookPluginOutput(input.pluginCandidates, ctx).renderDirectives
}

function displayHistory(
  state: AppState,
  sessionId: string,
  history: readonly ChatMessage[],
): Array<ChatMessage> {
  const record = state.sessionRecords.get(sessionId)
  if (record === undefined) return history.map(message => ({ ...message }))
  const directives = displayRenderDirectives(state, sessionId, record.character)
  return history.map(message => ({
    ...message,
    role: message.role,
    content: message.role === 'assistant'
      ? applyWorldbookRenderDirectives(message.content, directives)
      : message.content,
  }))
}

/** Convert a public Tavern Helper message/patch into the durable session
 * shape without dropping card/plugin metadata. The optional base message is
 * important: official setChatMessages is a partial patch, not a replacement
 * of the whole chat or floor. */
function tavernChatMessageToInternal(message: TavernChatMessageInput, base?: ChatMessage): ChatMessage {
  return {
    ...(base === undefined ? {} : { ...base }),
    ...(message.message_id === undefined ? {} : { message_id: message.message_id }),
    role: message.role ?? base?.role ?? 'assistant',
    content: message.message ?? base?.content ?? '',
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.is_hidden === undefined ? {} : { is_hidden: message.is_hidden }),
    ...(message.data === undefined ? {} : { data: { ...message.data } }),
    ...(message.extra === undefined ? {} : { extra: { ...message.extra } }),
    ...(message.swipe_id === undefined ? {} : { swipe_id: message.swipe_id }),
    ...(message.swipes === undefined ? {} : { swipes: [...message.swipes] }),
    ...(message.swipes_info === undefined ? {} : { swipes_info: message.swipes_info.map(item => ({ ...item })) }),
    ...(message.swipes_data === undefined ? {} : { swipes_data: message.swipes_data.map(item => ({ ...item })) }),
    ...(message.swipes_info === undefined ? {} : { swipe_info: message.swipes_info as unknown as SwipeInfo[] }),
  }
}

function tavernMessageId(message: ChatMessage, index: number): number {
  return Number.isSafeInteger(message.message_id) ? message.message_id as number : index
}

function resolveTavernMessageId(history: readonly ChatMessage[], rawId: number): number {
  if (rawId >= 0) return rawId
  const ids = history.map((message, index) => tavernMessageId(message, index))
  return ids.at(rawId) ?? rawId
}

function chatIndicesForIds(history: readonly ChatMessage[], messageIds: readonly number[]): Set<number> {
  const wanted = new Set(messageIds.map(messageId => resolveTavernMessageId(history, messageId)))
  return new Set(history.flatMap((message, index) => wanted.has(tavernMessageId(message, index)) ? [index] : []))
}

function resolveTavernInsertIndex(history: readonly ChatMessage[], rawId: number | 'end'): number {
  if (rawId === 'end') return history.length
  const index = history.findIndex((message, messageIndex) => tavernMessageId(message, messageIndex) === rawId)
  if (index >= 0) return index
  // In a normal ST chat the next floor id is also the append position.
  if (rawId === history.length) return history.length
  throw new Error('create-chat-messages insertAt does not identify a chat floor')
}

function rotateChatHistory(history: readonly ChatMessage[], begin: number, middle: number, end: number): ChatMessage[] {
  if (begin < 0 || middle < begin || end < middle || end > history.length) {
    throw new Error('rotate-chat-messages range is invalid')
  }
  return [
    ...history.slice(0, begin),
    ...history.slice(middle, end),
    ...history.slice(begin, middle),
    ...history.slice(end),
  ]
}

function swipeInfoNow(): SwipeInfo {
  const now = Date.now()
  return { send_date: now, gen_started: now, gen_finished: now, extra: {} }
}

/** Keep one canonical assistant message while preserving every ST swipe. */
function makeAssistantMessage(content: string, previous?: ChatMessage): ChatMessage {
  const oldSwipes = previous?.role === 'assistant' && Array.isArray(previous.swipes) && previous.swipes.length > 0
    ? [...previous.swipes]
    : previous?.role === 'assistant' ? [previous.content] : []
  const oldInfo = previous?.role === 'assistant' && Array.isArray(previous.swipe_info)
    ? previous.swipe_info.map(info => ({ ...info, extra: info.extra === undefined ? {} : { ...info.extra } }))
    : oldSwipes.map(() => swipeInfoNow())
  const swipeId = oldSwipes.length
  const swipes = [...oldSwipes, content]
  const swipeInfo = [...oldInfo, swipeInfoNow()]
  return { role: 'assistant', content, swipe_id: swipeId, swipes, swipe_info: swipeInfo }
}

function syncAssistantSwipe(message: ChatMessage, content: string): ChatMessage {
  if (message.role !== 'assistant') return { ...message, content }
  const swipes = Array.isArray(message.swipes) && message.swipes.length > 0
    ? [...message.swipes]
    : [message.content]
  const swipeId = Number.isInteger(message.swipe_id) && (message.swipe_id as number) >= 0
    && (message.swipe_id as number) < swipes.length ? message.swipe_id as number : 0
  swipes[swipeId] = content
  const swipeInfo = Array.isArray(message.swipe_info) ? [...message.swipe_info] : swipes.map(() => swipeInfoNow())
  while (swipeInfo.length < swipes.length) swipeInfo.push(swipeInfoNow())
  return { ...message, content, swipe_id: swipeId, swipes, swipe_info: swipeInfo }
}

/** Bind one bounded EJS context to the active character/session. */
function buildCharacterTemplateRenderer(
  state: AppState,
  character: PreprocessedCharacter,
  session: MemorySessionStore,
  sessionId: string,
  userName: string,
): ReturnType<EjsTemplateEngine['createRenderer']> | undefined {
  if (state.ejsEngine === undefined) return undefined
  const history = session.getHistory(sessionId)
  const record = state.sessionRecords.get(sessionId)
  const mvu = record === undefined
    ? readMvuStateFromMessages(character.raw, history, {
      user: userName,
      char: character.name,
    })
    : readSessionMvuState(record, history, {
      user: userName,
      char: character.name,
    })
  const helperVariables = character.raw.frontend?.tavernHelperVariables ?? {}
  const helperState = record?.tavernHelperState
  const chatVariables = helperState?.scopes.chat ?? {}
  const characterVariables = helperState?.scopes.character ?? helperVariables
  const mergedVariables = {
    ...helperVariables,
    ...characterVariables,
    ...chatVariables,
  }
  const initialState = readInitialMvuState(character.raw, {
    user: userName,
    char: character.name,
  })
  const initialVariables = initialState !== undefined
    && typeof initialState === 'object'
    && initialState !== null
    && !Array.isArray(initialState)
    ? initialState as Readonly<Record<string, JsonValue>>
    : {}
  // ST-Prompt-Template's getwi()/getWorldInfo() reads the currently visible
  // World Info collection. Keep this as a read-only projection of the same
  // card/imported/helper sources that getMergedWorldbook() feeds to agents;
  // otherwise EJS can render successfully while every worldbook lookup is
  // silently empty.
  const worldInfoSources: Array<{
    readonly id: string
    readonly name?: string
    readonly lorebook: {
      readonly entries: readonly {
        readonly sourceId: string
        readonly name?: string
        readonly comment?: string
        readonly content: string
      }[]
    }
  }> = []
  const activeCharacterId = record?.characterId ?? safeFileName(character.name)
  const disabledImportedBooks = state.characterWorldbookConfigs.get(activeCharacterId)?.disabledBookIds ?? null
  const cardBook = character.raw.lorebook
  if (cardBook !== undefined) {
    worldInfoSources.push({
      id: `character:${safeFileName(character.name)}`,
      name: cardBook.name ?? character.name,
      lorebook: cardBook,
    })
  }
  const fixtureEntries = state.fixtureWorldbook.list()
  if (fixtureEntries.length > 0) {
    worldInfoSources.push({
      id: 'fixture',
      name: 'fixture',
      lorebook: {
        entries: fixtureEntries.map(entry => ({
          sourceId: entry.path,
          ...(entry.comment === undefined ? {} : { name: entry.comment }),
          content: entry.content,
        })),
      },
    })
  }
  for (const [bookId, book] of state.importedWorldbooks) {
    // Keep the EJS view identical to getMergedWorldbook(): a disabled external
    // book must not become visible through getwi() just because it exists in
    // the global catalogue.
    if (disabledImportedBooks !== null && disabledImportedBooks.has(bookId)) continue
    worldInfoSources.push({ id: `worldbook:${bookId}`, name: book.name ?? bookId, lorebook: book })
  }
  const activeHelperBooks = new Set(helperState === undefined ? [] : tavernHelperActiveWorldbookNames(helperState))
  const deletedHelperBooks = new Set(helperState?.deletedWorldbookNames ?? [])
  for (const [bookName, entries] of Object.entries(helperState?.worldbooks ?? {})) {
    if (deletedHelperBooks.has(bookName) || !activeHelperBooks.has(bookName)) continue
    worldInfoSources.push({
      id: `tavern-helper:${bookName}`,
      name: bookName,
      lorebook: {
        entries: entries.map(entry => ({
          sourceId: String(entry.uid),
          name: entry.name,
          content: entry.content,
        })),
      },
    })
  }
  return state.ejsEngine.createRenderer({
    characterName: character.name,
    userName,
    // ST-Prompt-Template's getCharData()/getchar() read the raw character
    // object, not the three prose projections used by the response agent.
    // Keep the exact imported JSON snapshot in the isolated renderer so card
    // templates can access extensions, character_book, and frontend fields
    // without reopening files or reaching the host process.
    characterData: character.raw.raw,
    characterCards: [{
      id: activeCharacterId,
      name: character.name,
      data: character.raw.raw,
    }],
    messages: history.map(message => message.content),
    transcript: history
      .filter((message): message is ChatMessage & { role: 'system' | 'user' | 'assistant' } =>
        message.role === 'system' || message.role === 'user' || message.role === 'assistant')
      .map(message => ({ role: message.role, content: message.content })),
    variables: mergedVariables,
    variableScopes: {
      global: helperState?.scopes.global ?? {},
      preset: helperState?.scopes.preset ?? {},
      character: characterVariables,
      initial: initialVariables,
      chat: chatVariables,
      message: helperState?.scopes.message ?? {},
    },
    worldInfoBooks: createEjsWorldInfoBooks(worldInfoSources),
    ...(mvu === undefined ? {} : { statData: mvu.statData }),
  })
}

/** Return the active helper state, lazily upgrading sessions created before
 * session-variable persistence was introduced. */
function ensureSessionTavernHelperState(record: SessionRecord): TavernHelperState {
  return record.tavernHelperState
    ?? initializeTavernHelperState(record.character.raw.frontend, record.characterId)
}

/** Read direct session variables first; only sessions without a snapshot
 * replay MVU tags from the transcript. */
function readSessionMvuState(
  record: SessionRecord,
  history: readonly ChatMessage[],
  macros?: MvuMacroContext,
): ReturnType<typeof readMvuStateFromMessages> {
  const helperState = record.tavernHelperState
  const helperStatData = helperState?.scopes.chat.stat_data
  const persisted = record.mvuState !== undefined ? record.mvuState : helperStatData
  return readMvuStateWithSessionOverride(record.character.raw, history, persisted, macros)
}

/** Reconcile one record with its current character while retaining session
 * namespaces, matching Tavern Helper's character switch behavior. */
function withSessionCharacter(record: SessionRecord, character: PreprocessedCharacter): SessionRecord {
  const nextHelperState = initializeTavernHelperState(
    character.raw.frontend,
    record.characterId,
    record.tavernHelperState,
  )
  return { ...record, character, tavernHelperState: nextHelperState }
}

/** Mirrors `loop.ts` buildContextReader — turns session history into the
 *  ConversationSegment list 2.2 expects. */
function buildContextReader(session: MemorySessionStore, sessionId: string): ContextReader {
  return {
    listConversations: () => {
      const history = session.getHistory(sessionId)
      let turn = 0
      const out: Array<{ id: number; content: string }> = []
      for (const m of history) {
        if (m.role !== 'assistant') continue
        turn += 1
        out.push({ id: turn, content: m.content })
      }
      return out
    },
    readConversation: (id) => {
      const history = session.getHistory(sessionId)
      let turn = 0
      for (const m of history) {
        if (m.role !== 'assistant') continue
        turn += 1
        if (turn === id) return { id, content: m.content }
      }
      return undefined
    },
    listSummaries: () => [],
    readSummary: () => undefined,
  }
}

/** Runtime API configuration, configurable from the WebUI. */
type ApiProvider = 'openai' | 'mock'

interface ApiConfig {
  provider: ApiProvider
  baseUrl: string
  apiKey: string
  model: string
}

const CONFIG_KEY_DEFAULT = 'global'
const MASKED_KEY = '***'
const MOCK_MODELS: ReadonlyArray<{ id: string }> = [
  { id: 'mock-model' },
  { id: 'mock-2' },
]

/** Default config used when no env hints are present. */
function defaultMockConfig(): ApiConfig {
  return { provider: 'mock', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'mock-model' }
}

/** Build a provider from a runtime config. */
function resolveProvider(cfg: ApiConfig): LLMProvider {
  return cfg.provider === 'mock'
    ? new MockProvider()
    : new OpenAICompatibleProvider(cfg.apiKey, cfg.baseUrl)
}

/** Read the (single-tenant) global config, falling back to mock defaults. */
function getGlobalConfig(state: AppState): ApiConfig {
  return state.configs.get(CONFIG_KEY_DEFAULT) ?? defaultMockConfig()
}

/** Serialize a config for the wire with the apiKey masked. */
function maskConfig(cfg: ApiConfig): ApiConfig {
  return { ...cfg, apiKey: MASKED_KEY }
}

/** Parse a partial config from a JSON value (used by PUT and request overrides). */
function parseConfigField(value: unknown): Partial<ApiConfig> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const out: Partial<ApiConfig> = {}
  const providerRaw = readStringField(obj, 'provider')
  if (providerRaw !== undefined) {
    if (providerRaw !== 'openai' && providerRaw !== 'mock') return null
    out.provider = providerRaw
  }
  const baseUrl = readStringField(obj, 'baseUrl')
  if (baseUrl !== undefined) out.baseUrl = baseUrl
  const apiKey = readStringField(obj, 'apiKey')
  if (apiKey !== undefined) out.apiKey = apiKey
  const model = readStringField(obj, 'model')
  if (model !== undefined) out.model = model
  return out
}

/** Merge a partial override on top of a base config. */
function mergeConfig(base: ApiConfig, override: Partial<ApiConfig>): ApiConfig {
  return {
    provider: override.provider ?? base.provider,
    baseUrl: override.baseUrl ?? base.baseUrl,
    apiKey: override.apiKey ?? base.apiKey,
    model: override.model ?? base.model,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const TMP_DIR = 'tmp'
const STATIC_DIR = 'scripts/agent-loop-ui'

/** Resolved paths derived from this file's location on disk. */
const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..', '..')
const ABS_TMP_DIR = join(PROJECT_ROOT, TMP_DIR)
const ABS_STATIC_DIR = join(PROJECT_ROOT, STATIC_DIR)
const ABS_WORLDBOOK_DIR = join(PROJECT_ROOT, 'src', 'agent-loop', '_fixtures', 'worldbook')
/** 持久化目录:角色卡 / 会话 / UI server 全局状态。重启时从这里恢复。 */
const ABS_CHARACTERS_DIR = join(PROJECT_ROOT, 'characters')
const ABS_SESSIONS_DIR = join(PROJECT_ROOT, 'sessions')
const TURN_STATS_FILE = 'turn-stats.jsonl'
const ABS_STATE_JSON = join(PROJECT_ROOT, 'ui-server-state.json')
/** 本地 API 配置(包含密钥, API 返回时永远掩码;文件已加入 .gitignore)。 */
const ABS_API_CONFIG_JSON = join(PROJECT_ROOT, 'api-config.json')
/** 导入角色卡时,把 `card.lorebook` 序列化为总条目目录 md 后写入此目录。 */
const ABS_WORLDBOOK_INDEX_DIR = join(PROJECT_ROOT, 'worldbook_index')
const pendingKeyIndexWrites = new Map<string, Promise<void>>()

/** Serialize generated key-index writes so an older rebuild cannot win a race. */
function queueWorldbookKeyIndexWrite(path: string, content: string): void {
  const previous = pendingKeyIndexWrites.get(path) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await mkdir(ABS_WORLDBOOK_INDEX_DIR, { recursive: true })
      await writeFile(path, content, 'utf-8')
    })
  pendingKeyIndexWrites.set(path, next)
  void next
    .catch(err => process.stderr.write(`[worldbook-index] warn: failed to write ${path}: ${err instanceof Error ? err.message : String(err)}\n`))
    .finally(() => {
      if (pendingKeyIndexWrites.get(path) === next) pendingKeyIndexWrites.delete(path)
    })
}
/** 独立世界书(从酒馆 World Info .json 导入)存储目录。 */
const ABS_WORLDBOOKS_DIR = join(PROJECT_ROOT, 'worldbooks')
/** agent prompt 文件目录(PUT /api/prompts/:name 会写这里)。 */
const ABS_PROMPTS_DIR = join(PROJECT_ROOT, 'src', 'agent-loop', 'prompts')
/** 用户 persona(酒馆 {{user}})持久化目录。 */
const ABS_PERSONAS_DIR = join(PROJECT_ROOT, 'personas')
/** 全局正则脚本持久化文件(酒馆 Regex 扩展对应物)。 */
const ABS_REGEX_JSON = join(PROJECT_ROOT, 'regex_scripts.json')
/** ⑤ postprocess 开关持久化文件。 */
const ABS_POSTPROCESS_JSON = join(PROJECT_ROOT, 'postprocess-settings.json')
/** 独立 MVU 变量处理配置;不与正文/后处理 preset 混用。 */
const ABS_MVU_SETTINGS_JSON = join(PROJECT_ROOT, 'mvu-settings.json')
/** 正文人称/字数设置;参考 ST preset,独立于 provider 与后处理配置。 */
const ABS_RESPONSE_SETTINGS_JSON = join(PROJECT_ROOT, 'response-settings.json')
/** Official extension bundles downloaded only through the manual updater. */
const ABS_EXTENSIONS_DIR = join(PROJECT_ROOT, 'extensions')
/** ⑤ postprocess watchdog 超时:只写 stderr 警告,不再 race 抢跑。 */
const POSTPROCESS_TIMEOUT_MS = 600_000

/** ⑤ postprocess 的可持久化配置。结构参考 SillyTavern 的 API preset：
 * 当前编辑值与可切换的命名 preset 分开保存，切换 preset 只替换当前值。 */
interface PostprocessConfig extends PostprocessRuntimeSettings {
  enabled: boolean
  maxRounds: number
  densityMax: number
  deferExtract: boolean
  modelOverrides: NonNullable<PostprocessRuntimeSettings['modelOverrides']>
}

interface PostprocessPreset {
  id: string
  name: string
  config: PostprocessConfig
  createdAt: number
  updatedAt: number
}

interface PostprocessSettings extends PostprocessConfig {
  activePresetId: string | null
  presets: PostprocessPreset[]
}

/** MVU is an extra post-response analysis call, with its own generation preset. */
interface MvuConfig extends MvuRuntimeSettings {}

interface MvuPreset {
  id: string
  name: string
  config: MvuConfig
  createdAt: number
  updatedAt: number
}

interface MvuSettings extends MvuConfig {
  activePresetId: string | null
  presets: MvuPreset[]
}

const DEFAULT_MVU_CONFIG: MvuConfig = {
  enabled: true,
  model: '',
  temperature: 0,
  promptName: 'mvu',
}

const DEFAULT_MVU_PRESET: MvuPreset = {
  id: 'default',
  name: '默认（独立 MVU）',
  config: { ...DEFAULT_MVU_CONFIG },
  createdAt: 0,
  updatedAt: 0,
}

const DEFAULT_MVU_SETTINGS: MvuSettings = {
  ...DEFAULT_MVU_CONFIG,
  activePresetId: 'default',
  presets: [{ ...DEFAULT_MVU_PRESET, config: { ...DEFAULT_MVU_CONFIG } }],
}

const DEFAULT_POSTPROCESS_CONFIG: PostprocessConfig = {
  enabled: true,
  maxRounds: 2,
  densityMax: POSTPROCESS_DENSITY_MAX,
  deferExtract: true,
  modelOverrides: {},
}

const DEFAULT_POSTPROCESS_PRESET: PostprocessPreset = {
  id: 'default',
  name: '默认',
  config: { ...DEFAULT_POSTPROCESS_CONFIG, modelOverrides: {} },
  createdAt: 0,
  updatedAt: 0,
}

const DEFAULT_POSTPROCESS_SETTINGS: PostprocessSettings = {
  ...DEFAULT_POSTPROCESS_CONFIG,
  activePresetId: 'default',
  presets: [{ ...DEFAULT_POSTPROCESS_PRESET, config: { ...DEFAULT_POSTPROCESS_CONFIG, modelOverrides: {} } }],
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function normalizedPostprocessConfig(value: unknown, fallback: PostprocessConfig = DEFAULT_POSTPROCESS_CONFIG): PostprocessConfig {
  const source = objectRecord(value)
  const models = objectRecord(source.modelOverrides)
  const model = (key: string): string | undefined => {
    const raw = models[key]
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
  }
  const a = model('a'); const b = model('b'); const c = model('c'); const extract = model('extract')
  const modelOverrides = {
    ...(a === undefined ? {} : { a }),
    ...(b === undefined ? {} : { b }),
    ...(c === undefined ? {} : { c }),
    ...(extract === undefined ? {} : { extract }),
  }
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    maxRounds: Math.round(boundedNumber(source.maxRounds, fallback.maxRounds, 1, 4)),
    densityMax: Math.round(boundedNumber(source.densityMax, fallback.densityMax, 0, 1) * 100) / 100,
    deferExtract: typeof source.deferExtract === 'boolean' ? source.deferExtract : fallback.deferExtract,
    modelOverrides,
  }
}

function postprocessPresetSummary(preset: PostprocessPreset): Record<string, unknown> {
  return { id: preset.id, name: preset.name, createdAt: preset.createdAt, updatedAt: preset.updatedAt }
}

function postprocessSettingsResponse(state: AppState): Record<string, unknown> {
  const { presets, ...current } = state.postprocessSettings
  return { ...current, presets: presets.map(postprocessPresetSummary) }
}

async function loadPostprocessSettings(): Promise<PostprocessSettings> {
  try {
    const raw = objectRecord(JSON.parse(await readFile(ABS_POSTPROCESS_JSON, 'utf-8')))
    const parsedPresets = Array.isArray(raw.presets) ? raw.presets : []
    const presets: PostprocessPreset[] = []
    for (const item of parsedPresets) {
      const source = objectRecord(item)
      if (typeof source.id !== 'string' || !/^[a-z0-9-]{1,100}$/u.test(source.id)
        || typeof source.name !== 'string' || source.name.trim() === '') continue
      const now = Date.now()
      presets.push({
        id: source.id,
        name: source.name.trim().slice(0, 80),
        config: normalizedPostprocessConfig(source.config),
        createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
        updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : now,
      })
    }
    if (!presets.some(preset => preset.id === 'default')) presets.unshift({ ...DEFAULT_POSTPROCESS_PRESET })
    const activePresetId = typeof raw.activePresetId === 'string'
      && presets.some(preset => preset.id === raw.activePresetId) ? raw.activePresetId : 'default'
    // Also accepts the old { enabled: boolean } file written by previous builds.
    return {
      ...normalizedPostprocessConfig(raw),
      activePresetId,
      presets,
    }
  } catch {
    return { ...DEFAULT_POSTPROCESS_CONFIG, activePresetId: 'default', presets: [{ ...DEFAULT_POSTPROCESS_PRESET }] }
  }
}

async function savePostprocessSettings(s: PostprocessSettings): Promise<void> {
  await writeFile(ABS_POSTPROCESS_JSON, JSON.stringify(s, null, 2), 'utf-8')
}

function normalizedMvuConfig(value: unknown, fallback: MvuConfig = DEFAULT_MVU_CONFIG): MvuConfig {
  const source = objectRecord(value)
  const model = typeof source.model === 'string' ? source.model.trim().slice(0, 200) : fallback.model
  const promptName = typeof source.promptName === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(source.promptName)
    ? source.promptName
    : fallback.promptName
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    model,
    temperature: Math.round(boundedNumber(source.temperature, fallback.temperature, 0, 2) * 100) / 100,
    promptName,
  }
}

function mvuPresetSummary(preset: MvuPreset): Record<string, unknown> {
  return { id: preset.id, name: preset.name, createdAt: preset.createdAt, updatedAt: preset.updatedAt }
}

function mvuSettingsResponse(state: AppState): Record<string, unknown> {
  const { presets, ...current } = state.mvuSettings
  return { ...current, presets: presets.map(mvuPresetSummary) }
}

async function loadMvuSettings(): Promise<MvuSettings> {
  try {
    const raw = objectRecord(JSON.parse(await readFile(ABS_MVU_SETTINGS_JSON, 'utf-8')))
    const parsedPresets = Array.isArray(raw.presets) ? raw.presets : []
    const presets: MvuPreset[] = []
    for (const item of parsedPresets) {
      const source = objectRecord(item)
      if (typeof source.id !== 'string' || !/^[a-z0-9-]{1,100}$/u.test(source.id)
        || typeof source.name !== 'string' || source.name.trim() === '') continue
      const now = Date.now()
      presets.push({
        id: source.id,
        name: source.name.trim().slice(0, 80),
        config: normalizedMvuConfig(source.config),
        createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
        updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : now,
      })
    }
    if (!presets.some(preset => preset.id === 'default')) presets.unshift({ ...DEFAULT_MVU_PRESET })
    const activePresetId = typeof raw.activePresetId === 'string'
      && presets.some(preset => preset.id === raw.activePresetId) ? raw.activePresetId : 'default'
    return {
      ...normalizedMvuConfig(raw),
      activePresetId,
      presets,
    }
  } catch {
    return { ...DEFAULT_MVU_CONFIG, activePresetId: 'default', presets: [{ ...DEFAULT_MVU_PRESET }] }
  }
}

async function saveMvuSettings(s: MvuSettings): Promise<void> {
  await writeFile(ABS_MVU_SETTINGS_JSON, JSON.stringify(s, null, 2), 'utf-8')
}

async function loadResponseSettings(): Promise<ResponseGenerationSettings> {
  try {
    return normalizeResponseSettings(JSON.parse(await readFile(ABS_RESPONSE_SETTINGS_JSON, 'utf-8')))
  } catch {
    return { ...DEFAULT_RESPONSE_SETTINGS }
  }
}

async function saveResponseSettings(s: ResponseGenerationSettings): Promise<void> {
  await writeFile(ABS_RESPONSE_SETTINGS_JSON, JSON.stringify(s, null, 2), 'utf-8')
}

/** 保存 WebUI 的 API 配置;密钥只落在本机项目目录,不会通过 API 返回。 */
async function saveApiConfig(config: ApiConfig): Promise<void> {
  await writeFile(ABS_API_CONFIG_JSON, JSON.stringify(config, null, 2), 'utf-8')
}

/** 启动时恢复上次保存的 API 配置;文件缺失或损坏时保留环境变量/Mock 默认值。 */
async function loadApiConfig(state: AppState): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(ABS_API_CONFIG_JSON, 'utf-8')) as unknown
    const parsed = parseConfigField(raw)
    if (parsed === null) {
      process.stderr.write(`[ui-server] ignored invalid ${ABS_API_CONFIG_JSON}\n`)
      return
    }
    state.configs.set(CONFIG_KEY_DEFAULT, mergeConfig(getGlobalConfig(state), parsed))
  } catch (err) {
    const code = err !== null && typeof err === 'object' && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined
    if (code !== 'ENOENT') {
      process.stderr.write(`[ui-server] failed to load ${ABS_API_CONFIG_JSON}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}
/** 世界书全局设置(扫描深度等)持久化文件(独立 json,不混入 ui-server-state.json)。 */
const ABS_WORLDBOOK_SETTINGS_JSON = join(PROJECT_ROOT, 'worldbook-settings.json')

/** Options accepted by {@link startServer}. */
export interface StartServerOptions {
  host?: string
  port?: number
  /** When true, forces MockProvider even if DEEPSEEK_API_KEY is set. */
  forceMock?: boolean
}

/** Result of {@link startServer}: the live `http.Server` + its bound address. */
export interface StartedServer {
  server: ReturnType<typeof createServer>
  host: string
  port: number
  close(): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory state
// ─────────────────────────────────────────────────────────────────────────────

/** 角色库 id = `safeFileName(character.name)`,与磁盘目录同名。
 *  酒馆范式:角色名稳定 → 同一个角色反复导入也能命中同一份存档。 */
type CharacterId = string

/** One imported character card, in-memory. */
interface CharacterRecord {
  /** 稳定 id,等于目录名(=`safeFileName(name)`)。 */
  readonly id: CharacterId
  /** 用户可见的角色名(可能与 id 不一致,如含特殊字符)。 */
  readonly name: string
  /** 首次 import 时间 ISO;后续 import 不会刷新这个字段。 */
  readonly createdAt: string
  /** 最近一次 import 时间 ISO,用于侧栏排序/显示。 */
  readonly updatedAt: string
  /** 预处理后的角色卡(人设/世界观/文风/开场白/备选开场白/内嵌世界书)。 */
  readonly preprocessed: PreprocessedCharacter
}

/** Per-session bookkeeping. The `MemorySessionStore` itself is shared. */
interface SessionRecord {
  readonly id: string
  readonly characterId: CharacterId
  readonly character: PreprocessedCharacter
  readonly createdAt: string
  /** Active greeting: 0 = firstMes, 1..n = alternateGreetings. */
  greetingIndex: number
  label: string
  /** Session-owned Tavern Helper namespaces, independent of transcript text. */
  tavernHelperState?: TavernHelperState
  /** Session-local World Info timed effects; rerolls never advance this clock. */
  worldbookTimedEffects?: TimedEffectState
  /** Current inner MVU `stat_data` snapshot, if one has been explicitly written. */
  mvuState?: JsonValue
}

/** On-disk session variable envelope. The encoded helper state keeps its
 * existing validation/prefix contract instead of duplicating its schema here. */
interface PersistedSessionVariables {
  readonly format: 0
  readonly mvuState?: JsonValue
  readonly tavernHelperState?: string
  readonly worldbookTimedEffects?: TimedEffectState
}

/** 角色对独立世界书(imported)的启用选择。默认全启用,用户可以显式禁用某本。
 *  用"禁用列表"(而不是"启用列表"):新增 import 的书自动对所有角色默认启用,
 *  避免"重启后旧 cfg 把新书默认关掉"的问题。 */
interface CharacterWorldbookConfig {
  /** 该角色"显式禁用"的独立世界书 id 集合;其他书都启用。 */
  disabledBookIds: Set<string>
}

interface AppState {
  /** Runtime API config keyed by tenant id. The demo only ever uses 'global'. */
  readonly configs: Map<string, ApiConfig>
  /** 启动时从 fixture 目录加载的"纯净"世界书,作为每次合并的固定底座。
   *  `worldbook` 则是合并结果(rebuild 时会整体替换),两者不能混用。 */
  readonly fixtureWorldbook: WorldbookStore
  readonly worldbook: WorldbookStore
  readonly sessions: MemorySessionStore
  readonly sessionRecords: Map<string, SessionRecord>
  /** 酒馆风格的"角色库":所有 import 过的角色卡都在这里。key = CharacterId。 */
  readonly characters: Map<CharacterId, CharacterRecord>
  /** 当前选中的角色 id(由前端在 UI 上点选控制)。 */
  currentCharacterId: CharacterId | null
  /** 当前选中的会话 id。酒馆风格:每个角色独立保存"上次打开的会话"是有价值的,
   *  这里先做全局一个,后续可以扩展为 per-character。 */
  currentSessionId: string | null
  /** 独立世界书库:从 /api/worldbook-import 导入的书(酒馆 .json 格式),
   *  key = safe name。启动时 load 进 `state.worldbook` 的合并源。 */
  readonly importedWorldbooks: Map<string, ImportedLorebook>
  /** 角色对独立世界书的"启用哪些"配置(per-character 开关)。
   *  没在 map 里的角色 = 默认全启用;在 map 里的角色 = 只启用 enabledBookIds 里的。 */
  readonly characterWorldbookConfigs: Map<CharacterId, CharacterWorldbookConfig>
  /** agent prompt 覆盖:启动时扫描 `src/agent-loop/prompts/*.md` 拿到名字列表,
   *  PUT /api/prompts/:name 会同时写盘 + 写这里,FilePromptLoader 读时优先这里。 */
  readonly promptOverrides: Map<string, string>
  /** 用户 persona 库(酒馆 {{user}})。startServer 时从 personas/ 加载。 */
  readonly personas: PersonaStore
  /** 当前选中的用户 persona id(null = 未配置,response 以"用户"泛称)。 */
  currentPersonaId: string | null
  /** 全局正则脚本库(酒馆 Regex 扩展)。startServer 时从 regex_scripts.json 加载。 */
  readonly regexScripts: RegexScriptStore
  /**
   * 世界书全局设置(酒馆 World Info 全局配置):扫描、递归、预算和匹配模式。
   * GET/PUT /api/worldbook-settings 读写,持久化到 worldbook-settings.json。
   */
  worldbookSettings: WorldbookSettings
  /** ⑤ postprocess 开关。GET/PUT /api/postprocess-settings 读写。 */
  postprocessSettings: PostprocessSettings
  /** 独立 MVU 变量分析模型/生成预设。GET/PUT /api/mvu-settings 读写。 */
  mvuSettings: MvuSettings
  /** response stage 人称与正文长度。GET/PUT /api/response-settings 读写。 */
  responseSettings: ResponseGenerationSettings
  /** Isolated ST-Prompt-Template evaluator, initialized once at server boot. */
  ejsEngine: EjsTemplateEngine | undefined
  /** Built-in compatibility adapters plus optional manually downloaded upstream bundles. */
  readonly extensions: ExtensionRegistry
}

function buildState(opts: StartServerOptions, env: NodeJS.ProcessEnv): AppState {
  const configs = new Map<string, ApiConfig>()
  // If DEEPSEEK_API_KEY is set (and we're not forcing mock), pre-fill the
  // global slot with the env-derived deepseek/openai config. Otherwise
  // start on the mock defaults so the UI has something to render.
  const hasDeepSeekKey = typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.trim().length > 0
  if (opts.forceMock !== true && hasDeepSeekKey) {
    const cfg = readConfig(env)
    configs.set(CONFIG_KEY_DEFAULT, {
      provider: 'openai',
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey ?? '',
      model: cfg.model,
    })
  } else {
    configs.set(CONFIG_KEY_DEFAULT, defaultMockConfig())
  }
  return {
    configs,
    fixtureWorldbook: undefined as unknown as WorldbookStore, // populated in startServer
    worldbook: undefined as unknown as WorldbookStore, // populated in startServer
    sessions: new MemorySessionStore(),
    sessionRecords: new Map<string, SessionRecord>(),
    characters: new Map<CharacterId, CharacterRecord>(),
    currentCharacterId: null,
    currentSessionId: null,
    importedWorldbooks: new Map<string, ImportedLorebook>(),
    characterWorldbookConfigs: new Map<CharacterId, CharacterWorldbookConfig>(),
    promptOverrides: new Map<string, string>(),
    personas: new PersonaStore(ABS_PERSONAS_DIR),
    currentPersonaId: null,
    regexScripts: new RegexScriptStore(ABS_REGEX_JSON),
    // ST 默认:扫描最近 2 条消息 + LLM 匹配;startServer 时从 worldbook-settings.json 覆盖。
    worldbookSettings: { ...DEFAULT_WORLDBOOK_SETTINGS },
    postprocessSettings: { ...DEFAULT_POSTPROCESS_SETTINGS },
    mvuSettings: { ...DEFAULT_MVU_SETTINGS, presets: [{ ...DEFAULT_MVU_PRESET, config: { ...DEFAULT_MVU_CONFIG } }] },
    responseSettings: { ...DEFAULT_RESPONSE_SETTINGS },
    ejsEngine: undefined,
    extensions: new ExtensionRegistry(ABS_EXTENSIONS_DIR),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multipart / form-data parser (no external deps)
// ─────────────────────────────────────────────────────────────────────────────

interface MultipartPart {
  name: string
  filename: string | undefined
  contentType: string | undefined
  data: Buffer
}

/** Split a `multipart/form-data` body into individual parts.
 *
 *  Only the first matching part for a given `name` is kept — we never expect
 *  repeated fields in the prototype's endpoints. Throws on malformed input
 *  so the route handler can surface a 4xx instead of silently dropping data.
 */
function parseMultipart(buffer: Buffer, boundary: string): MultipartPart[] {
  const sep = Buffer.from(`--${boundary}`)
  const out: MultipartPart[] = []
  // Split by the leading boundary marker. The very first chunk is the preamble
  // (empty), the very last chunk is the closing boundary (`--`).
  let start = buffer.indexOf(sep)
  if (start < 0) throw new Error('multipart: boundary not found')

  while (true) {
    const next = buffer.indexOf(sep, start + sep.length)
    if (next < 0) break
    // Slice from after the boundary CRLF to the next boundary.
    let chunkStart = start + sep.length
    if (buffer[chunkStart] === 0x2d && buffer[chunkStart + 1] === 0x2d) break
    // Skip CRLF after the boundary line.
    if (buffer[chunkStart] === 0x0d && buffer[chunkStart + 1] === 0x0a) chunkStart += 2
    let chunkEnd = next
    // Trim the trailing CRLF before the next boundary.
    if (buffer[chunkEnd - 2] === 0x0d && buffer[chunkEnd - 1] === 0x0a) chunkEnd -= 2
    const chunk = buffer.subarray(chunkStart, chunkEnd)
    if (chunk.length > 0) {
      const parsed = parseMultipartPart(chunk)
      if (parsed !== null) out.push(parsed)
    }
    start = next
  }
  return out
}

function parseMultipartPart(chunk: Buffer): MultipartPart | null {
  // Headers and body are separated by a blank line (CRLF CRLF).
  const sep = Buffer.from('\r\n\r\n')
  const sepIdx = chunk.indexOf(sep)
  if (sepIdx < 0) return null
  const headerText = chunk.subarray(0, sepIdx).toString('utf8')
  // Body extends to end of chunk (the trailing CRLF has already been trimmed
  // by parseMultipart).
  const data = chunk.subarray(sepIdx + sep.length)
  const headers = parseHeaderBlock(headerText)
  const disposition = headers['content-disposition'] ?? ''
  const name = readParam(disposition, 'name')
  if (name === undefined) return null
  const filename = readParam(disposition, 'filename')
  const contentType = headers['content-type']
  return {
    name,
    filename,
    contentType,
    data,
  }
}

function parseHeaderBlock(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r\n/u)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    out[key] = value
  }
  return out
}

/** Read a single parameter from a Content-Disposition header value. */
function readParam(header: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'iu')
  const m = re.exec(header)
  if (m === null) return undefined
  return m[1] ?? m[2] ?? undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Collect the request body into a single Buffer (size-capped). */
async function readBody(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buf.length
    if (total > maxBytes) {
      req.destroy()
      throw new Error(`request body exceeded ${maxBytes} bytes`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

/** Extract the boundary value from a `multipart/form-data; boundary=...` header. */
function extractBoundary(contentType: string | undefined): string | null {
  if (contentType === undefined) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType)
  if (m === null) return null
  return m[1] ?? m[2] ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Route handlers — kept small and self-contained
// ─────────────────────────────────────────────────────────────────────────────

async function handleImportPng(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const contentType = req.headers['content-type']
  const boundary = extractBoundary(contentType)
  if (boundary === null) return sendError(res, 400, 'expected multipart/form-data with boundary')

  const body = await readBody(req)
  const parts = parseMultipart(body, boundary)
  const filePart = parts.find(p => p.name === 'file')
  if (filePart === undefined) return sendError(res, 400, 'missing "file" field')
  if (filePart.data.length === 0) return sendError(res, 400, 'empty upload')

  await mkdir(ABS_TMP_DIR, { recursive: true })
  const tmpPath = join(ABS_TMP_DIR, `${randomUUID()}.png`)
  try {
    await writeFile(tmpPath, filePart.data)
    const character = await loadCharacterCardFromPng(tmpPath)
    const lorebookFile = await writeLorebookIndex(character)
    // 持久化到 characters/<id>/,失败抛错返回 500
    const record = await saveCharacter(state, character, filePart.data)
    // 酒馆范式:刚导入的角色自动成为"当前角色"
    state.currentCharacterId = record.id
    // 重新合并 worldbook(用新角色作为 characterId,该角色默认全启用 imported 书)
    ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, record.id)
    state.currentSessionId = null // 切角色时旧的会话先清掉
    await writeStateJson(state)
    sendJson(res, 200, {
      character: serializeCharacter(character),
      lorebookFile,
      id: record.id,
      createdAt: record.createdAt,
    })
  } catch (err) {
    sendError(res, 400, `failed to load character card: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await unlink(tmpPath).catch(() => undefined)
  }
}

async function handleImportJson(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 4 * 1024 * 1024)
  const text = body.toString('utf8')
  try {
    const character = loadCharacterCardFromJson(text)
    const lorebookFile = await writeLorebookIndex(character)
    // JSON 导入没有原始 PNG 字节,传 null(不影响功能,只是不保存 original.png)
    const record = await saveCharacter(state, character, null)
    state.currentCharacterId = record.id
    state.currentSessionId = null
    await writeStateJson(state)
    ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, record.id)
    sendJson(res, 200, {
      character: serializeCharacter(character),
      lorebookFile,
      id: record.id,
      createdAt: record.createdAt,
    })
  } catch (err) {
    sendError(res, 400, `failed to load character JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleWorldbook(state: AppState, res: ServerResponse): Promise<void> {
  // fixture + 已导入角色卡内嵌 worldbook 的合并列表。
  // 排序:先按 order 升序,再按 weight 降序(同 fixture MemoryWorldbookStore.list)。
  const list = [...state.worldbook.list()]
    .map(e => ({
      path: e.path,
      keywords: [...e.keywords],
      order: e.order,
      weight: e.weight,
      contentPreview: e.content.length > 80 ? `${e.content.slice(0, 80)}…` : e.content,
    }))
    .sort((a, b) => a.order - b.order || b.weight - a.weight)
  // cardCount / importedCount:统计当前 state.worldbook 里**当前角色**实际生效的条目
  // (state.worldbook 在 select / PATCH / import 时已经按当前角色 rebuild 过)
  // path 含角色名(<角色名>/)的是该角色卡 dynamic,含"世界书/"的是独立世界书。
  let cardCount = 0
  let importedCount = 0
  const currentCharName = state.currentCharacterId !== null
    ? state.characters.get(state.currentCharacterId)?.name
    : null
  for (const e of list) {
    if (e.path.startsWith('世界书/')) importedCount += 1
    else if (currentCharName !== null && currentCharName !== undefined && e.path.startsWith(`${currentCharName}/`)) cardCount += 1
  }
  // fixtureCount = 剩余 = 启动时从 src/agent-loop/_fixtures/worldbook/ 加载的
  const fixtureCount = list.length - cardCount - importedCount
  sendJson(res, 200, { entries: list, fixtureCount, cardCount, importedCount })
}

async function handleWorldbookMd(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const characterName = url.searchParams.get('character')
  if (characterName === null || characterName.length === 0) {
    return sendError(res, 400, 'character query param is required')
  }
  const safe = safeFileName(characterName)
  const target = join(ABS_WORLDBOOK_INDEX_DIR, `${safe}_index.md`)
  try {
    const md = await readFile(target, 'utf-8')
    sendJson(res, 200, { path: target, character: characterName, mdContent: md })
  } catch {
    // 磁盘上没有 md 时回退到用 in-memory 的 `state.characters` 实时渲染,
    // 避免服务重启后 import 还没执行、index md 还没生成时前端拿不到内容。
    const rec = state.characters.get(safe)
    if (rec !== undefined && rec.preprocessed.lorebook !== undefined) {
      const mdContent = renderLorebookIndexMd(rec.preprocessed)
      sendJson(res, 200, { path: target, character: characterName, mdContent })
      return
    }
    sendError(res, 404, `worldbook index not found for character: ${characterName}`)
  }
}

async function handleRun(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.searchParams.get('format') === 'json') {
    return handleRunJson(state, req, res)
  }
  return handleRunSse(state, req, res)
}

async function handleRunJson(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Character wire projections may contain large scoped-regex replacements
  // (real ST cards often embed CSS/HTML). The upload endpoint remains
  // separately bounded; run requests get 8 MiB so a valid card is not
  // rejected before the server can resolve its lossless stored copy.
  const body = await readBody(req, 8 * 1024 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')

  const reroll = payload.reroll === true
  let userInput = readStringField(payload, 'userInput') ?? ''
  if (userInput.length === 0 && !reroll) {
    return sendError(res, 400, 'userInput is required')
  }

  let cfg = getGlobalConfig(state)
  const overrideRaw = readField(payload, 'config')
  if (overrideRaw !== undefined) {
    const override = parseConfigField(overrideRaw)
    if (override === null) return sendError(res, 400, 'invalid config field')
    cfg = mergeConfig(cfg, override)
  }

  let sessionId = readStringField(payload, 'sessionId')
  if (sessionId === undefined) {
    if (reroll) return sendError(res, 400, 'reroll requires sessionId')
    const characterJson = readField(payload, 'character')
    if (characterJson === undefined) return sendError(res, 400, 'sessionId or character is required')
    const character = resolveCharacterField(state, characterJson)
    if (character === null) return sendError(res, 400, 'invalid character field')
    const cid = safeFileName(character.name)
    sessionId = await createSession(state, character, cid, autoLabel(character))
  } else if (!state.sessionRecords.has(sessionId)) {
    return sendError(res, 404, `session not found: ${sessionId}`)
  }

  const characterJson = readField(payload, 'character')
  if (characterJson !== undefined) {
    const character = resolveCharacterField(state, characterJson)
    if (character !== null) {
      const rec = state.sessionRecords.get(sessionId)
      if (rec !== undefined) state.sessionRecords.set(sessionId, withSessionCharacter(rec, character))
    }
  }

  const record = state.sessionRecords.get(sessionId)
  if (record === undefined) return sendError(res, 500, 'session record vanished')
  const helperState = ensureSessionTavernHelperState(record)
  const helperPromptSelection = selectTavernInjectedPrompts(helperState)

  // 重 roll:截掉最后一条 assistant,复用该轮 user 输入(runLoop 跳过重复 append)。
  let rerollPrevious: ChatMessage | undefined
  if (reroll) {
    const rerollState = await truncateForReroll(state, sessionId)
    if (rerollState === null) {
      return sendError(res, 400, 'reroll requires a session whose last message is an assistant reply')
    }
    userInput = rerollState.userInput
    rerollPrevious = rerollState.previousAssistant
  } else {
    // 正则脚本(user_input 位):新输入在进链路/落库前应用(reroll 不重复应用)。
    userInput = applyRegexScripts(
      state.regexScripts.list(), userInput, 'user_input',
      { user: getCurrentUserPersona(state)?.name ?? null, char: record.character.name },
    )
  }

  try {
    // 记下 before 长度,runLoop 内部会 appendMessage user + assistant,
    // 我们把新增的写到 history.jsonl(避免重复 append 的副作用)。
    const before = state.sessions.getHistory(sessionId).length
    const result = await runLoop(
      userInput,
      {
        provider: resolveProvider(cfg),
        model: cfg.model,
        prompts: new FilePromptLoader(),
        session: state.sessions,
        worldbook: state.worldbook,
        sessionId,
        character: record.character,
        userPersona: getCurrentUserPersona(state),
        skipUserAppend: reroll,
        // 世界书全局设置(扫描深度 / LLM 匹配开关):ST world_info_depth 对应物。
        worldbookSettings: state.worldbookSettings,
        tavernHelperState: helperState,
        responseSettings: state.responseSettings,
        postprocessSettings: state.postprocessSettings,
        mvu: state.mvuSettings,
        // 正则脚本(ai_output 位):落库前应用,存的就是成品(酒馆 "Alter Chat Output")。
        transformReply: (reply) => applyRegexScripts(
          state.regexScripts.list(), reply, 'ai_output',
          { user: getCurrentUserPersona(state)?.name ?? null, char: record.character.name },
        ),
        summarize: (ctx, input) => { void triggerSummarize(input, ctx) },
      },
      {
        intent: intentAgent,
        worldbook: worldbookMatchAgent,
        context: contextProcessAgent,
        response: responseAgent,
        // exactOptionalPropertyTypes: 可选 agent 用条件展开(mock 或手动关闭时跳过 ⑤)。
        ...(cfg.provider === 'mock' || !state.postprocessSettings.enabled ? {} : { postprocess: postprocessAgent }),
      },
    )
    const afterHistory = [...state.sessions.getHistory(sessionId)]
    const lastIndex = afterHistory.length - 1
    const last = afterHistory[lastIndex]
    if (last?.role === 'assistant') {
      afterHistory[lastIndex] = makeAssistantMessage(last.content, rerollPrevious)
      state.sessions.setHistory(sessionId, afterHistory)
      try { await rewriteHistoryJsonl(sessionId, afterHistory) } catch { /* swallow */ }
    } else {
      for (let i = before; i < afterHistory.length; i++) {
        const m = afterHistory[i]
        if (m === undefined) continue
        try { await appendHistoryJsonl(sessionId, m) } catch { /* swallow */ }
      }
    }
    const latestRecord = state.sessionRecords.get(sessionId)
    if (latestRecord !== undefined) {
      const consumedHelperState = consumeTavernInjectedPromptsAfterGeneration(
        latestRecord.tavernHelperState ?? helperState,
        helperPromptSelection,
      )
      if (consumedHelperState !== undefined && consumedHelperState !== latestRecord.tavernHelperState) {
        state.sessionRecords.set(sessionId, { ...latestRecord, tavernHelperState: consumedHelperState })
        try { await saveSessionVariables({ ...latestRecord, tavernHelperState: consumedHelperState }) } catch { /* best effort */ }
      }
    }
    const persistedHistory = state.sessions.getHistory(sessionId)
    const persistedMessage = persistedHistory[persistedHistory.length - 1]
    sendJson(res, 200, {
      ...result,
      ...(persistedMessage === undefined ? {} : { message: displayHistory(state, sessionId, [persistedMessage])[0] }),
    })
  } catch (err) {
    sendError(res, 500, `runLoop failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleRunSse(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 8 * 1024 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')

  const reroll = payload.reroll === true
  let userInput = readStringField(payload, 'userInput') ?? ''
  if (userInput.length === 0 && !reroll) {
    return sendError(res, 400, 'userInput is required')
  }

  let cfg = getGlobalConfig(state)
  const overrideRaw = readField(payload, 'config')
  if (overrideRaw !== undefined) {
    const override = parseConfigField(overrideRaw)
    if (override === null) return sendError(res, 400, 'invalid config field')
    cfg = mergeConfig(cfg, override)
  }

  let sessionId = readStringField(payload, 'sessionId')
  if (sessionId === undefined) {
    if (reroll) return sendError(res, 400, 'reroll requires sessionId')
    const characterJson = readField(payload, 'character')
    if (characterJson === undefined) return sendError(res, 400, 'sessionId or character is required')
    const character = resolveCharacterField(state, characterJson)
    if (character === null) return sendError(res, 400, 'invalid character field')
    const cid = safeFileName(character.name)
    sessionId = await createSession(state, character, cid, autoLabel(character))
  } else if (!state.sessionRecords.has(sessionId)) {
    return sendError(res, 404, `session not found: ${sessionId}`)
  }

  const characterJson = readField(payload, 'character')
  if (characterJson !== undefined) {
    const character = resolveCharacterField(state, characterJson)
    if (character !== null) {
      const rec = state.sessionRecords.get(sessionId)
      if (rec !== undefined) state.sessionRecords.set(sessionId, withSessionCharacter(rec, character))
    }
  }

  const record = state.sessionRecords.get(sessionId)
  if (record === undefined) return sendError(res, 500, 'session record vanished')

  // 重 roll:截掉最后一条 assistant 回复,复用该轮的 user 输入重新生成。
  // (必须在 SSE headers 之前完成,失败还能以 JSON 4xx 返回。)
  let rerollPrevious: ChatMessage | undefined
  if (reroll) {
    const rerollState = await truncateForReroll(state, sessionId)
    if (rerollState === null) {
      return sendError(res, 400, 'reroll requires a session whose last message is an assistant reply')
    }
    userInput = rerollState.userInput
    rerollPrevious = rerollState.previousAssistant
  } else {
    // 正则脚本(user_input 位):新输入在进链路/落库前应用。
    // (reroll 复用的是发送时已处理过的存量输入,不重复应用。)
    userInput = applyRegexScripts(
      state.regexScripts.list(), userInput, 'user_input',
      // 注意:这里 `const character` 还没声明(在下面),用 record.character 防 TDZ。
      { user: getCurrentUserPersona(state)?.name ?? null, char: record.character.name },
    )
  }

  const helperState = ensureSessionTavernHelperState(record)
  const helperPromptSelection = selectTavernInjectedPrompts(helperState)

  // Reroll keeps the original user turn and looks up the successful
  // generation's reusable artifacts before opening SSE. This survives a
  // server restart because the artifacts live in turn-stats.jsonl.
  // 原请求还没把 user 写入 history,所以预留下一轮；reroll 已保留
  // 原 user 消息,直接使用当前 user-turn 编号。
  const rerollTurn = userTurnNumber(state.sessions, sessionId) + (reroll ? 0 : 1)
  const reusableTurn = reroll
    ? await findReusableTurn(sessionId, rerollTurn, userInput)
    : null
  const runId = randomUUID()

  // SSE headers — once these are written we cannot go back to JSON error responses.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const sendStage = (ev: StageEvent): void => {
    try {
      const eventName = ev.name === 'error' ? 'error' : 'stage'
      writeSseEvent(res, eventName, ev)
    } catch {
      // res already closed by client — ignore.
    }
  }

  const usageTracker = new UsageTrackingProvider(resolveProvider(cfg))
  const provider = usageTracker
  const prompts = new FilePromptLoader()
  const session = state.sessions
  const worldbook = state.worldbook
  const character = record.character
  const activeUserName = getCurrentUserPersona(state)?.name ?? '用户'
  const mvuMacros: MvuMacroContext = { user: activeUserName, char: character.name }

  // World Info timed effects are scoped to the current chat and evaluated
  // against the model-visible message count before this generation.  Reroll
  // reaches this point with the same count, so pruning removes effects from
  // the abandoned branch without advancing or refreshing them.
  const timedEffectCandidates = state.worldbook.list()
  const timedEffectMessageCount = session.getHistory(sessionId).length
  const prunedTimedEffects = pruneTimedEffectState(
    record.worldbookTimedEffects ?? {},
    timedEffectCandidates,
    timedEffectMessageCount,
  )
  const timedEffects = Object.keys(prunedTimedEffects).length === 0 ? undefined : prunedTimedEffects
  const currentSessionRecord = state.sessionRecords.get(sessionId)
  if (currentSessionRecord !== undefined) {
    const { worldbookTimedEffects: _oldTimedEffects, ...recordWithoutTimedEffects } = currentSessionRecord
    state.sessionRecords.set(sessionId, timedEffects === undefined
      ? recordWithoutTimedEffects
      : { ...recordWithoutTimedEffects, worldbookTimedEffects: timedEffects })
  }

  // Persist user message first so 2.2 sees it.
  // (reroll 模式跳过:该轮的 user 消息已在历史里,truncate 时保留了。)
  if (!reroll) {
    session.appendMessage(sessionId, { role: 'user', content: userInput })
    // 持久化 user 消息到 history.jsonl(best-effort)
    try { await appendHistoryJsonl(sessionId, { role: 'user', content: userInput }) } catch { /* swallow */ }
  }

  // agentCtx 带上 {{user}}/{{char}} 宏源与世界书设置(2.1 候选条目宏替换 / 扫描深度用,
  // 3 的独立书蓝灯常驻注入也读 ctx.worldbook)。
  // **不再传 onProgress** — postprocess 子环节改由 ui-server 的
  // runPostprocessPipeline 用 runStageWithTrace 逐个包,每个子环节独立 stage
  // 独立 trace,前端能像 5 阶段一样独立追踪。
  const templateRenderer = buildCharacterTemplateRenderer(
    state,
    character,
    session,
    sessionId,
    activeUserName,
  )
  const mvuState = readSessionMvuState(record, session.getHistory(sessionId), mvuMacros)?.statData
  const agentCtx = buildAgentContext({
    provider, model: cfg.model, prompts, session, worldbook, sessionId,
    macros: { user: activeUserName, char: character.name },
    worldbookSettings: state.worldbookSettings,
    responseSettings: state.responseSettings,
    worldbookGlobalScanData: {
      personaDescription: getCurrentUserPersona(state)?.description ?? '',
      characterDescription: character.raw.description,
      characterPersonality: character.raw.personality,
      scenario: character.raw.scenario,
      creatorNotes: character.raw.creatorNotes ?? '',
    },
    tavernHelperState: helperState,
    ...(timedEffects === undefined ? {} : { worldbookTimedEffects: timedEffects }),
    postprocessSettings: state.postprocessSettings,
    ...(templateRenderer === undefined ? {} : { renderTemplate: templateRenderer }),
    ...(mvuState === undefined ? {} : { statData: mvuState }),
  })

  // ─── Agent trace 捕获:每个 stage 跑完发 `agent-trace` 事件,前端展开看 I/O
  // input/output 可能很大(尤其 character.full content),用 stringify 后截断到 200KB
  // 防止 SSE 写超。同一份截断串还会落到 sessions/<id>/traces.jsonl,刷新后可回看。
  const TRACE_MAX_CHARS = 200_000
  // 落盘用的轮次:stage 执行时 assistant 回复还没 append,turnCount 是"回复前"
  // 的值(含开场白),+1 后与 final 事件上报的 turn 一致,前端按 turn 分组不会错位。
  const traceTurn = rerollTurn
  const stageMeta = new Map<string, Pick<AgentTokenStats, 'reused' | 'deferred' | 'reusedFromRunId'>>()
  const seenStages = new Set<string>()
  const sendTrace = (
    name: string,
    input: unknown,
    output: unknown,
    durationMs: number,
    usage: TokenUsageStats,
    usageTotal: TokenUsageStats = usageTracker.snapshot(name),
  ): void => {
    try {
      const inputStr = JSON.stringify(input) ?? 'null'
      const outputStr = JSON.stringify(output) ?? 'null'
      const promptCalls = usageTracker.promptTrace(name)
      // Unlike the diagnostic input/output summaries, promptJson is never
      // truncated: it is the exact provider request the user needs to audit.
      const promptJson = promptCalls.length > 0 ? JSON.stringify(promptCalls) : undefined
      const truncated = (s: string) => s.length > TRACE_MAX_CHARS
        ? `${s.slice(0, TRACE_MAX_CHARS)}…(已截断,原长 ${s.length})`
        : s
      const inputJson = truncated(inputStr)
      const outputJson = truncated(outputStr)
      const ts = new Date().toISOString()
      const meta = stageMeta.get(name) ?? {}
      const trace = {
        name, inputJson, outputJson, durationMs, ts,
        turn: traceTurn, runId, reroll,
        usage: { ...usage, ...meta },
        usageTotal,
        ...(promptJson === undefined ? {} : { promptJson }),
        ...meta,
      }
      writeSseEvent(res, 'agent-trace', trace)
      // 持久化 trace(复用同一份截断串;best-effort,失败不影响主流程)
      void appendTraceJsonl(sessionId, trace)
        .catch(() => undefined)
    } catch {
      // trace 写不出去不影响主流程
    }
  }
  const runStageWithTrace = async <T>(
    name: Exclude<StageName, 'summarize' | 'final' | 'error'>,
    input: unknown,
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    seenStages.add(name)
    sendStage({ name, status: 'start' })
    const t0 = Date.now()
    const beforeUsage = usageTracker.snapshot(name)
    try {
      const out = await usageTracker.inStage(name, fn)
      sendStage({ name, status: 'done' })
      const usageTotal = usageTracker.snapshot(name)
      sendTrace(name, input, out, Date.now() - t0, subtractTokenUsage(usageTotal, beforeUsage), usageTotal)
      return out
    } catch (err) {
      sendStage({
        name: 'error',
        status: 'error',
        message: `${name} stage failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      const usageTotal = usageTracker.snapshot(name)
      sendTrace(name, input, { error: err instanceof Error ? err.message : String(err) }, Date.now() - t0, subtractTokenUsage(usageTotal, beforeUsage), usageTotal)
      return null
    }
  }

  const runReusedStage = async <T>(
    name: Exclude<StageName, 'summarize' | 'final' | 'error'>,
    input: unknown,
    output: T,
    sourceRunId: string,
  ): Promise<T> => {
    seenStages.add(name)
    stageMeta.set(name, { reused: true, reusedFromRunId: sourceRunId })
    // A reroll reuses intent/worldbook artifacts from the original run.
    // Do not emit start/done here: those are execution events and made the
    // UI look as if reroll had started from intent recognition again. Keep
    // the trace so the run still explains that the stage was reused at zero
    // token cost.
    sendTrace(name, input, output, 0, { ...EMPTY_TOKEN_USAGE }, { ...EMPTY_TOKEN_USAGE })
    return output
  }

  // ─── ⑤ postprocess 编排:每个子环节独立 stage,实时追踪,无 race ─────────────
  //
  // 把 gate / pass-a / pass-b / pass-c 各自包成一个 stage,
  // 每个同步 LLM 调用独立 start/done + trace。extract 在后台异步执行。
  // 编排逻辑和 postprocessAgent.run 等价,
  // 但:
  //   1. 不再 race(原 race + 180s setTimeout 兜底会让真 LLM 跑超时后 best 丢)
  //   2. 每个子环节失败只影响那一个 stage 的 trace,后续 stage 照跑
  //   3. 任一 LLM 返回的 edits 立即 applyEdits 进 text,下一个 stage 拿到的就是
  //      修订后的 text(端到端链式)
  //   4. watchdog(POSTPROCESS_TIMEOUT_MS)只做告警,不抢跑也不丢弃最终修订；
  //      真挂死由调用方/进程生命周期处理
  //   5. 返回 best(修订版),外层决定是否赋给 result.reply
  const runPostprocessPipeline = async (rawReply: string): Promise<string | null> => {
    return runPostprocessPipelineCore(rawReply, agentCtx, {
      maxRounds: state.postprocessSettings.maxRounds,
      densityMax: state.postprocessSettings.densityMax,
      deferExtract: state.postprocessSettings.deferExtract,
      modelOverrides: state.postprocessSettings.modelOverrides,
      runStage: (name, input, fn) => runStageWithTrace(name, input, fn),
      runAsyncStage: (name, input, fn) => {
        stageMeta.set(name, { deferred: true })
        return runStageWithTrace(name, input, fn).then(async (out) => {
          if (turnStatsWritten) await writeCurrentTurnStats(result?.reply.length ?? rawReply.length)
          return out
        })
      },
      onRound: ({ round, text, stats }) => {
        console.info(
          `[postprocess] round=${round} bestLen=${text.length} origLen=${rawReply.length}`
          + ` stats=${JSON.stringify(stats)}`,
        )
      },
    })
  }

  let intent: import('./schema.ts').IntentOutput | null = null
  let wb: import('./schema.ts').WorldbookMatchOutput | null = null
  let ctxSegs: import('./schema.ts').ContextSegmentOutput | null = null
  let result: { reply: string } | null = null
  let usedWorldbook = false
  let usedContextSegmentation = false
  let turnStatsWritten = false

  const buildTurnStats = (assistantLength: number): TurnStatsRecord => {
    const usageByStage = usageTracker.snapshotAll()
    const names = [...new Set([...seenStages, ...Object.keys(usageByStage), ...stageMeta.keys()])]
    const agents: Record<string, AgentTokenStats> = {}
    for (const name of names) {
      agents[name] = {
        ...(usageByStage[name] ?? cloneTokenUsage(EMPTY_TOKEN_USAGE)),
        ...(stageMeta.get(name) ?? {}),
      }
    }
    const billable = names
      .filter(name => stageMeta.get(name)?.deferred !== true)
      .map(name => agents[name] ?? cloneTokenUsage(EMPTY_TOKEN_USAGE))
    const record: TurnStatsRecord = {
      runId,
      turn: traceTurn,
      reroll,
      ts: new Date().toISOString(),
      userInput,
      assistantLength,
      total: sumTokenUsage(billable),
      agents,
      ...(intent !== null && wb !== null && ctxSegs !== null
        ? { reusable: { intent, worldbook: wb, context: ctxSegs } }
        : {}),
      ...(reusableTurn !== null ? { reusedFromRunId: reusableTurn.runId } : {}),
    }
    return record
  }

  const writeCurrentTurnStats = async (assistantLength: number): Promise<void> => {
    const record = buildTurnStats(assistantLength)
    try {
      await appendTurnStatsJsonl(sessionId, record)
      turnStatsWritten = true
    } catch (err) {
      process.stderr.write(`[ui-server] warn: failed to persist token stats for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  try {
    if (reusableTurn?.reusable !== undefined) {
      const reusedIntent = await runReusedStage(
        'intent',
        { userInput, reusedFromTurn: reusableTurn.turn },
        reusableTurn.reusable.intent,
        reusableTurn.runId,
      )
      intent = reusedIntent
      wb = await runReusedStage(
        'worldbook',
        { intent: reusedIntent, reusedFromTurn: reusableTurn.turn },
        reusableTurn.reusable.worldbook,
        reusableTurn.runId,
      )
      const reader = buildContextReader(session, sessionId)
      const contextInput = {
        intent: reusedIntent,
        worldbookMatches: { matchCount: (wb as { matches: unknown[] }).matches.length },
        reader: '<ContextReader: not serializable>',
      }
      ctxSegs = reusableTurn.reusable.context !== undefined
        ? await runReusedStage(
          'context',
          { ...contextInput, reusedFromTurn: reusableTurn.turn },
          reusableTurn.reusable.context,
          reusableTurn.runId,
        )
        : await runStageWithTrace('context', contextInput, () => contextProcessAgent.run(
          {
            intent: reusedIntent,
            worldbookHints: (wb as { matches: Array<{ path: string }> }).matches.map(match => match.path),
            reader,
          },
          agentCtx,
        ))
    } else {
      intent = await runStageWithTrace('intent', { userInput }, () => intentAgent.run(userInput, agentCtx))
      if (intent === null) { res.end(); return }
      const currentIntent = intent

      // 2.1 输入改为结构化(最近 N 条消息 + 候选绿灯条目参数表,ST 语义适配):
      // 先组装再喂 agent,trace(SSE + traces.jsonl)里能看到完整输入结构。
      const wbInput = buildWorldbookMatchInput(currentIntent, agentCtx)
      const reader = buildContextReader(session, sessionId)
      // Context selection is independent from semantic worldbook matching.
      // Give it only a local deterministic baseline as a hint, then run both
      // LLM calls concurrently. The final worldbook output is still resolved
      // before response generation below.
      const worldbookHints = deterministicWorldbookMatch(wbInput, { rollProbability: false })
        .map(candidate => candidate.path)
      const contextInput = {
        intent: currentIntent,
        worldbookHints,
        reader: '<ContextReader: not serializable>',
      }
      const [nextWorldbook, nextContext] = await Promise.all([
        runStageWithTrace('worldbook', wbInput, () => worldbookMatchAgent.run(wbInput, agentCtx)),
        runStageWithTrace('context', contextInput, () => contextProcessAgent.run(
          { intent: currentIntent, worldbookHints, reader },
          agentCtx,
        )),
      ])
      wb = nextWorldbook
      ctxSegs = nextContext
    }
    if (wb === null) { res.end(); return }
    if (ctxSegs === null) { res.end(); return }

    // The response agent receives standalone blue-light entries through
    // agentCtx.worldbook and injects them into the final system prompt. Keep
    // the same source entries visible in the structured trace input too;
    // otherwise the trace misleadingly shows only matchCount and looks as if
    // an external worldbook was never passed to the response stage.
    const keptConstantPaths = (wb as {
      budget?: { keptConstantPaths?: unknown }
    }).budget?.keptConstantPaths
    const allowedConstantPaths = Array.isArray(keptConstantPaths)
      ? new Set(keptConstantPaths.filter((path): path is string => typeof path === 'string'))
      : undefined
    const constantWorldbookEntries = listConstantWorldbookEntries(
      state.worldbook,
      text => text,
      {
        applyProbability: false,
        ...(allowedConstantPaths === undefined ? {} : { allowedPaths: allowedConstantPaths }),
      },
    )
    result = await runStageWithTrace('response',
      {
        intent,
        worldbook: {
          matchCount: (wb as { matches: unknown[] }).matches.length,
          constantWorldbookEntries,
        },
        contextSegmentation: ctxSegs,
        userInput,
        responseSettings: state.responseSettings,
        character: {
          name: character.name,
          persona: character.persona,
          worldview: character.worldview,
          style: character.style,
        },
      },
      () => responseAgent.run(
        {
          intent: intent as never,
          worldbook: wb as never,
          contextSegmentation: ctxSegs as never,
          userInput,
          character,
          userPersona: getCurrentUserPersona(state),
          responseSettings: state.responseSettings,
        },
        agentCtx,
      ),
    )
    if (result === null) { res.end(); return }

    usedWorldbook = (wb as { matches: unknown[] }).matches.length > 0
    usedContextSegmentation = (ctxSegs as { segments: unknown[] }).segments.length > 0

    // Commit timed effects only for a normal advancing generation.  The
    // matcher snapshot was evaluated before the assistant message was
    // appended; rerolls intentionally reuse that snapshot and never refresh
    // sticky/cooldown durations.
    if (!reroll) {
      const nextTimedEffects = recordTimedEffectActivations(
        timedEffects ?? {},
        timedEffectCandidates,
        (wb as { matches: Array<{ path: string }> }).matches.map(match => match.path),
        timedEffectMessageCount,
      )
      const latestRecord = state.sessionRecords.get(sessionId)
      if (latestRecord !== undefined) {
        const { worldbookTimedEffects: _previousTimedEffects, ...recordWithoutTimedEffects } = latestRecord
        const nextRecord = Object.keys(nextTimedEffects).length === 0
          ? recordWithoutTimedEffects
          : { ...recordWithoutTimedEffects, worldbookTimedEffects: nextTimedEffects }
        state.sessionRecords.set(sessionId, nextRecord)
        try { await saveSessionVariables(nextRecord) } catch { /* best effort */ }
      }
    }
    const latestRecordAfterResponse = state.sessionRecords.get(sessionId)
    if (latestRecordAfterResponse !== undefined) {
      const consumedHelperState = consumeTavernInjectedPromptsAfterGeneration(
        latestRecordAfterResponse.tavernHelperState ?? helperState,
        helperPromptSelection,
      )
      if (consumedHelperState !== undefined && consumedHelperState !== latestRecordAfterResponse.tavernHelperState) {
        const nextRecord = { ...latestRecordAfterResponse, tavernHelperState: consumedHelperState }
        state.sessionRecords.set(sessionId, nextRecord)
        try { await saveSessionVariables(nextRecord) } catch { /* best effort */ }
      }
    }
  } catch (err) {
    if (!res.writableEnded) {
      try { writeSseEvent(res, 'error', { name: 'error', status: 'error', message: String(err) }) } catch { /* */ }
      res.end()
    }
    return
  }

  // ⑤ postprocess 编排:每个子环节独立 stage,实时追踪,无 race。
  //
  // 原设计把整个 postprocess 包装成一个 outer stage,内部用 Promise.race
  // + 180s setTimeout 兜底。问题:真 LLM 跑超过 180s 时 race 选了 setTimeout,
  // postprocess 后续还在跑但 race 已锁定 rawReply,best 永远丢 — 修订结果
  // 没回填到 result.reply(用户实际反馈的 bug)。
  //
  // 新设计:编排放 ui-server,每个子环节(pass-a/b/c/extract)独立
  // runStageWithTrace,各自 start/done + trace。编排本身 await 到底(不 race),
  // 失败保原文继续,默认不超时;POSTPROCESS_TIMEOUT_MS 只写 stderr 警告,
  // 不抢跑，也不在最终返回后丢弃已经完成的修订。
  //
  // 任何子 stage 失败 → 那个 stage 报 error 事件 + return null,后续 stage
  // 照常跑(用户能看到哪一步挂了);编排最后用 try/catch 兜底,任一异常都
  // 保留 rawReply 落库(不让前端"卡死"也保证数据不丢)。
  if (state.postprocessSettings.enabled) {
    const rawReply = result.reply
    // watchdog:postprocess 真挂死时只警告不抢跑(默认 10 分钟,合理上限)
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      process.stderr.write(`[ui-server] postprocess exceeded ${POSTPROCESS_TIMEOUT_MS}ms, waiting for the pipeline result\n`)
    }, POSTPROCESS_TIMEOUT_MS)
    try {
      const pipelineResult = await runPostprocessPipeline(rawReply)
      clearTimeout(watchdog)
      if (pipelineResult !== null) {
        if (pipelineResult !== rawReply) result.reply = pipelineResult
        if (timedOut) {
          const changed = pipelineResult !== rawReply ? 'used completed revision' : 'completed unchanged'
          process.stderr.write(`[ui-server] postprocess exceeded watchdog, ${changed}\n`)
        }
      }
    } catch (err) {
      clearTimeout(watchdog)
      process.stderr.write(`[ui-server] postprocess pipeline threw, keeping raw reply: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }

  // 正则脚本(ai_output 位):先把正文变成最终可见文本。MVU 随后只分析
  // 这份正文，并把机器块追加在正则处理之后，避免 ai_output 正则误伤变量块。
  result.reply = applyRegexScripts(
    state.regexScripts.list(), result.reply, 'ai_output',
    { user: getCurrentUserPersona(state)?.name ?? null, char: character.name },
  )

  // MVU is independent from the prose path. Emit and persist the prose first;
  // the variable call below may append its machine block asynchronously.
  const proseReply = result.reply

  // ST-Prompt-Template [RENDER:*] changes only what is displayed. Keep the
  // raw reply in SessionStore/history so reroll and future context do not
  // accidentally feed display decorations back into the model.
  const displayReply = applyWorldbookRenderDirectives(
    proseReply,
    wb?.plugin?.renderDirectives ?? [],
  )

  const assistantMessage = makeAssistantMessage(proseReply, rerollPrevious)
  session.appendMessage(sessionId, assistantMessage)
  // 持久化 assistant 消息到 history.jsonl(best-effort)
  try { await appendHistoryJsonl(sessionId, assistantMessage) } catch { /* swallow */ }
  await writeCurrentTurnStats(proseReply.length)
  const initialTokenStats = buildTurnStats(proseReply.length)
  const initialMvuState = readSessionMvuState(record, session.getHistory(sessionId), mvuMacros)?.statData

  const finalResult = {
    reply: proseReply,
    message: assistantMessage,
    ...(displayReply === proseReply ? {} : { displayReply }),
    sessionId,
    turn: session.turnCount(sessionId),
    usedWorldbook,
    usedContextSegmentation,
    ...(initialMvuState === undefined ? {} : { mvuState: initialMvuState }),
    ...(initialTokenStats ? { tokenStats: initialTokenStats } : {}),
  }
  // The final event deliberately precedes the independent MVU call so the
  // conversation area can render the prose immediately.
  sendStage({ name: 'final', status: 'done', result: finalResult })

  // Fire-and-forget ④. Send start now; done may arrive after res.end() (and
  // we'll silently drop it, by design — the front-end doesn't block on it).
  if (cfg.provider !== 'mock') {
    stageMeta.set('summarize', { deferred: true })
    seenStages.add('summarize')
    sendStage({ name: 'summarize', status: 'start' })
    const summarizeInput = {
      messages: [
        { role: 'user' as const, content: userInput },
        { role: 'assistant' as const, content: proseReply },
      ],
      character: { name: character.name, persona: character.persona },
    }
    const summarizeStarted = Date.now()
    const summarizeBefore = usageTracker.snapshot('summarize')
    void usageTracker.inStage('summarize', () => triggerSummarize(summarizeInput, agentCtx))
      .then(() => {
        if (!res.writableEnded) sendStage({ name: 'summarize', status: 'done' })
        const usageTotal = usageTracker.snapshot('summarize')
        sendTrace('summarize', summarizeInput, { completed: true }, Date.now() - summarizeStarted, subtractTokenUsage(usageTotal, summarizeBefore), usageTotal)
        if (turnStatsWritten) void writeCurrentTurnStats(result?.reply.length ?? proseReply.length)
      })
  }

  // MVU stays on this SSE connection so the browser can receive the state and
  // message patch, but it no longer delays the final prose event above.
  const currentMvu = readSessionMvuState(record, session.getHistory(sessionId), mvuMacros)
  if (state.mvuSettings.enabled && currentMvu !== undefined) {
    const mvuInput = {
      userInput,
      assistantReply: proseReply,
      statData: currentMvu.statData,
      character: { name: character.name },
    }
    const mvuResult = await runStageWithTrace('mvu', mvuInput, () => runMvuUpdate(
      {
        character,
        userInput,
        assistantReply: proseReply,
        statData: currentMvu.statData,
      },
      agentCtx,
      state.mvuSettings,
    ))

    let persistedReply = proseReply
    if (mvuResult !== null && mvuResult.update !== undefined) {
      persistedReply = `${proseReply.trimEnd()}\n\n${mvuResult.update}`
      result.reply = persistedReply
      const history = [...session.getHistory(sessionId)]
      const last = history[history.length - 1]
      if (last?.role === 'assistant') {
        history[history.length - 1] = syncAssistantSwipe(last, persistedReply)
        session.setHistory(sessionId, history)
        try { await rewriteHistoryJsonl(sessionId, history) } catch (err) {
          process.stderr.write(`[ui-server] warn: failed to persist MVU update for ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`)
        }
      }
    }

    const updatedMvuState = readSessionMvuState(record, session.getHistory(sessionId), mvuMacros)?.statData
    await writeCurrentTurnStats(persistedReply.length)
    const updatedTokenStats = buildTurnStats(persistedReply.length)
    if (!res.writableEnded) {
      writeSseEvent(res, 'mvu-result', {
        ...(persistedReply === proseReply ? {} : {
          reply: persistedReply,
          displayReply: applyWorldbookRenderDirectives(persistedReply, wb?.plugin?.renderDirectives ?? []),
        }),
        ...(updatedMvuState === undefined ? {} : { mvuState: updatedMvuState }),
        message: session.getHistory(sessionId).at(-1),
        tokenStats: updatedTokenStats,
      })
    }
  }

  // Flush on next tick so final/mvu-result events reach the client before close.
  setImmediate(() => res.end())
}

async function handleHistory(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId.length === 0) {
    return sendError(res, 400, 'sessionId query param is required')
  }
  if (!state.sessionRecords.has(sessionId)) {
    return sendError(res, 404, `session not found: ${sessionId}`)
  }
  const storedHistory = state.sessions.getHistory(sessionId)
  // The UI default remains the rendered view, but Tavern Helper/SillyTavern
  // context readers need the canonical stored `mes` text before display
  // regexes and [RENDER] directives. This keeps script context separate from
  // what the conversation surface happens to show.
  const history = url.searchParams.get('raw') === '1'
    ? storedHistory.map(message => ({ ...message }))
    : displayHistory(state, sessionId, storedHistory)
  const record = state.sessionRecords.get(sessionId)
  const mvuState = record === undefined
    ? undefined
    : readSessionMvuState(record, state.sessions.getHistory(sessionId), {
      user: getCurrentUserPersona(state)?.name ?? '用户',
      char: record.character.name,
    })?.statData
  sendJson(res, 200, {
    sessionId,
    history,
    turn: state.sessions.turnCount(sessionId),
    greetingIndex: record?.greetingIndex ?? 0,
    ...(mvuState === undefined ? {} : { mvuState }),
  })
}

/** Accept both the canonical Tavern Helper request and the legacy iframe
 * payload currently emitted by this project (`{ variables: { stat_data } }`). */
function parseSessionVariableMutation(raw: string): TavernHelperVariableMutationRequest {
  try {
    const parsed = parseTavernHelperMutationRequest(raw)
    if ('operation' in parsed) throw new Error('session variable endpoint accepts namespace replacements only')
    return parsed as TavernHelperVariableMutationRequest
  } catch (canonicalError) {
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { throw canonicalError }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw canonicalError
    const object = payload as Record<string, unknown>
    const source = object.variables ?? object.statData ?? object
    const statData = extractMvuStatData(source)
    if (statData === undefined || typeof statData !== 'object' || statData === null || Array.isArray(statData)) {
      throw canonicalError
    }
    return { format: 0, scope: 'chat', variables: { stat_data: statData } }
  }
}

function sessionVariablesPayload(
  state: AppState,
  record: SessionRecord,
): Record<string, unknown> {
  const helperState = ensureSessionTavernHelperState(record)
  const mvuState = readSessionMvuState(
    { ...record, tavernHelperState: helperState },
    state.sessions.getHistory(record.id),
    { user: getCurrentUserPersona(state)?.name ?? '用户', char: record.character.name },
  )?.statData
  return {
    sessionId: record.id,
    revision: helperState.revision,
    variableScopes: helperState.scopes,
    variables: helperState.scopes.chat,
    ...(mvuState === undefined ? {} : { mvuState }),
  }
}

/** GET /api/sessions/:id/variables — current session-owned namespaces. */
async function handleGetSessionVariables(state: AppState, id: string, res: ServerResponse): Promise<void> {
  const record = state.sessionRecords.get(id)
  if (record === undefined) return sendError(res, 404, `session not found: ${id}`)
  if (record.tavernHelperState === undefined) {
    const upgraded = { ...record, tavernHelperState: ensureSessionTavernHelperState(record) }
    state.sessionRecords.set(id, upgraded)
    try { await saveSession(state, upgraded) } catch { /* best effort upgrade */ }
    sendJson(res, 200, sessionVariablesPayload(state, upgraded))
    return
  }
  sendJson(res, 200, sessionVariablesPayload(state, record))
}

/** PUT/POST /api/sessions/:id/variables — persist one Tavern Helper namespace. */
async function handlePutSessionVariables(state: AppState, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = state.sessionRecords.get(id)
  if (record === undefined) return sendError(res, 404, `session not found: ${id}`)
  const raw = (await readBody(req, 2 * 1024 * 1024)).toString('utf8')
  let mutation: TavernHelperVariableMutationRequest
  try {
    mutation = parseSessionVariableMutation(raw)
  } catch (error: unknown) {
    return sendError(res, 400, error instanceof Error ? error.message : 'invalid session variable update')
  }
  const current = ensureSessionTavernHelperState(record)
  const nextHelperState = applyTavernHelperMutation(current, mutation)
  const directStatData = mutation.scope === 'chat' ? extractMvuStatData(mutation.variables) : undefined
  const nextRecord: SessionRecord = {
    ...record,
    tavernHelperState: nextHelperState,
    ...(directStatData === undefined ? {} : { mvuState: directStatData }),
  }
  state.sessionRecords.set(id, nextRecord)
  try {
    await saveSession(state, nextRecord)
  } catch (error: unknown) {
    state.sessionRecords.set(id, record)
    return sendError(res, 500, `failed to persist session variables: ${error instanceof Error ? error.message : String(error)}`)
  }
  sendJson(res, 200, sessionVariablesPayload(state, nextRecord))
}

/** PUT /api/sessions/:id/tavern-helper — apply one canonical Tavern Helper
 * mutation.  Variable updates keep using /variables for legacy cards; this
 * route exists for worldbook/chat/injection/script-tree operations that the
 * isolated JS-Slash-Runner bridge cannot safely serialize as executable code. */
async function handlePutSessionTavernHelper(
  state: AppState,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const record = state.sessionRecords.get(id)
  if (record === undefined) return sendError(res, 404, `session not found: ${id}`)
  let mutation: TavernHelperMutationRequest
  try {
    mutation = parseTavernHelperMutationRequest((await readBody(req, 2 * 1024 * 1024)).toString('utf8'))
  } catch (error: unknown) {
    return sendError(res, 400, error instanceof Error ? error.message : 'invalid Tavern Helper mutation')
  }
  const current = ensureSessionTavernHelperState(record)
  let nextHelperState: TavernHelperState
  try {
    nextHelperState = applyTavernHelperMutation(current, mutation)
  } catch (error: unknown) {
    return sendError(res, 400, error instanceof Error ? error.message : 'failed to apply Tavern Helper mutation')
  }
  const directStatData = 'scope' in mutation && mutation.scope === 'chat'
    ? extractMvuStatData(mutation.variables) : undefined
  const nextRecord: SessionRecord = {
    ...record,
    tavernHelperState: nextHelperState,
    ...(directStatData === undefined ? {} : { mvuState: directStatData }),
  }
  const previousHistory = [...state.sessions.getHistory(id)]
  let nextHistory = previousHistory
  let historyChanged = false
  if ('operation' in mutation) {
    if (mutation.operation === 'set-chat-messages') {
      nextHistory = [...previousHistory]
      for (const patch of mutation.messages) {
        const messageId = patch.message_id
        if (messageId === undefined) return sendError(res, 400, 'set-chat-messages requires message_id')
        const index = previousHistory.findIndex((message, messageIndex) => tavernMessageId(message, messageIndex) === messageId)
        if (index < 0) return sendError(res, 404, `set-chat-messages message_id not found: ${messageId}`)
        const current = previousHistory[index]
        if (current === undefined) return sendError(res, 404, `set-chat-messages message_id not found: ${messageId}`)
        nextHistory[index] = tavernChatMessageToInternal(patch, current)
      }
      historyChanged = mutation.messages.length > 0
    } else if (mutation.operation === 'create-chat-messages') {
      let insertAt: number
      try { insertAt = resolveTavernInsertIndex(previousHistory, mutation.insertAt) } catch (error: unknown) {
        return sendError(res, 400, error instanceof Error ? error.message : 'create-chat-messages insertAt is invalid')
      }
      nextHistory = [
        ...previousHistory.slice(0, insertAt),
        ...mutation.messages.map(message => tavernChatMessageToInternal(message)),
        ...previousHistory.slice(insertAt),
      ]
      historyChanged = mutation.messages.length > 0
    } else if (mutation.operation === 'delete-chat-messages') {
      const indices = chatIndicesForIds(previousHistory, mutation.messageIds)
      nextHistory = previousHistory.filter((_, index) => !indices.has(index))
      historyChanged = nextHistory.length !== previousHistory.length
    } else if (mutation.operation === 'rotate-chat-messages') {
      nextHistory = rotateChatHistory(previousHistory, mutation.begin, mutation.middle, mutation.end)
      historyChanged = JSON.stringify(nextHistory) !== JSON.stringify(previousHistory)
    } else if (mutation.operation === 'set-chat-hidden') {
      if (mutation.end > previousHistory.length) return sendError(res, 400, 'set-chat-hidden end is out of range')
      nextHistory = previousHistory.map((message, index) => index >= mutation.start && index < mutation.end
        ? { ...message, is_hidden: mutation.hidden }
        : message)
      historyChanged = true
    }
  }
  if (historyChanged) {
    state.sessions.setHistory(id, nextHistory)
    try { await rewriteHistoryJsonl(id, nextHistory) } catch (error: unknown) {
      state.sessions.setHistory(id, previousHistory)
      return sendError(res, 500, `failed to persist Tavern Helper chat mutation: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  state.sessionRecords.set(id, nextRecord)
  try {
    await saveSession(state, nextRecord)
    if ('operation' in mutation && (
      mutation.operation === 'replace-worldbook'
      || mutation.operation === 'delete-worldbook'
      || mutation.operation === 'bind-global-worldbooks'
      || mutation.operation === 'bind-character-worldbooks'
      || mutation.operation === 'bind-chat-worldbook'
    )) {
      ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, record.characterId, id)
    }
  } catch (error: unknown) {
    state.sessionRecords.set(id, record)
    if (historyChanged) state.sessions.setHistory(id, previousHistory)
    return sendError(res, 500, `failed to persist Tavern Helper mutation: ${error instanceof Error ? error.message : String(error)}`)
  }
  sendJson(res, 200, {
    ...sessionVariablesPayload(state, nextRecord),
    tavernHelperState: nextHelperState,
    operation: 'operation' in mutation ? mutation.operation : undefined,
    refresh: 'refresh' in mutation ? mutation.refresh : undefined,
    history: historyChanged ? nextHistory : undefined,
    ...(nextHelperState.worldbookBindings === undefined ? {} : { worldbookBindings: nextHelperState.worldbookBindings }),
  })
}

/** GET /api/sessions/:id/tavern-helper — read the canonical bridge snapshot
 * for iframe RPCs.  Unlike /variables this intentionally includes script-owned
 * worldbooks and bindings, because cards use it to implement updater callbacks
 * before sending a validated replacement mutation back to the host. */
function handleGetSessionTavernHelper(state: AppState, id: string, res: ServerResponse): void {
  const record = state.sessionRecords.get(id)
  if (record === undefined) return sendError(res, 404, `session not found: ${id}`)
  const helperState = ensureSessionTavernHelperState(record)
  sendJson(res, 200, {
    ...sessionVariablesPayload(state, record),
    tavernHelperState: helperState,
  })
}

/** POST /api/sessions/:id/tavern-helper/generate-raw — one isolated
 * Tavern Helper generation. It deliberately does not append a floor or enter
 * intent/worldbook/context/response/postprocess/MVU, matching ST's helper
 * escape hatch for scripts that need a private auxiliary completion. */
async function handleTavernGenerateRaw(state: AppState, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!state.sessionRecords.has(id)) return sendError(res, 404, `session not found: ${id}`)
  let request: ReturnType<typeof parseTavernGenerateRawRequest>
  try {
    const payload = parseJsonBody(await readBody(req, 8 * 1024 * 1024))
    request = parseTavernGenerateRawRequest(payload)
  } catch (error: unknown) {
    return sendError(res, 400, error instanceof Error ? error.message : 'invalid generateRaw request')
  }
  try {
    const result = await generateTavernRaw(resolveProvider(getGlobalConfig(state)), request)
    sendJson(res, 200, {
      content: result.content,
      text: result.content,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      shouldSilence: request.should_silence === true,
    })
  } catch (error: unknown) {
    sendError(res, 502, `generateRaw failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** PUT /api/sessions/:id/greeting — replace the active opening greeting. */
async function handlePutSessionGreeting(state: AppState, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = state.sessionRecords.get(id)
  if (record === undefined) return sendError(res, 404, `session not found: ${id}`)
  const payload = parseJsonBody(await readBody(req, 16 * 1024))
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const greetingIndex = parseGreetingIndex(readField(payload, 'greetingIndex'), record.character)
  if (greetingIndex === null) return sendError(res, 400, 'greetingIndex is out of range')

  const greeting = substituteUserCharMacros(
    greetingAt(record.character, greetingIndex),
    getCurrentUserPersona(state)?.name ?? null,
    record.character.name,
  )
  const history = [...state.sessions.getHistory(id)]
  const first = history[0]
  let nextHistory: typeof history
  if (first?.role === 'assistant') {
    nextHistory = greeting.length > 0
      ? [makeAssistantMessage(greeting), ...history.slice(1)]
      : history.slice(1)
  } else if (greeting.length > 0) {
    nextHistory = [makeAssistantMessage(greeting), ...history]
  } else {
    nextHistory = history
  }
  state.sessions.setHistory(id, nextHistory)
  const nextRecord: SessionRecord = { ...record, greetingIndex }
  state.sessionRecords.set(id, nextRecord)
  try { await rewriteHistoryJsonl(id, nextHistory) } catch { /* best-effort persistence */ }
  try { await saveSession(state, nextRecord) } catch { /* best-effort persistence */ }
  const mvuState = readSessionMvuState(record, nextHistory, {
    user: getCurrentUserPersona(state)?.name ?? '用户',
    char: record.character.name,
  })?.statData
  sendJson(res, 200, {
    sessionId: id,
    greetingIndex,
    history: displayHistory(state, id, nextHistory),
    ...(mvuState === undefined ? {} : { mvuState }),
  })
}

async function handleSession(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 256 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')

  // 酒馆风格:客户端优先发 characterId(从 /api/characters 列表拿),
  // 后端从 state.characters 查 PreprocessedCharacter,保证用最新 import 的数据。
  // Fallback:客户端也可以发完整的 character(老路径,导入时还没刷到 state 时用)。
  let characterId = readStringField(payload, 'characterId')
  let character: PreprocessedCharacter | null = null
  if (characterId !== undefined) {
    const rec = state.characters.get(characterId as CharacterId)
    if (rec === undefined) return sendError(res, 404, `character not found: ${characterId}`)
    character = rec.preprocessed
  } else {
    const characterJson = readField(payload, 'character')
    if (characterJson === undefined) return sendError(res, 400, 'characterId or character is required')
    const parsed = parseCharacterField(characterJson)
    if (parsed === null) return sendError(res, 400, 'invalid character field')
    character = parsed
    characterId = safeFileName(parsed.name)
  }
  if (character === null) return sendError(res, 400, 'character is null')

  const label = readStringField(payload, 'label') ?? autoLabel(character)
  const firstMesOverride = readStringField(payload, 'firstMes')
  const greetingIndexRaw = readField(payload, 'greetingIndex')
  const greetingIndex = greetingIndexRaw === undefined
    ? 0
    : parseGreetingIndex(greetingIndexRaw, character)
  if (greetingIndex === null) return sendError(res, 400, 'greetingIndex is out of range')
  const selectedGreeting = greetingAt(character, greetingIndex)
  const sessionId = await createSession(
    state,
    character,
    characterId as CharacterId,
    label,
    greetingIndexRaw === undefined ? firstMesOverride : selectedGreeting,
    greetingIndex,
  )
  // 把刚创建的会话设为当前,这样前端切完角色再建会话,UI 立刻有内容可看
  state.currentSessionId = sessionId
  try { await writeStateJson(state) } catch { /* swallow */ }
  sendJson(res, 200, {
    sessionId,
    characterId,
    character: serializeCharacter(character),
    label,
    greetingIndex,
    createdAt: state.sessionRecords.get(sessionId)?.createdAt ?? new Date().toISOString(),
  })
}

function handleListSessions(state: AppState, res: ServerResponse): void {
  const list = [...state.sessionRecords.values()].map(r => ({
    sessionId: r.id,
    label: r.label,
    characterId: r.characterId,
    characterName: r.character.name,
    createdAt: r.createdAt,
    turnCount: state.sessions.turnCount(r.id),
  }))
  sendJson(res, 200, { sessions: list })
}

/** MemorySessionStore 没有删除 API(SessionStore 接口只增不删)。删会话时
 *  通过清掉其内部 history / counter 条目来释放该会话的内存。字段在
 *  session.ts 里是 private,这里用结构化断言访问(运行时字段名一致)。 */
function clearSessionHistory(store: MemorySessionStore, sessionId: string): void {
  const internal = store as unknown as {
    histories?: Map<string, unknown[]>
    counter?: Map<string, number>
  }
  internal.histories?.delete(sessionId)
  internal.counter?.delete(sessionId)
}

/** GET /api/sessions/:id/traces — 读 `sessions/<id>/traces.jsonl`。
 *  ?name=intent 只返回该 stage;?limit=50 只返回最后 N 条(按落盘顺序)。
 *  会话存在但 traces.jsonl 不存在时返回空数组(还没说过话的正常情况)。 */
async function handleGetSessionTraces(state: AppState, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!state.sessionRecords.has(id)) return sendError(res, 404, `session not found: ${id}`)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const nameFilter = url.searchParams.get('name')
  const limitRaw = url.searchParams.get('limit')
  let limit = Number.POSITIVE_INFINITY
  if (limitRaw !== null) {
    const n = Number.parseInt(limitRaw, 10)
    if (Number.isNaN(n) || n <= 0) return sendError(res, 400, `invalid limit: ${limitRaw}`)
    limit = n
  }
  const traces: Array<Record<string, unknown>> = []
  try {
    const text = await readFile(join(ABS_SESSIONS_DIR, id, 'traces.jsonl'), 'utf-8')
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        const obj = JSON.parse(line) as Record<string, unknown>
        if (nameFilter !== null && obj.name !== nameFilter) continue
        traces.push(obj)
      } catch {
        // 跳过坏行,不阻塞整个 traces 加载。
      }
    }
  } catch {
    // 文件不存在 = 还没有 trace,正常情况。
  }
  const result = Number.isFinite(limit) ? traces.slice(-limit) : traces
  const turnStats = await readTurnStats(id)
  sendJson(res, 200, { sessionId: id, total: traces.length, traces: result, turnStats })
}

/** DELETE /api/sessions/:id — 删会话:内存 record / MemorySessionStore 历史 /
 *  磁盘 sessions/<id>/ 目录一并清掉;若它正被选中,清空 currentSessionId 并落盘 state。 */
async function handleDeleteSession(state: AppState, id: string, res: ServerResponse): Promise<void> {
  if (!state.sessionRecords.has(id)) return sendError(res, 404, `session not found: ${id}`)
  state.sessionRecords.delete(id)
  clearSessionHistory(state.sessions, id)
  try {
    await rm(join(ABS_SESSIONS_DIR, id), { recursive: true, force: true })
  } catch (err) {
    // 磁盘删失败不让内存状态回滚(会话已从运行时移除),只警告。
    process.stderr.write(`[ui-server] warn: failed to remove session dir ${id}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  if (state.currentSessionId === id) {
    state.currentSessionId = null
    try { await writeStateJson(state) } catch { /* swallow */ }
  }
  sendJson(res, 200, { id, deleted: true })
}

/** PATCH /api/sessions/:id — body { label } 重命名会话(内存 + meta.json)。 */
async function handlePatchSession(state: AppState, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rec = state.sessionRecords.get(id)
  if (rec === undefined) return sendError(res, 404, `session not found: ${id}`)
  const body = await readBody(req, 16 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const label = readStringField(payload, 'label')
  if (label === undefined || label.trim().length === 0) {
    return sendError(res, 400, 'label (non-empty string) is required')
  }
  const next: SessionRecord = { ...rec, label: label.trim() }
  state.sessionRecords.set(id, next)
  try {
    await saveSession(state, next)
  } catch (err) {
    process.stderr.write(`[ui-server] warn: failed to persist session ${id} rename: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  sendJson(res, 200, { sessionId: id, label: next.label })
}

/** DELETE /api/sessions/:id/message/:index — 删除单条消息(内存 + jsonl 重写)。
 *  index 是 0-based,对应 GET /api/history 返回数组的下标。 */
async function handleDeleteMessage(state: AppState, id: string, indexRaw: string, res: ServerResponse): Promise<void> {
  if (state.sessionRecords.get(id) === undefined) return sendError(res, 404, `session not found: ${id}`)
  const index = Number.parseInt(indexRaw, 10)
  if (!Number.isInteger(index)) return sendError(res, 400, `invalid message index: ${indexRaw}`)
  const history = [...state.sessions.getHistory(id)]
  if (index < 0 || index >= history.length) {
    return sendError(res, 404, `message index out of range: ${index} (history length ${history.length})`)
  }
  const next = history.filter((_, i) => i !== index)
  state.sessions.setHistory(id, next)
  try {
    await rewriteHistoryJsonl(id, next)
  } catch (err) {
    process.stderr.write(`[ui-server] warn: failed to rewrite history for ${id}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  sendJson(res, 200, { sessionId: id, deletedIndex: index, remaining: next.length })
}

/** PUT /api/sessions/:id/message/:index — 编辑单条消息内容。 */
async function handlePutMessage(state: AppState, id: string, indexRaw: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = state.sessionRecords.get(id)
  if (record === undefined) return sendError(res, 404, `session not found: ${id}`)
  const index = Number.parseInt(indexRaw, 10)
  if (!Number.isInteger(index)) return sendError(res, 400, `invalid message index: ${indexRaw}`)
  const payload = parseJsonBody(await readBody(req, 32 * 1024 * 1024))
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const content = readStringField(payload, 'content')
  if (content === undefined) return sendError(res, 400, 'content (string) is required')

  const history = [...state.sessions.getHistory(id)]
  if (index < 0 || index >= history.length) {
    return sendError(res, 404, `message index out of range: ${index} (history length ${history.length})`)
  }
  const current = history[index]
  if (current === undefined) return sendError(res, 404, `message index out of range: ${index}`)
  // SillyTavern's Run on Edit gate is evaluated at the edited message's
  // history depth.  Normal/prompt-only scripts may update the stored prompt;
  // markdown-only scripts remain display-only and are applied by the UI.
  const placement: RegexPlacement = current.role === 'assistant' ? 'ai_output' : 'user_input'
  const editedContent = applyRegexScripts(
    state.regexScripts.list(),
    content,
    placement,
    { user: getCurrentUserPersona(state)?.name ?? null, char: record.character.name },
    { depth: history.length - index - 1, isEdit: true, surface: 'prompt' },
  )
  history[index] = current.role === 'assistant'
    ? syncAssistantSwipe(current, editedContent)
    : { ...current, content: editedContent }
  state.sessions.setHistory(id, history)
  try {
    await rewriteHistoryJsonl(id, history)
  } catch (err) {
    process.stderr.write(`[ui-server] warn: failed to rewrite history for ${id}: ${err instanceof Error ? err.message : String(err)}\n`)
  }

  const mvuState = readSessionMvuState(record, history, {
    user: getCurrentUserPersona(state)?.name ?? '用户',
    char: record.character.name,
  })?.statData
  sendJson(res, 200, {
    sessionId: id,
    updatedIndex: index,
    history: displayHistory(state, id, history),
    ...(mvuState === undefined ? {} : { mvuState }),
  })
}

/** PUT /api/sessions/:id/message/:index/swipe — select an existing ST swipe. */
async function handlePutMessageSwipe(state: AppState, id: string, indexRaw: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const record = state.sessionRecords.get(id)
  if (record === undefined) return sendError(res, 404, `session not found: ${id}`)
  const index = Number.parseInt(indexRaw, 10)
  if (!Number.isInteger(index)) return sendError(res, 400, `invalid message index: ${indexRaw}`)
  const payload = parseJsonBody(await readBody(req, 16 * 1024))
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const rawSwipeId = readField(payload, 'swipeId')
  const swipeId = typeof rawSwipeId === 'number' ? rawSwipeId : Number(rawSwipeId)
  if (!Number.isSafeInteger(swipeId)) return sendError(res, 400, 'swipeId must be an integer')

  const history = [...state.sessions.getHistory(id)]
  const current = history[index]
  if (current === undefined || current.role !== 'assistant') return sendError(res, 400, 'only assistant messages support swipes')
  const swipes = Array.isArray(current.swipes) && current.swipes.length > 0 ? [...current.swipes] : [current.content]
  if (swipeId < 0 || swipeId >= swipes.length) return sendError(res, 400, `swipeId out of range: ${swipeId}`)
  const swipeInfo = Array.isArray(current.swipe_info) ? [...current.swipe_info] : swipes.map(() => swipeInfoNow())
  while (swipeInfo.length < swipes.length) swipeInfo.push(swipeInfoNow())
  history[index] = { ...current, content: swipes[swipeId] ?? '', swipe_id: swipeId, swipes, swipe_info: swipeInfo }
  state.sessions.setHistory(id, history)
  try { await rewriteHistoryJsonl(id, history) } catch (err) {
    process.stderr.write(`[ui-server] warn: failed to rewrite swipe for ${id}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  const mvuState = readSessionMvuState(record, history, {
    user: getCurrentUserPersona(state)?.name ?? '用户',
    char: record.character.name,
  })?.statData
  sendJson(res, 200, {
    sessionId: id,
    updatedIndex: index,
    swipeId,
    history: displayHistory(state, id, history),
    ...(mvuState === undefined ? {} : { mvuState }),
  })
}

function handleHealth(state: AppState, res: ServerResponse): void {
  const cfg = getGlobalConfig(state)
  sendJson(res, 200, {
    provider: cfg.provider === 'mock' ? 'mock' : 'openai-compatible',
    model: cfg.model,
    usingMock: cfg.provider === 'mock',
    worldbookEntries: state.worldbook.list().length,
    sessionCount: state.sessionRecords.size,
    characterCount: state.characters.size,
  })
}

// ─── /api/state — 整局状态(启动时一次性拉) ──────────────────────────────

function handleGetState(state: AppState, res: ServerResponse): void {
  const cfg = maskConfig(getGlobalConfig(state))
  const characters = [...state.characters.values()].map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    hasLorebook: r.preprocessed.lorebook !== undefined,
    lorebookName: r.preprocessed.lorebook?.name ?? null,
    personaPreview: r.preprocessed.persona.slice(0, 60),
    greetingCount: 1 + r.preprocessed.alternateGreetings.length,
  }))
  // 按 updatedAt 倒序:最近 import 的在最上面
  characters.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  sendJson(res, 200, {
    config: cfg,
    characters,
    currentCharacterId: state.currentCharacterId,
    currentSessionId: state.currentSessionId,
  })
}

// ─── /api/characters — 酒馆风格的角色库 ─────────────────────────────────

function handleListCharacters(state: AppState, res: ServerResponse): void {
  const list = [...state.characters.values()].map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    hasLorebook: r.preprocessed.lorebook !== undefined,
    lorebookName: r.preprocessed.lorebook?.name ?? null,
    personaPreview: r.preprocessed.persona.slice(0, 60),
  }))
  list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  sendJson(res, 200, { characters: list, currentCharacterId: state.currentCharacterId })
}

function handleGetCharacter(state: AppState, id: CharacterId, res: ServerResponse): void {
  const rec = state.characters.get(id)
  if (rec === undefined) return sendError(res, 404, `character not found: ${id}`)
  sendJson(res, 200, {
    id: rec.id,
    name: rec.name,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    // The library list stays compact, while the detail endpoint mirrors
    // Tavern's RawCharacter contract for card frontends and helper scripts.
    character: serializeCharacter(rec.preprocessed, { includeRaw: true }),
  })
}

async function handleSelectCharacter(state: AppState, id: CharacterId, res: ServerResponse): Promise<void> {
  const rec = state.characters.get(id)
  if (rec === undefined) return sendError(res, 404, `character not found: ${id}`)
  state.currentCharacterId = id
  // 酒馆范式:切角色时清掉当前会话(因为会话绑定角色,留旧会话的引用没意义)
  // 但不删除磁盘上的会话,只是不再"自动选中"它
  state.currentSessionId = null
  // 切角色时按新角色的"全局世界书启用列表"重新 build worldbook store
  ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, id)
  await writeStateJson(state)
  sendJson(res, 200, {
    currentCharacterId: state.currentCharacterId,
    currentSessionId: state.currentSessionId,
    character: serializeCharacter(rec.preprocessed, { includeRaw: true }),
  })
}

/** 列出该角色下的所有会话(按 createdAt 倒序) */
function handleListCharacterSessions(state: AppState, id: CharacterId, res: ServerResponse): void {
  const rec = state.characters.get(id)
  if (rec === undefined) return sendError(res, 404, `character not found: ${id}`)
  const sessions = [...state.sessionRecords.values()]
    .filter(r => r.characterId === id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(r => ({
      sessionId: r.id,
      label: r.label,
      characterName: r.character.name,
      createdAt: r.createdAt,
      turnCount: state.sessions.turnCount(r.id),
    }))
  sendJson(res, 200, { characterId: id, sessions, currentSessionId: state.currentSessionId })
}

/** 列出该角色内嵌世界书的全部 entry(从 memory 中读,无需扫盘) */
function handleGetCharacterWorldbook(state: AppState, id: CharacterId, res: ServerResponse): void {
  const rec = state.characters.get(id)
  if (rec === undefined) return sendError(res, 404, `character not found: ${id}`)
  const book = rec.preprocessed.lorebook
  if (book === undefined) {
    sendJson(res, 200, { characterId: id, hasLorebook: false, entries: [], totalCount: 0 })
    return
  }
  const entries = [...book.entries]
    .sort((a, b) => a.insertionOrder - b.insertionOrder)
    .map(e => ({
      sourceId: e.sourceId,
      name: e.name ?? null,
      keys: [...e.keys],
      secondaryKeys: [...e.secondaryKeys],
      content: e.content,
      enabled: e.enabled,
      insertionOrder: e.insertionOrder,
      selective: e.selective,
      constant: e.constant,
      caseSensitive: e.caseSensitive,
      matchWholeWords: e.matchWholeWords,
      useRegex: e.useRegex,
      selectiveLogic: e.secondaryLogic,
      probability: e.probability ?? 100,
      useProbability: e.useProbability ?? true,
      position: e.position,
      stPosition: e.stPosition ?? (e.position === 'before_char' ? 0 : 1),
      priority: e.priority ?? null,
    }))
  sendJson(res, 200, {
    characterId: id,
    hasLorebook: true,
    lorebookName: book.name ?? null,
    entries,
    totalCount: book.entries.length,
    enabledCount: book.entries.filter(e => e.enabled).length,
  })
}

/** PATCH /api/characters/:id/worldbook/:sourceId
 *  body: { enabled: boolean }
 *  切换某条 entry 的 enabled 状态,重跑 preprocess(基础人设 vs 动态分类会变)并重新合并 worldbook。 */
async function handlePatchCharacterWorldbookEntry(
  state: AppState,
  id: CharacterId,
  sourceId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const rec = state.characters.get(id)
  if (rec === undefined) return sendError(res, 404, `character not found: ${id}`)
  const book = rec.preprocessed.lorebook
  if (book === undefined) return sendError(res, 404, `character has no lorebook: ${id}`)
  const body = await readBody(req, 16 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const enabledRaw = (payload as Record<string, unknown>).enabled
  if (typeof enabledRaw !== 'boolean') return sendError(res, 400, 'enabled (boolean) is required')

  const idx = book.entries.findIndex(e => e.sourceId === sourceId)
  if (idx < 0) return sendError(res, 404, `entry not found: ${sourceId}`)
  // ImportedLorebookEntry 是 readonly,需要构造新数组
  const newEntries = book.entries.map((e, i) => i === idx ? { ...e, enabled: enabledRaw } : e)
  const newBook: ImportedLorebook = { ...book, entries: newEntries }
  // 重新走 preprocess(因为 enabled 改了可能影响 dynamicLorebookEntries 划分)
  // 关键:必须用 rec.preprocessed.raw(完整原卡)+ 新的 lorebook
  const updated = preprocessCharacterCard({ ...rec.preprocessed.raw, lorebook: newBook })
  const newRec: CharacterRecord = { ...rec, preprocessed: updated, updatedAt: new Date().toISOString() }
  state.characters.set(id, newRec)
  // 写盘 meta.json + lorebook.json + preprocessed.json
  try {
    await saveCharacter(state, updated, null)
  } catch (err) {
    return sendError(res, 500, `failed to persist: ${err instanceof Error ? err.message : String(err)}`)
  }
  // 只有当前角色的书被改时才 rebuild —— 合并结果始终跟随 currentCharacterId,
  // 改别的角色的条目不应把当前生效的世界书池切走。
  if (state.currentCharacterId === id) {
    ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, id)
  }
  sendJson(res, 200, {
    characterId: id,
    sourceId,
    enabled: enabledRaw,
    // 顺手返回这条 entry 的新归属,前端可以立即更新
    classification: classifyLorebookEntry(newEntries[idx] ?? newEntries[0] as never),
  })
}

// ─── 角色对独立世界书的启用选择 (per-character) ─────────────────────────

/** 从 `characters/<id>/worldbook_config.json` 读角色"显式禁用"的独立世界书 id 集合。
 *  文件不存在 = 默认全启用(返回 undefined 让调用方用 fallback)。 */
async function loadCharacterWorldbookConfig(id: CharacterId): Promise<CharacterWorldbookConfig | undefined> {
  const path = join(ABS_CHARACTERS_DIR, id, 'worldbook_config.json')
  try {
    const raw = await readFile(path, 'utf-8')
    const obj = JSON.parse(raw) as { disabledBookIds?: string[] }
    if (Array.isArray(obj.disabledBookIds)) {
      return { disabledBookIds: new Set(obj.disabledBookIds) }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 写 `characters/<id>/worldbook_config.json`。 */
async function saveCharacterWorldbookConfig(id: CharacterId, cfg: CharacterWorldbookConfig): Promise<void> {
  const dir = join(ABS_CHARACTERS_DIR, id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'worldbook_config.json')
  await writeFile(path, JSON.stringify({ disabledBookIds: [...cfg.disabledBookIds] }, null, 2), 'utf-8')
}

/** GET /api/characters/:id/worldbook-config
 *  返回该角色"启用哪些独立世界书"。默认全启用。 */
async function handleGetCharacterWorldbookConfig(state: AppState, id: CharacterId, res: ServerResponse): Promise<void> {
  const rec = state.characters.get(id)
  if (rec === undefined) return sendError(res, 404, `character not found: ${id}`)
  const cfg = state.characterWorldbookConfigs.get(id)
  const allImported = [...state.importedWorldbooks.keys()].sort()
  // 计算 effective enabled(去掉 disabled 的)
  const disabled = cfg?.disabledBookIds ?? new Set<string>()
  const effectiveEnabled = allImported.filter((b) => !disabled.has(b))
  sendJson(res, 200, {
    characterId: id,
    allImported,
    enabledBookIds: effectiveEnabled,
    disabledBookIds: [...disabled],
    isDefault: cfg === undefined,
  })
}

/** PUT /api/characters/:id/worldbook-config
 *  body: { disabledBookIds: string[] }
 *  设置该角色"显式禁用"的独立世界书列表(不在 list 里的书 = 启用)。 */
async function handlePutCharacterWorldbookConfig(state: AppState, id: CharacterId, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rec = state.characters.get(id)
  if (rec === undefined) return sendError(res, 404, `character not found: ${id}`)
  const body = await readBody(req, 64 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const arr = (payload as Record<string, unknown>).disabledBookIds
  if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) {
    return sendError(res, 400, 'disabledBookIds (string[]) is required')
  }
  const ids = [...new Set(arr as string[])]
  // 过滤掉不存在的书(防止引用已删的书)
  const validIds = ids.filter((x) => state.importedWorldbooks.has(x))
  const cfg: CharacterWorldbookConfig = { disabledBookIds: new Set(validIds) }
  state.characterWorldbookConfigs.set(id, cfg)
  // 持久化(best-effort)
  try {
    await saveCharacterWorldbookConfig(id, cfg)
  } catch (err) {
    process.stderr.write(`[ui-server] warn: failed to persist worldbook_config for ${id}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  // 如果改的是当前角色,重新 build worldbook
  if (state.currentCharacterId === id) {
    ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, id)
  }
  sendJson(res, 200, {
    characterId: id,
    disabledBookIds: validIds,
    isDefault: false,
  })
}

// ─── /api/config — get / put the runtime API config ──────────────────────────

function handleGetConfig(state: AppState, res: ServerResponse): void {
  sendJson(res, 200, maskConfig(getGlobalConfig(state)))
}

async function handlePutConfig(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 64 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const override = parseConfigField(payload)
  if (override === null) return sendError(res, 400, 'invalid config field')

  const current = getGlobalConfig(state)
  const next = mergeConfig(current, override)
  // A PUT without a new apiKey (or one carrying the sentinel) must not clobber
  // the existing key — the UI re-uses the wire '***' placeholder when the
  // user hasn't typed anything.
  if (override.apiKey === undefined || override.apiKey === MASKED_KEY) {
    next.apiKey = current.apiKey
  }
  try {
    await saveApiConfig(next)
  } catch (err) {
    return sendError(res, 500, `failed to persist API config: ${err instanceof Error ? err.message : String(err)}`)
  }
  state.configs.set(CONFIG_KEY_DEFAULT, next)
  sendJson(res, 200, maskConfig(next))
}

// ─── /api/prompts — 列出/读取/修改 agent prompt 模板 ──────────────────────

/** 扫描 `src/agent-loop/prompts/*.md`,返回 prompt 名(文件名去掉 .md)。 */
async function listPromptNames(): Promise<string[]> {
  if (!existsSync(ABS_PROMPTS_DIR)) return []
  const files = await readdir(ABS_PROMPTS_DIR)
  return files
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))
    .sort()
}

async function handleListPrompts(state: AppState, res: ServerResponse): Promise<void> {
  const names = await listPromptNames()
  const prompts = await Promise.all(names.map(async (name) => {
    try {
      const content = await readFile(join(ABS_PROMPTS_DIR, `${name}.md`), 'utf-8')
      // modifiedAt 没法简单拿(st_mtime),用 content hash 前 8 位当 "id"
      const len = content.length
      // 判断是否被 override 改过(看 in-memory map,目前没存 hash,统一报 false)
      const overridden = state.promptOverrides.has(name)
      return { name, length: len, overridden }
    } catch {
      return { name, length: 0, overridden: false }
    }
  }))
  sendJson(res, 200, { prompts })
}

async function handleGetPrompt(_state: AppState, name: string, res: ServerResponse): Promise<void> {
  // 优先返回内存 override(未来扩展),fallback 到磁盘
  if (_state.promptOverrides.has(name)) {
    sendJson(res, 200, { name, content: _state.promptOverrides.get(name) ?? '', source: 'override' })
    return
  }
  try {
    const content = await readFile(join(ABS_PROMPTS_DIR, `${name}.md`), 'utf-8')
    sendJson(res, 200, { name, content, source: 'disk' })
  } catch {
    sendError(res, 404, `prompt not found: ${name}`)
  }
}

async function handlePutPrompt(state: AppState, name: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 防御:不让名字里带路径分隔符,避免越权写到 prompts/ 之外
  if (!/^[a-zA-Z0-9_-]+$/u.test(name)) {
    return sendError(res, 400, 'invalid prompt name (only [a-zA-Z0-9_-] allowed)')
  }
  const body = await readBody(req, 256 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const content = readStringField(payload, 'content')
  if (content === undefined) return sendError(res, 400, 'content is required')
  try {
    await mkdir(ABS_PROMPTS_DIR, { recursive: true })
    await writeFile(join(ABS_PROMPTS_DIR, `${name}.md`), content, 'utf-8')
    state.promptOverrides.set(name, content)
    sendJson(res, 200, { name, length: content.length, source: 'override' })
  } catch (err) {
    sendError(res, 500, `failed to write prompt: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ─── /api/extensions — SillyTavern-compatible adapter registry ─────────────

function parseExtensionId(value: unknown): ExtensionId | undefined {
  return value === 'tavern-helper' || value === 'prompt-template' ? value : undefined
}

function handleListExtensions(state: AppState, res: ServerResponse): void {
  sendJson(res, 200, {
    extensions: state.extensions.list(),
    updatePolicy: 'manual',
    executionPolicy: 'bundled-adapter-only',
  })
}

async function handleCheckExtensions(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = parseJsonBody(await readBody(req, 16 * 1024))
  const id = parseExtensionId(payload?.id)
  try {
    const extensions = await state.extensions.check(id)
    sendJson(res, 200, { extensions })
  } catch (error) {
    sendError(res, 502, `failed to check extension updates: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function handleUpdateExtension(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = parseJsonBody(await readBody(req, 16 * 1024))
  const id = parseExtensionId(payload?.id)
  if (id === undefined) return sendError(res, 400, 'id must be tavern-helper or prompt-template')
  try {
    const result = await state.extensions.update(id)
    sendJson(res, 200, result)
  } catch (error) {
    sendError(res, 502, `failed to update extension: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function handleActivateExtension(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = parseJsonBody(await readBody(req, 16 * 1024))
  const id = parseExtensionId(payload?.id)
  const version = readStringField(payload ?? {}, 'version')?.trim()
  if (id === undefined) return sendError(res, 400, 'id must be tavern-helper or prompt-template')
  if (version === undefined || version.length === 0) return sendError(res, 400, 'version is required')
  try {
    const status = await state.extensions.activate(id, version)
    sendJson(res, 200, { status })
  } catch (error) {
    sendError(res, 409, `failed to activate extension version: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function handleRollbackExtension(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = parseJsonBody(await readBody(req, 16 * 1024))
  const id = parseExtensionId(payload?.id)
  if (id === undefined) return sendError(res, 400, 'id must be tavern-helper or prompt-template')
  try {
    const status = await state.extensions.rollback(id)
    sendJson(res, 200, { status })
  } catch (error) {
    sendError(res, 409, `failed to rollback extension: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ─── /api/models — list available models from the configured provider ────────

async function handleGetModels(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const stored = getGlobalConfig(state)

  // Query parameters take precedence so the UI can pull a model list *before*
  // saving anything to the stored config.
  const queryProviderRaw = url.searchParams.get('provider')
  const queryBaseUrl = url.searchParams.get('baseUrl')
  const queryApiKeyRaw = url.searchParams.get('apiKey')
  const queryApiKey = queryApiKeyRaw === MASKED_KEY ? null : queryApiKeyRaw
  const queryModel = url.searchParams.get('model')

  let provider: ApiProvider
  if (queryProviderRaw === 'openai' || queryProviderRaw === 'mock') {
    provider = queryProviderRaw
  } else if (queryProviderRaw === null) {
    provider = stored.provider
  } else {
    return sendError(res, 400, `invalid provider: ${queryProviderRaw}`)
  }
  const baseUrl = queryBaseUrl ?? stored.baseUrl
  const apiKey = queryApiKey ?? stored.apiKey
  // `model` is accepted for symmetry with PUT — the models endpoint doesn't
  // narrow on it, but a client may pass it to "echo" the dropdown selection.
  void queryModel

  if (provider === 'mock') {
    const models = MOCK_MODELS.map(m => ({ id: m.id }))
    sendJson(res, 200, {
      models,
      raw: { object: 'list', data: models, source: 'mock' },
    })
    return
  }

  const listUrl = `${baseUrl.replace(/\/+$/u, '')}/models`
  let resp: Response
  try {
    resp = await fetch(listUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    })
  } catch (err) {
    return sendError(res, 502, `failed to reach ${listUrl}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return sendError(res, resp.status, `models request failed: ${resp.status} ${resp.statusText} — ${text.slice(0, 500)}`)
  }
  const data = await resp.json() as { data?: Array<{ id: string } & Record<string, unknown>> }
  const models = Array.isArray(data.data) ? data.data : []
  sendJson(res, 200, { models, raw: data })
}

// ─────────────────────────────────────────────────────────────────────────────
// Small utilities used by the handlers
// ─────────────────────────────────────────────────────────────────────────────

// ─── 持久化 helper ──────────────────────────────────────────────────────────
//
// 目录结构(启动时扫描重建):
//   characters/<id>/
//     ├── meta.json          # { id, name, createdAt, updatedAt, hasLorebook, lorebookName }
//     ├── preprocessed.json  # PreprocessedCharacter(去掉 raw.data 的"瘦身"版,加载后按需重包)
//     ├── lorebook.json      # ImportedLorebook(可空:无内嵌世界书时整个文件不写)
//     └── original.png       # 从 PNG 导入时存的原始字节(重新加载走原路径,字符不丢)
//   sessions/<id>/
//     ├── meta.json          # { id, characterId, label, createdAt }
//     └── history.jsonl      # 每行 { role: 'user'|'assistant', content: string }
//   ui-server-state.json     # { currentCharacterId: string|null, currentSessionId: string|null }
//
// 写盘是 best-effort:失败抛错给上层(返回 5xx),不静默丢数据。
// 读盘是 best-effort:单个角色/会话损坏不阻塞其他恢复,只打 warning 到 stderr。

/** 把一个角色写到 `characters/<id>/`。会覆盖 preprocessed.json / lorebook.json;
 *  meta.json 的 createdAt 若已存在则保留,只刷新 updatedAt。 */
async function saveCharacter(state: AppState, preprocessed: PreprocessedCharacter, originalPng: Buffer | null): Promise<CharacterRecord> {
  const id = safeFileName(preprocessed.name)
  const dir = join(ABS_CHARACTERS_DIR, id)
  await mkdir(dir, { recursive: true })

  const existing = state.characters.get(id)
  const createdAt = existing?.createdAt ?? new Date().toISOString()
  const updatedAt = new Date().toISOString()
  const meta = {
    id,
    name: preprocessed.name,
    createdAt,
    updatedAt,
    hasLorebook: preprocessed.lorebook !== undefined,
    lorebookName: preprocessed.lorebook?.name ?? null,
  }
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')

  // preprocessed.json 完整序列化(包含 raw 整张原卡,体积可能大,但酒馆也是这么存)。
  await writeFile(join(dir, 'preprocessed.json'), JSON.stringify(preprocessed, null, 2), 'utf-8')

  if (preprocessed.lorebook !== undefined) {
    await writeFile(join(dir, 'lorebook.json'), JSON.stringify(preprocessed.lorebook, null, 2), 'utf-8')
  } else {
    // 移除旧的 lorebook.json(角色卡可能从有世界书换成没的)。
    await unlink(join(dir, 'lorebook.json')).catch(() => undefined)
  }

  if (originalPng !== null) {
    await writeFile(join(dir, 'original.png'), originalPng)
  }

  const record: CharacterRecord = {
    id,
    name: preprocessed.name,
    createdAt,
    updatedAt,
    preprocessed,
  }
  state.characters.set(id, record)
  return record
}

/** Read the session-owned variable envelope. Invalid optional variable data is
 * ignored so an old/broken variables file cannot make the whole chat vanish. */
async function loadSessionVariables(sessionId: string): Promise<Pick<SessionRecord, 'mvuState' | 'tavernHelperState' | 'worldbookTimedEffects'>> {
  try {
    const raw = await readFile(join(ABS_SESSIONS_DIR, sessionId, 'variables.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const mvuState = parsed.mvuState === undefined ? undefined : normalizeMvuJsonValue(parsed.mvuState)
    let tavernHelperState: TavernHelperState | undefined
    if (typeof parsed.tavernHelperState === 'string') {
      try { tavernHelperState = decodeTavernHelperState(parsed.tavernHelperState) } catch { /* ignore invalid optional state */ }
    }
    const worldbookTimedEffects = normalizeTimedEffectState(parsed.worldbookTimedEffects)
    return {
      ...(mvuState === undefined ? {} : { mvuState }),
      ...(tavernHelperState === undefined ? {} : { tavernHelperState }),
      ...(Object.keys(worldbookTimedEffects).length === 0 ? {} : { worldbookTimedEffects }),
    }
  } catch {
    return {}
  }
}

/** Persist only session variables; the transcript remains in history.jsonl. */
async function saveSessionVariables(record: SessionRecord): Promise<void> {
  const envelope: PersistedSessionVariables = {
    format: 0,
    ...(record.mvuState === undefined ? {} : { mvuState: snapshotJsonValue(record.mvuState) as JsonValue }),
    ...(record.tavernHelperState === undefined
      ? {}
      : { tavernHelperState: encodeTavernHelperState(record.tavernHelperState) }),
    ...(record.worldbookTimedEffects === undefined
      ? {}
      : { worldbookTimedEffects: record.worldbookTimedEffects }),
  }
  const path = join(ABS_SESSIONS_DIR, record.id, 'variables.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(envelope, null, 2), 'utf-8')
}

/** 把一个会话写到 `sessions/<id>/`。 */
async function saveSession(_state: AppState, record: SessionRecord): Promise<void> {
  const dir = join(ABS_SESSIONS_DIR, record.id)
  await mkdir(dir, { recursive: true })
  const meta = {
    id: record.id,
    characterId: record.characterId,
    label: record.label,
    createdAt: record.createdAt,
    greetingIndex: record.greetingIndex,
  }
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
  await saveSessionVariables(record)
}

/** 追加一条消息到 `sessions/<id>/history.jsonl`。 */
async function appendHistoryJsonl(sessionId: string, message: ChatMessage): Promise<void> {
  const path = join(ABS_SESSIONS_DIR, sessionId, 'history.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(message)}\n`, { encoding: 'utf-8', flag: 'a' })
}

/** 整体重写 `sessions/<id>/history.jsonl`(删消息 / 重 roll 截断后调用)。 */
async function rewriteHistoryJsonl(sessionId: string, messages: readonly ChatMessage[]): Promise<void> {
  const path = join(ABS_SESSIONS_DIR, sessionId, 'history.jsonl')
  await mkdir(dirname(path), { recursive: true })
  // Keep ST swipe metadata when deleting/editing/selecting a floor.  Reducing
  // messages to role/content here would silently erase every alternative on
  // the next restart.
  const body = messages.map(m => JSON.stringify(m)).join('\n')
  await writeFile(path, messages.length > 0 ? `${body}\n` : '', 'utf-8')
}

/** 重 roll 前置:校验并截掉最后一条 assistant 消息(内存 + jsonl),
 *  返回该轮的 user 输入(重跑链路直接复用,不再重复 append)。
 *  不满足条件(空历史 / 末条非 assistant / 截断后无 user)返回 null。 */
async function truncateForReroll(
  state: AppState,
  sessionId: string,
): Promise<{ userInput: string; previousAssistant: ChatMessage } | null> {
  const history = [...state.sessions.getHistory(sessionId)]
  const last = history[history.length - 1]
  if (last === undefined || last.role !== 'assistant') return null
  const truncated = history.slice(0, -1)
  let lastUser: string | null = null
  for (let i = truncated.length - 1; i >= 0; i--) {
    const m = truncated[i]
    if (m?.role === 'user') { lastUser = m.content; break }
  }
  if (lastUser === null || lastUser.length === 0) return null
  state.sessions.setHistory(sessionId, truncated)
  try { await rewriteHistoryJsonl(sessionId, truncated) } catch { /* swallow */ }
  return { userInput: lastUser, previousAssistant: last }
}

/** Read the last revision for every generation in a session. The deferred
 *  imagery extractor may append a second revision after the assistant text
 *  has already been delivered. */
async function readTurnStats(sessionId: string): Promise<TurnStatsRecord[]> {
  const latest = new Map<string, TurnStatsRecord>()
  try {
    const text = await readFile(join(ABS_SESSIONS_DIR, sessionId, TURN_STATS_FILE), 'utf-8')
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        const value = JSON.parse(line) as Partial<TurnStatsRecord>
        if (typeof value.runId !== 'string' || typeof value.turn !== 'number') continue
        if (value.total === undefined || value.agents === undefined) continue
        latest.set(value.runId, value as TurnStatsRecord)
      } catch {
        // Skip a damaged line; the next revision remains usable.
      }
    }
  } catch {
    // Missing file means the session predates token statistics.
  }
  return [...latest.values()]
}

async function appendTurnStatsJsonl(sessionId: string, record: TurnStatsRecord): Promise<void> {
  const path = join(ABS_SESSIONS_DIR, sessionId, TURN_STATS_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', flag: 'a' })
}

function userTurnNumber(session: MemorySessionStore, sessionId: string): number {
  return session.getHistory(sessionId).filter(m => m.role === 'user').length
}

function sumTokenUsage(values: readonly TokenUsageStats[]): TokenUsageStats {
  const total = cloneTokenUsage(EMPTY_TOKEN_USAGE)
  for (const value of values) {
    total.promptTokens += value.promptTokens
    total.completionTokens += value.completionTokens
    total.totalTokens += value.totalTokens
    total.calls += value.calls
    total.estimated = total.estimated || value.estimated
  }
  return total
}

async function findReusableTurn(
  sessionId: string,
  turn: number,
  userInput: string,
): Promise<TurnStatsRecord | null> {
  const candidates = (await readTurnStats(sessionId))
    .filter(record => record.turn === turn && record.userInput === userInput && record.reusable !== undefined)
  const current = candidates[candidates.length - 1]
  if (current !== undefined) return current

  // Backward compatibility: sessions created before token stats can still
  // reroll without paying for intent/worldbook again. Their old traces already
  // contain both structured outputs, although their turn number included the
  // opening greeting, so match by the stored userInput instead of turn.
  try {
    const text = await readFile(join(ABS_SESSIONS_DIR, sessionId, 'traces.jsonl'), 'utf-8')
    let legacyIntent: import('./schema.ts').IntentOutput | null = null
    let legacyWorldbook: import('./schema.ts').WorldbookMatchOutput | null = null
    let legacyContext: import('./schema.ts').ContextSegmentOutput | null = null
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        const trace = JSON.parse(line) as { name?: unknown; inputJson?: unknown; outputJson?: unknown }
        if (typeof trace.inputJson !== 'string' || typeof trace.outputJson !== 'string') continue
        const input = JSON.parse(trace.inputJson) as { userInput?: unknown }
        if (input.userInput !== userInput) continue
        const output = JSON.parse(trace.outputJson) as unknown
        if (trace.name === 'intent' && output !== null && typeof output === 'object') {
          legacyIntent = output as import('./schema.ts').IntentOutput
        } else if (trace.name === 'worldbook' && output !== null && typeof output === 'object'
          && Array.isArray((output as { matches?: unknown }).matches)) {
          legacyWorldbook = output as import('./schema.ts').WorldbookMatchOutput
        } else if (trace.name === 'context' && output !== null && typeof output === 'object'
          && Array.isArray((output as { segments?: unknown }).segments)) {
          legacyContext = output as import('./schema.ts').ContextSegmentOutput
        }
      } catch {
        // Old trace may be truncated; keep looking for a complete pair.
      }
    }
    if (legacyIntent !== null && legacyWorldbook !== null) {
      return {
        runId: `legacy-${sessionId}-${turn}`,
        turn,
        reroll: false,
        ts: new Date().toISOString(),
        userInput,
        assistantLength: 0,
        total: cloneTokenUsage(EMPTY_TOKEN_USAGE),
        agents: {},
        reusable: {
          intent: legacyIntent,
          worldbook: legacyWorldbook,
          ...(legacyContext !== null ? { context: legacyContext } : {}),
        },
      }
    }
  } catch {
    // No legacy trace file; reroll falls back to a full pipeline.
  }
  return null
}

/** 单条 agent trace 的落盘格式(`sessions/<id>/traces.jsonl` 每行一个 JSON)。 */
interface TraceRecord {
  /** 第几轮对话(与 final 事件上报的 turn 对齐)。 */
  turn: number
  /** stage 名:intent / worldbook / context / response。 */
  name: string
  /** 序列化 + 截断后的输入(与 SSE `agent-trace` 事件同款截断串)。 */
  inputJson: string
  /** 序列化 + 截断后的输出。 */
  outputJson: string
  /**
   * 实际发送给 provider 的完整请求(messages + options)。与 input/output
   * 摘要分开保存，专供提示词审计；不做 TRACE_MAX_CHARS 截断。
   */
  promptJson?: string
  durationMs: number
  runId: string
  reroll: boolean
  usage: AgentTokenStats
  usageTotal: TokenUsageStats
  reused?: boolean
  reusedFromRunId?: string
  /** ISO 时间戳。 */
  ts: string
}

/** 追加一条 agent trace 记录到 `sessions/<id>/traces.jsonl`(best-effort,调用方吞错)。 */
async function appendTraceJsonl(sessionId: string, record: TraceRecord): Promise<void> {
  const path = join(ABS_SESSIONS_DIR, sessionId, 'traces.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', flag: 'a' })
}

/** 把 `currentCharacterId / currentSessionId` 写到根目录的 `ui-server-state.json`。 */
async function writeStateJson(state: AppState): Promise<void> {
  const payload = {
    currentCharacterId: state.currentCharacterId,
    currentSessionId: state.currentSessionId,
    currentPersonaId: state.currentPersonaId,
  }
  await writeFile(ABS_STATE_JSON, JSON.stringify(payload, null, 2), 'utf-8')
}

// ─── /api/personas — 用户 persona(酒馆 {{user}}) ───────────────────────────

// ─── /api/worldbook-settings — 世界书全局设置(酒馆 world_info_depth 对应物) ──

/** 从 worldbook-settings.json 读设置;文件缺失/损坏/字段非法时回退
 *  (scanDepth=2, mode=enhanced)。旧文件只有 useLlmMatcher 时仍可读取。 */
async function loadWorldbookSettings(): Promise<WorldbookSettings> {
  try {
    const raw = await readFile(ABS_WORLDBOOK_SETTINGS_JSON, 'utf-8')
    const obj = JSON.parse(raw) as {
      scanDepth?: unknown; useLlmMatcher?: unknown; mode?: unknown; budgetPercent?: unknown; budgetCap?: unknown
      minActivations?: unknown; minActivationsDepthMax?: unknown; recursive?: unknown
      maxRecursionSteps?: unknown; includeNames?: unknown; useGroupScoring?: unknown
    }
    const scanDepth = typeof obj.scanDepth === 'number' && Number.isInteger(obj.scanDepth)
      && obj.scanDepth >= 0 && obj.scanDepth <= 100
      ? obj.scanDepth
      : DEFAULT_WORLDBOOK_SETTINGS.scanDepth
    const mode: WorldbookMatchMode = obj.mode === 'strict' || obj.mode === 'enhanced' || obj.mode === 'native'
      ? obj.mode
      : obj.useLlmMatcher === false ? 'strict' : 'enhanced'
    const budgetPercent = typeof obj.budgetPercent === 'number' && Number.isFinite(obj.budgetPercent)
      ? Math.min(100, Math.max(0, obj.budgetPercent)) : DEFAULT_WORLDBOOK_SETTINGS.budgetPercent ?? 25
    const budgetCap = typeof obj.budgetCap === 'number' && Number.isFinite(obj.budgetCap)
      ? Math.min(2_000_000, Math.max(0, Math.trunc(obj.budgetCap))) : DEFAULT_WORLDBOOK_SETTINGS.budgetCap ?? 0
    const minActivations = typeof obj.minActivations === 'number' && Number.isInteger(obj.minActivations)
      ? Math.min(1_000, Math.max(0, obj.minActivations)) : DEFAULT_WORLDBOOK_SETTINGS.minActivations ?? 0
    const minActivationsDepthMax = typeof obj.minActivationsDepthMax === 'number' && Number.isInteger(obj.minActivationsDepthMax)
      ? Math.min(1_000, Math.max(0, obj.minActivationsDepthMax)) : DEFAULT_WORLDBOOK_SETTINGS.minActivationsDepthMax ?? 0
    const maxRecursionSteps = typeof obj.maxRecursionSteps === 'number' && Number.isInteger(obj.maxRecursionSteps)
      ? Math.min(1_000, Math.max(0, obj.maxRecursionSteps)) : DEFAULT_WORLDBOOK_SETTINGS.maxRecursionSteps ?? 0
    const recursive = typeof obj.recursive === 'boolean' ? obj.recursive : DEFAULT_WORLDBOOK_SETTINGS.recursive ?? false
    const includeNames = typeof obj.includeNames === 'boolean' ? obj.includeNames : DEFAULT_WORLDBOOK_SETTINGS.includeNames ?? true
    const useGroupScoring = typeof obj.useGroupScoring === 'boolean'
      ? obj.useGroupScoring : DEFAULT_WORLDBOOK_SETTINGS.useGroupScoring ?? false
    return {
      scanDepth, useLlmMatcher: mode !== 'strict', mode, budgetPercent, budgetCap,
      minActivations, minActivationsDepthMax, recursive, maxRecursionSteps, includeNames, useGroupScoring,
    }
  } catch {
    return { ...DEFAULT_WORLDBOOK_SETTINGS }
  }
}

/** GET /api/worldbook-settings — 返回当前世界书全局设置。 */
function handleGetWorldbookSettings(state: AppState, res: ServerResponse): void {
  sendJson(res, 200, { ...state.worldbookSettings })
}

// ─── /api/postprocess-settings — ⑤ 后处理开关 ──────────────────────────

function handleGetPostprocessSettings(state: AppState, res: ServerResponse): void {
  sendJson(res, 200, postprocessSettingsResponse(state))
}

async function handlePutPostprocessSettings(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 16 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  if (payload.presetId !== undefined) {
    if (typeof payload.presetId !== 'string') return sendError(res, 400, 'presetId must be a string')
    const preset = state.postprocessSettings.presets.find(item => item.id === payload.presetId)
    if (preset === undefined) return sendError(res, 404, 'postprocess preset not found')
    state.postprocessSettings = {
      ...preset.config,
      activePresetId: preset.id,
      presets: state.postprocessSettings.presets,
    }
  } else {
    const current = state.postprocessSettings
    const next = normalizedPostprocessConfig({ ...current, ...payload, modelOverrides: payload.modelOverrides ?? current.modelOverrides })
    state.postprocessSettings = {
      ...next,
      activePresetId: current.activePresetId,
      presets: current.presets,
    }
  }
  await savePostprocessSettings(state.postprocessSettings)
  sendJson(res, 200, postprocessSettingsResponse(state))
}

async function handleCreatePostprocessPreset(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 16 * 1024)
  const payload = parseJsonBody(body)
  const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
  if (name === '' || name.length > 80) return sendError(res, 400, 'preset name must be 1-80 characters')
  const now = Date.now()
  const preset: PostprocessPreset = {
    id: `pp-${randomUUID()}`,
    name,
    config: normalizedPostprocessConfig(state.postprocessSettings),
    createdAt: now,
    updatedAt: now,
  }
  state.postprocessSettings = {
    ...state.postprocessSettings,
    activePresetId: preset.id,
    presets: [...state.postprocessSettings.presets, preset],
  }
  await savePostprocessSettings(state.postprocessSettings)
  sendJson(res, 200, postprocessSettingsResponse(state))
}

async function handleUpdatePostprocessPreset(state: AppState, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const preset = state.postprocessSettings.presets.find(item => item.id === id)
  if (preset === undefined) return sendError(res, 404, 'postprocess preset not found')
  const body = await readBody(req, 16 * 1024)
  const payload = parseJsonBody(body) ?? {}
  const name = payload.name === undefined ? preset.name : typeof payload.name === 'string' ? payload.name.trim() : ''
  if (name === '' || name.length > 80) return sendError(res, 400, 'preset name must be 1-80 characters')
  const updated: PostprocessPreset = {
    ...preset,
    name,
    config: normalizedPostprocessConfig(state.postprocessSettings),
    updatedAt: Date.now(),
  }
  state.postprocessSettings = {
    ...state.postprocessSettings,
    activePresetId: id,
    presets: state.postprocessSettings.presets.map(item => item.id === id ? updated : item),
  }
  await savePostprocessSettings(state.postprocessSettings)
  sendJson(res, 200, postprocessSettingsResponse(state))
}

async function handleDeletePostprocessPreset(state: AppState, id: string, res: ServerResponse): Promise<void> {
  if (id === 'default') return sendError(res, 400, '默认预设不能删除')
  if (!state.postprocessSettings.presets.some(item => item.id === id)) return sendError(res, 404, 'postprocess preset not found')
  const presets = state.postprocessSettings.presets.filter(item => item.id !== id)
  const deletingActive = state.postprocessSettings.activePresetId === id
  const defaultPreset = presets.find(item => item.id === 'default')
  state.postprocessSettings = deletingActive && defaultPreset !== undefined
    ? { ...defaultPreset.config, activePresetId: 'default', presets }
    : { ...state.postprocessSettings, activePresetId: state.postprocessSettings.activePresetId, presets }
  await savePostprocessSettings(state.postprocessSettings)
  sendJson(res, 200, postprocessSettingsResponse(state))
}

// ─── /api/mvu-settings — 独立 MVU 变量处理模型/预设 ───────────────────────

function handleGetMvuSettings(state: AppState, res: ServerResponse): void {
  sendJson(res, 200, mvuSettingsResponse(state))
}

async function handlePutMvuSettings(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 16 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  if (payload.presetId !== undefined) {
    if (typeof payload.presetId !== 'string') return sendError(res, 400, 'presetId must be a string')
    const preset = state.mvuSettings.presets.find(item => item.id === payload.presetId)
    if (preset === undefined) return sendError(res, 404, 'mvu preset not found')
    state.mvuSettings = {
      ...preset.config,
      activePresetId: preset.id,
      presets: state.mvuSettings.presets,
    }
  } else {
    const current = state.mvuSettings
    const next = normalizedMvuConfig({ ...current, ...payload })
    state.mvuSettings = {
      ...next,
      activePresetId: current.activePresetId,
      presets: current.presets,
    }
  }
  await saveMvuSettings(state.mvuSettings)
  sendJson(res, 200, mvuSettingsResponse(state))
}

async function handleCreateMvuPreset(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = parseJsonBody(await readBody(req, 16 * 1024))
  const name = typeof payload?.name === 'string' ? payload.name.trim() : ''
  if (name === '' || name.length > 80) return sendError(res, 400, 'preset name must be 1-80 characters')
  const now = Date.now()
  const preset: MvuPreset = {
    id: `mvu-${randomUUID()}`,
    name,
    config: normalizedMvuConfig(state.mvuSettings),
    createdAt: now,
    updatedAt: now,
  }
  state.mvuSettings = {
    ...state.mvuSettings,
    activePresetId: preset.id,
    presets: [...state.mvuSettings.presets, preset],
  }
  await saveMvuSettings(state.mvuSettings)
  sendJson(res, 200, mvuSettingsResponse(state))
}

async function handleUpdateMvuPreset(state: AppState, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const preset = state.mvuSettings.presets.find(item => item.id === id)
  if (preset === undefined) return sendError(res, 404, 'mvu preset not found')
  const payload = parseJsonBody(await readBody(req, 16 * 1024)) ?? {}
  const name = payload.name === undefined ? preset.name : typeof payload.name === 'string' ? payload.name.trim() : ''
  if (name === '' || name.length > 80) return sendError(res, 400, 'preset name must be 1-80 characters')
  const updated: MvuPreset = {
    ...preset,
    name,
    config: normalizedMvuConfig(state.mvuSettings),
    updatedAt: Date.now(),
  }
  state.mvuSettings = {
    ...state.mvuSettings,
    activePresetId: id,
    presets: state.mvuSettings.presets.map(item => item.id === id ? updated : item),
  }
  await saveMvuSettings(state.mvuSettings)
  sendJson(res, 200, mvuSettingsResponse(state))
}

async function handleDeleteMvuPreset(state: AppState, id: string, res: ServerResponse): Promise<void> {
  if (id === 'default') return sendError(res, 400, '默认预设不能删除')
  if (!state.mvuSettings.presets.some(item => item.id === id)) return sendError(res, 404, 'mvu preset not found')
  const presets = state.mvuSettings.presets.filter(item => item.id !== id)
  const deletingActive = state.mvuSettings.activePresetId === id
  const defaultPreset = presets.find(item => item.id === 'default')
  state.mvuSettings = deletingActive && defaultPreset !== undefined
    ? { ...defaultPreset.config, activePresetId: 'default', presets }
    : { ...state.mvuSettings, presets }
  await saveMvuSettings(state.mvuSettings)
  sendJson(res, 200, mvuSettingsResponse(state))
}

// ─── /api/response-settings — 正文人称与字数 ────────────────────────────────

function handleGetResponseSettings(state: AppState, res: ServerResponse): void {
  sendJson(res, 200, { ...state.responseSettings })
}

async function handlePutResponseSettings(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = parseJsonBody(await readBody(req, 16 * 1024))
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  state.responseSettings = normalizeResponseSettings(payload, state.responseSettings)
  try {
    await saveResponseSettings(state.responseSettings)
  } catch (err) {
    return sendError(res, 500, `failed to persist response settings: ${err instanceof Error ? err.message : String(err)}`)
  }
  sendJson(res, 200, { ...state.responseSettings })
}

/** PUT /api/worldbook-settings — body 支持 scanDepth、mode、budgetPercent、budgetCap、
 * minActivations、minActivationsDepthMax、recursive、maxRecursionSteps、includeNames、useGroupScoring。
 *  scanDepth = 绿灯匹配扫描的最近消息条数(酒馆 world_info_depth,默认 2)。
 *  其余全局字段对应酒馆 World Info 的 min activations、递归、书名扫描和包含组打分选项。
 *  useLlmMatcher 保留为旧客户端兼容字段。写盘 best-effort。 */
async function handlePutWorldbookSettings(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 16 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const scanDepthRaw = payload.scanDepth
  if (scanDepthRaw !== undefined
    && (typeof scanDepthRaw !== 'number' || !Number.isInteger(scanDepthRaw) || scanDepthRaw < 0 || scanDepthRaw > 100)) {
    return sendError(res, 400, 'scanDepth must be an integer in [0, 100]')
  }
  const useLlmMatcherRaw = payload.useLlmMatcher
  if (useLlmMatcherRaw !== undefined && typeof useLlmMatcherRaw !== 'boolean') {
    return sendError(res, 400, 'useLlmMatcher must be a boolean')
  }
  const modeRaw = payload.mode
  if (modeRaw !== undefined && modeRaw !== 'strict' && modeRaw !== 'enhanced' && modeRaw !== 'native') {
    return sendError(res, 400, 'mode must be strict, enhanced, or native')
  }
  const budgetPercentRaw = payload.budgetPercent
  if (budgetPercentRaw !== undefined
    && (typeof budgetPercentRaw !== 'number' || !Number.isFinite(budgetPercentRaw) || budgetPercentRaw < 0 || budgetPercentRaw > 100)) {
    return sendError(res, 400, 'budgetPercent must be a number in [0, 100]')
  }
  const budgetCapRaw = payload.budgetCap
  if (budgetCapRaw !== undefined
    && (typeof budgetCapRaw !== 'number' || !Number.isInteger(budgetCapRaw) || budgetCapRaw < 0 || budgetCapRaw > 2_000_000)) {
    return sendError(res, 400, 'budgetCap must be an integer in [0, 2000000]')
  }
  const minActivationsRaw = payload.minActivations
  if (minActivationsRaw !== undefined
    && (typeof minActivationsRaw !== 'number' || !Number.isInteger(minActivationsRaw) || minActivationsRaw < 0 || minActivationsRaw > 1_000)) {
    return sendError(res, 400, 'minActivations must be an integer in [0, 1000]')
  }
  const minActivationsDepthMaxRaw = payload.minActivationsDepthMax
  if (minActivationsDepthMaxRaw !== undefined
    && (typeof minActivationsDepthMaxRaw !== 'number' || !Number.isInteger(minActivationsDepthMaxRaw) || minActivationsDepthMaxRaw < 0 || minActivationsDepthMaxRaw > 1_000)) {
    return sendError(res, 400, 'minActivationsDepthMax must be an integer in [0, 1000]')
  }
  const maxRecursionStepsRaw = payload.maxRecursionSteps
  if (maxRecursionStepsRaw !== undefined
    && (typeof maxRecursionStepsRaw !== 'number' || !Number.isInteger(maxRecursionStepsRaw) || maxRecursionStepsRaw < 0 || maxRecursionStepsRaw > 1_000)) {
    return sendError(res, 400, 'maxRecursionSteps must be an integer in [0, 1000]')
  }
  for (const [key, value] of [
    ['recursive', payload.recursive],
    ['includeNames', payload.includeNames],
    ['useGroupScoring', payload.useGroupScoring],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') return sendError(res, 400, `${key} must be a boolean`)
  }
  const mode: WorldbookMatchMode = modeRaw === 'strict' || modeRaw === 'enhanced' || modeRaw === 'native'
    ? modeRaw
    : useLlmMatcherRaw === false ? 'strict' : state.worldbookSettings.mode ?? 'enhanced'
  const next: WorldbookSettings = {
    scanDepth: typeof scanDepthRaw === 'number' ? scanDepthRaw : state.worldbookSettings.scanDepth,
    useLlmMatcher: mode !== 'strict',
    mode,
    budgetPercent: typeof budgetPercentRaw === 'number'
      ? budgetPercentRaw : state.worldbookSettings.budgetPercent ?? DEFAULT_WORLDBOOK_SETTINGS.budgetPercent ?? 25,
    budgetCap: typeof budgetCapRaw === 'number'
      ? budgetCapRaw : state.worldbookSettings.budgetCap ?? DEFAULT_WORLDBOOK_SETTINGS.budgetCap ?? 0,
    minActivations: typeof minActivationsRaw === 'number'
      ? minActivationsRaw : state.worldbookSettings.minActivations ?? DEFAULT_WORLDBOOK_SETTINGS.minActivations ?? 0,
    minActivationsDepthMax: typeof minActivationsDepthMaxRaw === 'number'
      ? minActivationsDepthMaxRaw : state.worldbookSettings.minActivationsDepthMax ?? DEFAULT_WORLDBOOK_SETTINGS.minActivationsDepthMax ?? 0,
    maxRecursionSteps: typeof maxRecursionStepsRaw === 'number'
      ? maxRecursionStepsRaw : state.worldbookSettings.maxRecursionSteps ?? DEFAULT_WORLDBOOK_SETTINGS.maxRecursionSteps ?? 0,
    recursive: typeof payload.recursive === 'boolean'
      ? payload.recursive : state.worldbookSettings.recursive ?? DEFAULT_WORLDBOOK_SETTINGS.recursive ?? false,
    includeNames: typeof payload.includeNames === 'boolean'
      ? payload.includeNames : state.worldbookSettings.includeNames ?? DEFAULT_WORLDBOOK_SETTINGS.includeNames ?? true,
    useGroupScoring: typeof payload.useGroupScoring === 'boolean'
      ? payload.useGroupScoring : state.worldbookSettings.useGroupScoring ?? DEFAULT_WORLDBOOK_SETTINGS.useGroupScoring ?? false,
  }
  state.worldbookSettings = next
  try {
    await writeFile(ABS_WORLDBOOK_SETTINGS_JSON, JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    process.stderr.write(`[ui-server] warn: failed to persist worldbook settings: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  sendJson(res, 200, { ...next })
}

// ─── /api/personas(续) ─────────────────────────────────────────────────────

/** 当前生效的用户 persona(给 response agent 注入用)。未选中返回 null。 */
function getCurrentUserPersona(state: AppState): { name: string; description: string } | null {
  const id = state.currentPersonaId
  if (id === null) return null
  const p = state.personas.get(id)
  return p === undefined ? null : { name: p.name, description: p.description }
}

function handleListPersonas(state: AppState, res: ServerResponse): void {
  sendJson(res, 200, { personas: state.personas.list(), currentPersonaId: state.currentPersonaId })
}

async function handleCreatePersona(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 64 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const name = readStringField(payload, 'name')
  if (name === undefined || name.trim().length === 0) return sendError(res, 400, 'name is required')
  const description = readStringField(payload, 'description') ?? ''
  try {
    const persona = await state.personas.save(name.trim(), description)
    sendJson(res, 200, { persona })
  } catch (err) {
    sendError(res, 500, `failed to save persona: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleUpdatePersona(state: AppState, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const existing = state.personas.get(id)
  if (existing === undefined) return sendError(res, 404, `persona not found: ${id}`)
  const body = await readBody(req, 64 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const name = readStringField(payload, 'name')?.trim()
  if (name !== undefined && name.length === 0) return sendError(res, 400, 'name cannot be empty')
  const description = readStringField(payload, 'description')
  try {
    const persona = await state.personas.save(
      name ?? existing.name,
      description ?? existing.description,
      id,
    )
    // 改的是当前 persona 时,后续轮次自动用新名字/描述(注入在 run 时实时取)。
    sendJson(res, 200, { persona })
  } catch (err) {
    sendError(res, 500, `failed to save persona: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleDeletePersona(state: AppState, id: string, res: ServerResponse): Promise<void> {
  const ok = await state.personas.delete(id)
  if (!ok) return sendError(res, 404, `persona not found: ${id}`)
  if (state.currentPersonaId === id) {
    state.currentPersonaId = null
    try { await writeStateJson(state) } catch { /* swallow */ }
  }
  sendJson(res, 200, { id, deleted: true })
}

async function handleSelectPersona(state: AppState, id: string, res: ServerResponse): Promise<void> {
  if (state.personas.get(id) === undefined) return sendError(res, 404, `persona not found: ${id}`)
  state.currentPersonaId = id
  try { await writeStateJson(state) } catch { /* swallow */ }
  sendJson(res, 200, { currentPersonaId: id })
}

// ─── /api/regex — 全局正则脚本(酒馆 Regex 扩展) ────────────────────────────

function handleListRegexScripts(state: AppState, res: ServerResponse): void {
  sendJson(res, 200, { scripts: state.regexScripts.list() })
}

async function handleCreateRegexScript(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 64 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  try {
    const script = state.regexScripts.create(payload)
    sendJson(res, 200, { script })
  } catch (err) {
    sendError(res, 400, String(err instanceof Error ? err.message : err))
  }
}

async function handleUpdateRegexScript(state: AppState, id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (state.regexScripts.get(id) === undefined) return sendError(res, 404, `regex script not found: ${id}`)
  const body = await readBody(req, 64 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  try {
    const script = state.regexScripts.update(id, payload)
    if (script === null) return sendError(res, 404, `regex script not found: ${id}`)
    sendJson(res, 200, { script })
  } catch (err) {
    sendError(res, 400, String(err instanceof Error ? err.message : err))
  }
}

function handleDeleteRegexScript(state: AppState, id: string, res: ServerResponse): void {
  if (!state.regexScripts.delete(id)) return sendError(res, 404, `regex script not found: ${id}`)
  sendJson(res, 200, { id, deleted: true })
}

/** POST /api/regex-test — 试跑:body { text, placement? } → 应用后的文本。
 *  宏上下文取当前 persona + 当前角色(和真实运行时一致)。 */
async function handleTestRegexScripts(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, 256 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const text = readStringField(payload, 'text')
  if (text === undefined) return sendError(res, 400, 'text is required')
  const placementRaw = readStringField(payload, 'placement') ?? 'display'
  const placement: RegexPlacement =
    (['user_input', 'ai_output', 'display', 'world_info'] as const).includes(placementRaw as never)
      ? placementRaw as RegexPlacement
      : 'display'
  const charRec = state.currentCharacterId !== null ? state.characters.get(state.currentCharacterId) : undefined
  const result = applyRegexScripts(
    state.regexScripts.list(), text, placement,
    { user: getCurrentUserPersona(state)?.name ?? null, char: charRec?.name ?? null },
  )
  sendJson(res, 200, { input: text, result, placement })
}

/** 从磁盘读一个角色目录,返回 CharacterRecord 或 null(损坏时返回 null + 警告)。 */
async function loadCharacterFromDisk(id: CharacterId): Promise<CharacterRecord | null> {
  const dir = join(ABS_CHARACTERS_DIR, id)
  let meta: { id: string; name: string; createdAt: string; updatedAt: string }
  try {
    const raw = await readFile(join(dir, 'meta.json'), 'utf-8')
    meta = JSON.parse(raw) as typeof meta
  } catch {
    return null
  }
  let preprocessed: PreprocessedCharacter
  let migrated = false
  try {
    const raw = await readFile(join(dir, 'preprocessed.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PreprocessedCharacter>
    // 信任条件:新格式存档必须带 dynamicLorebookEntries、constantLorebookEntries
    // **且**三个新字段 (mesExample / systemPrompt / postHistoryInstructions)。缺任一 = 老存档:
    // 用存的 raw 重新跑 preprocessCharacterCard 迁移(效果等同重新 import,
    // 保留 createdAt)。迁移后蓝灯条目进入统一 Store，并按 ST position 注入。
    if (parsed.dynamicLorebookEntries !== undefined
      && parsed.constantLorebookEntries !== undefined
      && parsed.mesExample !== undefined) {
      preprocessed = parsed as PreprocessedCharacter
    } else {
      // 自动迁移:老存档没有 dynamicLorebookEntries / 新字段 / position 分桶文档。
      const rawCard = parsed.raw
      if (rawCard === undefined) {
        process.stderr.write(`[ui-server] skip character ${id}: preprocessed.json has no raw card, cannot migrate\n`)
        return null
      }
      preprocessed = preprocessCharacterCard(rawCard as never)
      migrated = true
    }
  } catch (err) {
    process.stderr.write(`[ui-server] skip character ${id}: preprocessed.json unreadable (${err instanceof Error ? err.message : String(err)})\n`)
    return null
  }
  if (migrated) {
    // 持久化迁移结果，避免每次启动都重复导入旧卡并把旧的蓝灯分桶留在内存里。
    // 这里只更新生成的预处理文件，不改原始卡图和 meta 时间戳。
    try {
      await writeFile(join(dir, 'preprocessed.json'), JSON.stringify(preprocessed, null, 2), 'utf-8')
    } catch (err) {
      process.stderr.write(`[ui-server] warn: character ${id} migrated in memory but preprocessed.json could not be saved (${err instanceof Error ? err.message : String(err)})\n`)
    }
  }
  // lorebook.json 缺失不算错(可能是无内嵌世界书的卡);meta.json 说有但文件没就警告。
  try {
    await readFile(join(dir, 'lorebook.json'))
  } catch {
    if (preprocessed.lorebook !== undefined) {
      process.stderr.write(`[ui-server] warn: character ${id} meta says hasLorebook but lorebook.json missing\n`)
    }
  }
  return {
    id,
    name: meta.name,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    preprocessed,
  }
}

/** 从磁盘读一个会话:meta + history.jsonl,返回 (record, history)。失败返回 null。 */
async function loadSessionFromDisk(id: string): Promise<{ record: SessionRecord; history: ChatMessage[] } | null> {
  const dir = join(ABS_SESSIONS_DIR, id)
  let meta: { id: string; characterId: string; label: string; createdAt: string; greetingIndex?: unknown }
  try {
    const raw = await readFile(join(dir, 'meta.json'), 'utf-8')
    meta = JSON.parse(raw) as typeof meta
  } catch {
    return null
  }
  const greetingIndex = typeof meta.greetingIndex === 'number'
    && Number.isInteger(meta.greetingIndex) && meta.greetingIndex >= 0
    ? meta.greetingIndex
    : 0
  // history.jsonl 可能不存在(会话创建后还没说话)
  const history: ChatMessage[] = []
  try {
    const text = await readFile(join(dir, 'history.jsonl'), 'utf-8')
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        const obj = JSON.parse(line) as {
          role: string
          content: string
          message_id?: unknown
          name?: unknown
          is_hidden?: unknown
          data?: unknown
          extra?: unknown
          swipe_id?: unknown
          swipes?: unknown
          swipe_info?: unknown
          swipes_data?: unknown
          swipes_info?: unknown
        }
        if ((obj.role === 'user' || obj.role === 'assistant' || obj.role === 'system' || obj.role === 'tool') && typeof obj.content === 'string') {
          const message: ChatMessage = {
            role: obj.role,
            content: obj.content,
            ...(Number.isSafeInteger(obj.message_id) ? { message_id: Number(obj.message_id) } : {}),
            ...(typeof obj.name === 'string' ? { name: obj.name } : {}),
            ...(typeof obj.is_hidden === 'boolean' ? { is_hidden: obj.is_hidden } : {}),
            ...(obj.data !== null && typeof obj.data === 'object' && !Array.isArray(obj.data) ? { data: obj.data as Record<string, unknown> } : {}),
            ...(obj.extra !== null && typeof obj.extra === 'object' && !Array.isArray(obj.extra) ? { extra: obj.extra as Record<string, unknown> } : {}),
          }
          if (obj.role === 'assistant') {
            if (Array.isArray(obj.swipes) && obj.swipes.every(item => typeof item === 'string')) {
              message.swipes = [...obj.swipes]
            }
            if (Number.isInteger(obj.swipe_id)) message.swipe_id = Number(obj.swipe_id)
            if (Array.isArray(obj.swipe_info)) message.swipe_info = obj.swipe_info as SwipeInfo[]
            if (Array.isArray(obj.swipes_data)) message.swipes_data = obj.swipes_data as Record<string, unknown>[]
            if (Array.isArray(obj.swipes_info)) {
              message.swipes_info = obj.swipes_info as Record<string, unknown>[]
              if (message.swipe_info === undefined) message.swipe_info = obj.swipes_info as SwipeInfo[]
            }
          }
          history.push(message)
        }
      } catch {
        // 跳过坏行,不阻塞整个会话加载。
      }
    }
  } catch {
    // 文件不存在 = 空历史,正常情况。
  }
  const variables = await loadSessionVariables(id)
  return {
    record: {
      id: meta.id,
      characterId: meta.characterId,
      character: undefined as unknown as PreprocessedCharacter,
      createdAt: meta.createdAt,
      greetingIndex,
      label: meta.label,
      ...variables,
    },
    history,
  }
}

/** 启动时从磁盘扫 characters/ 和 sessions/ 重建 in-memory state。
 *  best-effort:坏文件打 warning 跳过,不让启动失败。 */
async function loadPersisted(state: AppState): Promise<void> {
  // 1) 角色
  if (existsSync(ABS_CHARACTERS_DIR)) {
    let entries: string[]
    try {
      entries = await readdir(ABS_CHARACTERS_DIR)
    } catch (err) {
      process.stderr.write(`[ui-server] warn: cannot read ${ABS_CHARACTERS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`)
      entries = []
    }
    for (const id of entries) {
      const rec = await loadCharacterFromDisk(id)
      if (rec === null) continue
      state.characters.set(id, rec)
      // 读该角色的"全局世界书启用选择"
      const wbCfg = await loadCharacterWorldbookConfig(id)
      if (wbCfg !== undefined) {
        state.characterWorldbookConfigs.set(id, wbCfg)
      }
    }
  }

  // 2) 会话:需要先有角色才能注入 PreprocessedCharacter
  if (existsSync(ABS_SESSIONS_DIR)) {
    let entries: string[]
    try {
      entries = await readdir(ABS_SESSIONS_DIR)
    } catch (err) {
      process.stderr.write(`[ui-server] warn: cannot read ${ABS_SESSIONS_DIR}: ${err instanceof Error ? err.message : String(err)}\n`)
      entries = []
    }
    for (const id of entries) {
      const loaded = await loadSessionFromDisk(id)
      if (loaded === null) continue
      const charRec = state.characters.get(loaded.record.characterId as CharacterId)
      if (charRec === undefined) {
        process.stderr.write(`[ui-server] warn: session ${id} references missing character ${loaded.record.characterId}, skipping\n`)
        continue
      }
      // 把 PreprocessedCharacter 注入 record + 重建 MemorySessionStore 内容
      const fullRecord: SessionRecord = {
        ...loaded.record,
        character: charRec.preprocessed,
        tavernHelperState: initializeTavernHelperState(
          charRec.preprocessed.raw.frontend,
          loaded.record.characterId,
          loaded.record.tavernHelperState,
        ),
      }
      state.sessionRecords.set(id, fullRecord)
      for (const m of loaded.history) {
        state.sessions.appendMessage(id, m)
      }
    }
  }

  // 3) UI 全局状态(currentCharacterId / currentSessionId / currentPersonaId)
  try {
    const text = await readFile(ABS_STATE_JSON, 'utf-8')
    const obj = JSON.parse(text) as { currentCharacterId?: unknown; currentSessionId?: unknown; currentPersonaId?: unknown }
    const cId = typeof obj.currentCharacterId === 'string' ? obj.currentCharacterId : null
    const sId = typeof obj.currentSessionId === 'string' ? obj.currentSessionId : null
    const pId = typeof obj.currentPersonaId === 'string' ? obj.currentPersonaId : null
    if (cId !== null && state.characters.has(cId)) {
      state.currentCharacterId = cId
    }
    if (sId !== null && state.sessionRecords.has(sId)) {
      state.currentSessionId = sId
    } else {
      // 上次选中的 session 已经没了,清掉避免悬空引用。
      state.currentSessionId = null
    }
    if (pId !== null && state.personas.get(pId) !== undefined) {
      state.currentPersonaId = pId
    }
  } catch {
    // 文件不存在 = 首次启动,正常。
  }

  // 重建合并后的 worldbook(用当前角色作为 characterId 过滤 imported 独立书)
  if (state.characters.size > 0) {
    ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, state.currentCharacterId)
  }
}

async function createSession(
  state: AppState,
  character: PreprocessedCharacter,
  characterId: CharacterId,
  label: string,
  firstMesOverride?: string,
  greetingIndex = 0,
): Promise<string> {
  const id = randomUUID()
  const record: SessionRecord = {
    id,
    characterId,
    character,
    createdAt: new Date().toISOString(),
    greetingIndex,
    label,
    tavernHelperState: initializeTavernHelperState(character.raw.frontend, characterId),
  }
  state.sessionRecords.set(id, record)
  // 持久化 meta.json(best-effort:写盘失败不阻塞会话创建,只打 warning)
  try {
    await saveSession(state, record)
  } catch (err) {
    process.stderr.write(`[ui-server] warn: failed to persist session ${id}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  // 开场白作为 session 第一条 assistant 消息,用户打开会话即可看到(酒馆行为)。
  // 客户端通过 firstMesOverride 切到 alternate greeting;undefined 时回退到
  // character.firstMes。空串(以及 character.firstMes 为空)都不 append,
  // 客户端可以用空串显式表达"不要开场白"。
  // 开场白先过一遍 {{user}}/{{char}} 宏替换(有 persona 时),酒馆同款行为:
  // 用户在 UI 上看到的开场白就是替换后的成品。
  const rawGreeting = firstMesOverride ?? character.firstMes
  const persona = getCurrentUserPersona(state)
  const greeting = substituteUserCharMacros(rawGreeting, persona?.name ?? null, character.name)
  if (greeting.length > 0) {
    const greetingMessage = makeAssistantMessage(greeting)
    state.sessions.appendMessage(id, greetingMessage)
    try { await appendHistoryJsonl(id, greetingMessage) } catch { /* swallow */ }
  }
  return id
}

/** Greeting list follows SillyTavern ordering: main greeting first, then alternates. */
function greetingAt(character: PreprocessedCharacter, index: number): string {
  return index === 0 ? character.firstMes : (character.alternateGreetings[index - 1] ?? '')
}

function parseGreetingIndex(value: unknown, character: PreprocessedCharacter): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  const count = 1 + character.alternateGreetings.length
  return value >= 0 && value < count ? value : null
}

function autoLabel(character: PreprocessedCharacter): string {
  return `${character.name} · ${character.preprocessedAt.slice(0, 19).replace('T', ' ')}`
}

/** Strip the bulk raw card and trim the preprocessed docs for transport. */
function serializeCharacter(character: PreprocessedCharacter, options: { readonly includeRaw?: boolean } = {}): {
  name: string
  persona: string
  worldview: string
  style: string
  firstMes: string
  alternateGreetings: readonly string[]
  mesExample: string
  systemPrompt: string
  postHistoryInstructions: string
  constantLorebookEntries: readonly ImportedLorebookEntry[]
  atDepthLorebookEntries: readonly ImportedLorebookEntry[]
  frontend: {
    regexScripts: PreprocessedCharacter['raw']['frontend']['regexScripts']
    tavernHelperScriptNames: PreprocessedCharacter['raw']['frontend']['tavernHelperScriptNames']
    tavernHelperScripts: PreprocessedCharacter['raw']['frontend']['tavernHelperScripts']
    tavernHelperScriptTrees?: PreprocessedCharacter['raw']['frontend']['tavernHelperScriptTrees']
    tavernHelperVariables: PreprocessedCharacter['raw']['frontend']['tavernHelperVariables']
    tavernHelper?: PreprocessedCharacter['raw']['frontend']['tavernHelper']
  }
  lorebook: { name: string; entryCount: number; enabledCount: number } | null
  preprocessedAt: string
  /** Exact V2/V3 root JSON, only returned by detail/select endpoints. */
  raw?: JsonValue
} {
  return {
    name: character.name,
    persona: character.persona,
    worldview: character.worldview,
    style: character.style,
    firstMes: character.firstMes,
    alternateGreetings: character.alternateGreetings,
    // 三个独立字段(酒馆 mes_example / system_prompt / post_history_instructions)。
    // 旧存档可能 undefined,兜底空串(wire 兼容双向:parseCharacterField 缺省 '')。
    mesExample: character.mesExample ?? '',
    systemPrompt: character.systemPrompt ?? '',
    postHistoryInstructions: character.postHistoryInstructions ?? '',
    constantLorebookEntries: character.constantLorebookEntries ?? [],
    atDepthLorebookEntries: character.atDepthLorebookEntries ?? [],
    frontend: {
      regexScripts: character.raw.frontend?.regexScripts ?? [],
      tavernHelperScriptNames: character.raw.frontend?.tavernHelperScriptNames ?? [],
      tavernHelperScripts: character.raw.frontend?.tavernHelperScripts ?? [],
      ...(character.raw.frontend?.tavernHelperScriptTrees === undefined ? {}
        : { tavernHelperScriptTrees: character.raw.frontend.tavernHelperScriptTrees }),
      tavernHelperVariables: character.raw.frontend?.tavernHelperVariables ?? {},
      ...(character.raw.frontend?.tavernHelper === undefined ? {} : { tavernHelper: character.raw.frontend.tavernHelper }),
    },
    // 只发摘要(避免把整本 lorebook 的 entries 传上 wire);
    // 完整数据在服务端 `state.cardLorebooks` 里。
    lorebook: character.lorebook === undefined
      ? null
      : {
          name: character.lorebook.name ?? character.name,
          entryCount: character.lorebook.entries.length,
          enabledCount: character.lorebook.entries.filter(e => e.enabled).length,
        },
    preprocessedAt: character.preprocessedAt,
    ...(options.includeRaw ? { raw: character.raw.raw } : {}),
  }
}

function parseJsonBody(buffer: Buffer): Record<string, unknown> | null {
  if (buffer.length === 0) return null
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

function readStringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

function readField(obj: Record<string, unknown>, key: string): unknown {
  return obj[key]
}

/** Re-hydrate a character from the wire format produced by `serializeCharacter`. */
function parseCharacterField(value: unknown): PreprocessedCharacter | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  const name = readStringField(obj, 'name')
  const persona = readStringField(obj, 'persona')
  const worldview = readStringField(obj, 'worldview')
  const style = readStringField(obj, 'style')
  const preprocessedAt = readStringField(obj, 'preprocessedAt')
  if (name === undefined || persona === undefined || worldview === undefined || style === undefined || preprocessedAt === undefined) {
    return null
  }
  // 开场白在 wire 上是可选的(老版本客户端可能不传)。缺失时退回占位文案,
  // 让 UI 端能稳定渲染;alternateGreetings 缺失视为空数组。
  const firstMes = readStringField(obj, 'firstMes') ?? '（角色暂未设置开场白）'
  const rawGreetings = obj.alternateGreetings
  const alternateGreetings: string[] = Array.isArray(rawGreetings)
    ? rawGreetings.filter((g): g is string => typeof g === 'string')
    : []
  // lorebook 字段是可选的(摘要或完整对象,都允许通过)。session 端真正使用的
  // lorebook 数据在 `state.cardLorebooks` 里(以 safe name 为 key),
  // 这里只是把 wire 上有传过来的字段留着,方便 UI 诊断。
  const lorebookJson = obj.lorebook
  const lorebook: ImportedLorebook | undefined =
    lorebookJson !== null && typeof lorebookJson === 'object' && !Array.isArray(lorebookJson)
      ? (lorebookJson as ImportedLorebook)
      : undefined
  const rawAtDepth = obj.atDepthLorebookEntries
  const atDepthLorebookEntries: ImportedLorebookEntry[] = Array.isArray(rawAtDepth)
    ? rawAtDepth.filter((entry): entry is ImportedLorebookEntry =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    : []
  const rawConstant = obj.constantLorebookEntries
  const constantLorebookEntries: ImportedLorebookEntry[] | undefined = Array.isArray(rawConstant)
    ? rawConstant.filter((entry): entry is ImportedLorebookEntry =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    : undefined
  const rawFrontend = obj.frontend
  const frontendObject = rawFrontend !== null && typeof rawFrontend === 'object' && !Array.isArray(rawFrontend)
    ? rawFrontend as Record<string, unknown> : {}
  const frontendScripts = Array.isArray(frontendObject.regexScripts)
    ? frontendObject.regexScripts as PreprocessedCharacter['raw']['frontend']['regexScripts'] : []
  const helperNames = Array.isArray(frontendObject.tavernHelperScriptNames)
    ? frontendObject.tavernHelperScriptNames.filter((entry): entry is string => typeof entry === 'string') : []
  const helperScripts = Array.isArray(frontendObject.tavernHelperScripts)
    ? frontendObject.tavernHelperScripts as PreprocessedCharacter['raw']['frontend']['tavernHelperScripts'] : []
  const helperScriptTrees = Array.isArray(frontendObject.tavernHelperScriptTrees)
    ? frontendObject.tavernHelperScriptTrees as PreprocessedCharacter['raw']['frontend']['tavernHelperScriptTrees'] : undefined
  const helperVariables = frontendObject.tavernHelperVariables !== null
    && typeof frontendObject.tavernHelperVariables === 'object'
    && !Array.isArray(frontendObject.tavernHelperVariables)
    ? frontendObject.tavernHelperVariables as PreprocessedCharacter['raw']['frontend']['tavernHelperVariables'] : {}
  // The wire format omits the bulky `raw` payload; the demo doesn't need it,
  // so we ship an empty `data` envelope that the loader won't ever read.
  // (responseAgent only touches character.{name,persona,worldview,style}.)
  // 三个新字段(mes_example / system_prompt / post_history_instructions)
  // 在 wire 上可选:缺失给空串默认(旧客户端兼容,response 端会显示占位)。
  return {
    name,
    persona,
    worldview,
    style,
    firstMes,
    alternateGreetings,
    mesExample: readStringField(obj, 'mesExample') ?? '',
    systemPrompt: readStringField(obj, 'systemPrompt') ?? '',
    postHistoryInstructions: readStringField(obj, 'postHistoryInstructions') ?? '',
    ...(constantLorebookEntries === undefined ? {} : { constantLorebookEntries }),
    atDepthLorebookEntries,
    lorebook,
    // wire 上不传 dynamicLorebookEntries(由服务端 state.characters 提供);
    // 老路径(import 还没刷到 state 时)前端直接发完整 character,这里给个空数组兜底。
    dynamicLorebookEntries: [],
    preprocessedAt,
    raw: {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name },
      frontend: {
        regexScripts: frontendScripts,
        tavernHelperScriptNames: helperNames,
      tavernHelperScripts: helperScripts,
      ...(helperScriptTrees === undefined ? {} : { tavernHelperScriptTrees: helperScriptTrees }),
      tavernHelperVariables: helperVariables,
      },
    } as never,
  }
}

/** Prefer the server's lossless imported card over the compact UI wire view.
 *
 * The browser intentionally receives a slim character projection. If that
 * projection were written back into a new session record, the raw card
 * payload (MVU initializer, Tavern Helper metadata, and full lorebook) would
 * be lost before response generation. Custom wire-only cards still work as a
 * fallback for tests and API callers.
 */
function resolveCharacterField(state: AppState, value: unknown): PreprocessedCharacter | null {
  const parsed = parseCharacterField(value)
  if (parsed === null) return null
  return state.characters.get(safeFileName(parsed.name))?.preprocessed ?? parsed
}

// ─── /api/worldbook-import — 独立世界书导入(酒馆 World Info .json 格式) ────

/** 把酒馆 World Info JSON 转成 `ImportedLorebook`。只解析 `entries` 字典(uid -> entry)部分。
 *  不识别的字段静默丢弃;不抛错(允许部分字段缺失)。 */
function parseWorldInfoJson(json: string): ImportedLorebook {
  const obj = JSON.parse(json) as {
    entries?: Record<string, Record<string, unknown>>
    name?: string
    token_budget?: unknown
    tokenBudget?: unknown
    extensions?: unknown
    /** Current ST exports `recursive`; some integrations use the expanded name. */
    recursive?: unknown
    recursiveScanning?: unknown
  }
  if (obj.entries === null || typeof obj.entries !== 'object' || Array.isArray(obj.entries)) {
    throw new Error('world info JSON must have an "entries" object')
  }
  const bookExtensions = obj.extensions !== null && typeof obj.extensions === 'object'
    && !Array.isArray(obj.extensions) ? obj.extensions as Record<string, unknown> : undefined
  const tokenBudgetRaw = obj.token_budget ?? obj.tokenBudget ?? bookExtensions?.token_budget
  const tokenBudget = typeof tokenBudgetRaw === 'number' && Number.isFinite(tokenBudgetRaw)
    ? Math.max(0, Math.trunc(tokenBudgetRaw))
    : undefined
  const entries: ImportedLorebook['entries'] extends readonly (infer E)[] ? E[] : never = []
  for (const [uid, raw] of Object.entries(obj.entries)) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const content = typeof r.content === 'string' ? r.content : ''
    const keys = Array.isArray(r.key) ? r.key.filter((k): k is string => typeof k === 'string') : []
    const secondaryKeys = Array.isArray(r.keysecondary) ? r.keysecondary.filter((k): k is string => typeof k === 'string') : []
    const comment = typeof r.comment === 'string' && r.comment.length > 0 ? r.comment : undefined
    const constant = r.constant === true
    const selective = r.selective === true
    const caseSensitive = r.caseSensitive === true
    const matchWholeWords = r.matchWholeWords === true
    const useRegex = r.useRegex === true || r.regex === true
    // position: 0 = before_char, 1 = after_char(酒馆); 旧版可能用字符串
    let position: 'before_char' | 'after_char' = 'after_char'
    if (r.position === 0 || r.position === 'before_char') position = 'before_char'
    const insertionOrder = typeof r.order === 'number' ? r.order : Number(uid) || 0
    const enabled = r.disable !== true
    const ext = typeof r.extensions === 'object' && r.extensions !== null
      ? r.extensions as Record<string, unknown>
      : undefined
    const priority = ext !== undefined && typeof ext.weight === 'number' ? ext.weight : undefined
    // ST selectiveLogic 枚举(world-info.js:33):0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL。
    // 酒馆 WI JSON 里是数字(也兼容字符串枚举名),未知值回落 and-any(ST 默认)。
    const logicRaw = r.selectiveLogic ?? ext?.selectiveLogic
    const secondaryLogic = logicRaw === 1 || logicRaw === 'NOT_ALL' ? 'not-all'
      : logicRaw === 2 || logicRaw === 'NOT_ANY' ? 'not-any'
      : logicRaw === 3 || logicRaw === 'AND_ALL' ? 'and-all'
      : 'and-any'
    // ST 激活概率%(world-info.js:4907-4925)。绿灯由 2.1 选中后代码掷骰;
    // 蓝灯(constant)本项目严格无条件注入(与 ST 的差异:ST 也会对蓝灯掷骰)。
    const probability = typeof r.probability === 'number' ? r.probability : 100
    const useProbability = r.useProbability !== false
    const excludeRecursion = typeof ext?.exclude_recursion === 'boolean'
      ? ext.exclude_recursion : typeof r.exclude_recursion === 'boolean' ? r.exclude_recursion : undefined
    const preventRecursion = typeof ext?.prevent_recursion === 'boolean'
      ? ext.prevent_recursion : typeof r.prevent_recursion === 'boolean' ? r.prevent_recursion : undefined
    const delayRaw = ext?.delay_until_recursion ?? r.delay_until_recursion
    const delayUntilRecursion = typeof delayRaw === 'boolean' || typeof delayRaw === 'number'
      ? delayRaw : undefined
    const timedNumber = (extensionKey: string, entryKey: string): number | undefined => {
      const value = ext?.[extensionKey] ?? r[entryKey]
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value) : undefined
    }
    const sticky = timedNumber('sticky', 'sticky')
    const cooldown = timedNumber('cooldown', 'cooldown')
    const delay = timedNumber('delay', 'delay')
    const groupRaw = ext?.group ?? r.group
    const group = typeof groupRaw === 'string' && groupRaw.trim().length > 0 ? groupRaw.trim() : undefined
    const groupOverride = typeof (ext?.group_override ?? r.group_override) === 'boolean'
      ? (ext?.group_override ?? r.group_override) as boolean : undefined
    const groupWeightRaw = ext?.group_weight ?? r.group_weight
    const groupWeight = typeof groupWeightRaw === 'number' && Number.isFinite(groupWeightRaw)
      ? Math.max(1, Math.trunc(groupWeightRaw)) : undefined
    const groupScoringRaw = ext?.use_group_scoring ?? r.use_group_scoring
    const useGroupScoring = typeof groupScoringRaw === 'boolean' ? groupScoringRaw : undefined
    const matchFlag = (snake: string, camel: string): boolean | undefined => {
      const value = ext?.[snake] ?? ext?.[camel] ?? r[snake] ?? r[camel]
      return typeof value === 'boolean' ? value : undefined
    }
    const matchPersonaDescription = matchFlag('match_persona_description', 'matchPersonaDescription')
    const matchCharacterDescription = matchFlag('match_character_description', 'matchCharacterDescription')
    const matchCharacterPersonality = matchFlag('match_character_personality', 'matchCharacterPersonality')
    const matchCharacterDepthPrompt = matchFlag('match_character_depth_prompt', 'matchCharacterDepthPrompt')
    const matchScenario = matchFlag('match_scenario', 'matchScenario')
    const matchCreatorNotes = matchFlag('match_creator_notes', 'matchCreatorNotes')
    // ST position 枚举原值(0-7):extensions.position ?? 数字 position ?? 字符串换算。
    const stPositionRaw = typeof ext?.position === 'number' ? ext.position : r.position
    const stPosition = typeof stPositionRaw === 'number' ? stPositionRaw
      : stPositionRaw === 'before_char' ? 0
      : stPositionRaw === 'after_char' ? 1
      : undefined
    const depthRaw = ext?.depth ?? r.depth
    const depth = typeof depthRaw === 'number' && Number.isFinite(depthRaw)
      ? Math.max(0, Math.trunc(depthRaw)) : undefined
    const roleRaw = ext?.role ?? r.role
    const role = roleRaw === 'user' || roleRaw === 'assistant' || roleRaw === 'system' ? roleRaw : undefined
    // name 优先用 comment(酒馆里 comment 是名字),其次用第一个 key
    const name = comment ?? (keys.length > 0 ? keys[0] : `未命名 ${uid}`)
    const entry: import('../import/types.ts').ImportedLorebookEntry = {
      sourceId: String(uid),
      ...(name !== undefined ? { name } : {}),
      ...(comment !== undefined ? { comment } : {}),
      keys,
      secondaryKeys,
      content,
      enabled,
      insertionOrder,
      selective,
      constant,
      caseSensitive,
      matchWholeWords,
      secondaryLogic,
      position,
      ...(stPosition !== undefined ? { stPosition } : {}),
      ...(depth === undefined ? {} : { depth }),
      ...(role === undefined ? {} : { role }),
      ...(excludeRecursion === undefined ? {} : { excludeRecursion }),
      ...(preventRecursion === undefined ? {} : { preventRecursion }),
      ...(delayUntilRecursion === undefined ? {} : { delayUntilRecursion }),
      ...(sticky === undefined ? {} : { sticky }),
      ...(cooldown === undefined ? {} : { cooldown }),
      ...(delay === undefined ? {} : { delay }),
      ...(group === undefined ? {} : { group }),
      ...(groupOverride === undefined ? {} : { groupOverride }),
      ...(groupWeight === undefined ? {} : { groupWeight }),
      ...(useGroupScoring === undefined ? {} : { useGroupScoring }),
      ...(matchPersonaDescription === undefined ? {} : { matchPersonaDescription }),
      ...(matchCharacterDescription === undefined ? {} : { matchCharacterDescription }),
      ...(matchCharacterPersonality === undefined ? {} : { matchCharacterPersonality }),
      ...(matchCharacterDepthPrompt === undefined ? {} : { matchCharacterDepthPrompt }),
      ...(matchScenario === undefined ? {} : { matchScenario }),
      ...(matchCreatorNotes === undefined ? {} : { matchCreatorNotes }),
      ...(probability !== undefined ? { probability } : {}),
      ...(useProbability !== undefined ? { useProbability } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ignoreBudget: false,
      useRegex,
      hasDecorators: false,
    }
    entries.push(entry)
  }
  const book: ImportedLorebook = {
    ...(obj.name !== undefined ? { name: obj.name } : {}),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    recursiveScanning: obj.recursiveScanning === true || obj.recursive === true,
    entries,
  }
  return book
}

/** 加载所有独立世界书 → `state.importedWorldbooks` + 重新合并 worldbook */
async function loadImportedWorldbooks(state: AppState): Promise<void> {
  if (!existsSync(ABS_WORLDBOOKS_DIR)) return
  let entries: string[]
  try { entries = await readdir(ABS_WORLDBOOKS_DIR) } catch { return }
  for (const dir of entries) {
    const metaPath = join(ABS_WORLDBOOKS_DIR, dir, 'meta.json')
    const entriesPath = join(ABS_WORLDBOOKS_DIR, dir, 'entries.json')
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8')) as { id: string; name: string; createdAt: string }
      // 信任磁盘内容(由 parseWorldInfoJson 写出,字段齐全);TS 类型断言绕过
      const book = JSON.parse(await readFile(entriesPath, 'utf-8')) as ImportedLorebook
      state.importedWorldbooks.set(meta.id, { ...book, name: book.name ?? meta.name })
    } catch (err) {
      process.stderr.write(`[ui-server] warn: skip worldbook ${dir}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}

async function handleImportWorldbook(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  // 可选 ?name= :前端导入时让用户命名(优先于 JSON 内嵌 name,便于同名书区分)
  const qsName = url.searchParams.get('name')
  const body = await readBody(req, 8 * 1024 * 1024)
  const text = body.toString('utf8')
  let book: ImportedLorebook
  try {
    book = parseWorldInfoJson(text)
  } catch (err) {
    return sendError(res, 400, `failed to parse world info JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (book.entries.length === 0) {
    return sendError(res, 400, 'worldbook has 0 entries')
  }
  const name = (qsName !== null && qsName.trim().length > 0 ? qsName.trim() : undefined)
    ?? book.name
    ?? `世界书_${book.entries.length}条`
  const id = safeFileName(name)
  const dir = join(ABS_WORLDBOOKS_DIR, id)
  await mkdir(dir, { recursive: true })
  const meta = { id, name, createdAt: new Date().toISOString() }
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
  // Keep the book-level ST fields alongside the entries.  They are part of
  // the source-book budget/recursion contract and must survive a restart.
  await writeFile(join(dir, 'entries.json'), JSON.stringify({
    ...(book.name === undefined ? {} : { name: book.name }),
    ...(book.scanDepth === undefined ? {} : { scanDepth: book.scanDepth }),
    ...(book.tokenBudget === undefined ? {} : { tokenBudget: book.tokenBudget }),
    recursiveScanning: book.recursiveScanning,
    entries: book.entries,
  }, null, 2), 'utf-8')
  state.importedWorldbooks.set(id, book)
  ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, state.currentCharacterId)
  sendJson(res, 200, {
    id,
    name,
    entryCount: book.entries.length,
    enabledCount: book.entries.filter(e => e.enabled).length,
    tokenBudget: book.tokenBudget ?? null,
  })
}

function handleListImportedWorldbooks(state: AppState, res: ServerResponse): void {
  const list = [...state.importedWorldbooks.entries()].map(([id, book]) => ({
    id,
    name: book.name ?? id,
    entryCount: book.entries.length,
    enabledCount: book.entries.filter(e => e.enabled).length,
    tokenBudget: book.tokenBudget ?? null,
  }))
  sendJson(res, 200, { worldbooks: list })
}

/** GET /api/worldbooks/:id — 返回单本独立世界书的全部 entry */
function handleGetImportedWorldbook(state: AppState, id: string, res: ServerResponse): void {
  const book = state.importedWorldbooks.get(id)
  if (book === undefined) return sendError(res, 404, `worldbook not found: ${id}`)
  const entries = [...book.entries]
    .sort((a, b) => a.insertionOrder - b.insertionOrder)
    .map(e => ({
      sourceId: e.sourceId,
      name: e.name ?? null,
      keys: [...e.keys],
      secondaryKeys: [...e.secondaryKeys],
      content: e.content,
      enabled: e.enabled,
      insertionOrder: e.insertionOrder,
      selective: e.selective,
      constant: e.constant,
      caseSensitive: e.caseSensitive,
      matchWholeWords: e.matchWholeWords,
      useRegex: e.useRegex,
      selectiveLogic: e.secondaryLogic,
      probability: e.probability ?? 100,
      useProbability: e.useProbability ?? true,
      position: e.position,
      stPosition: e.stPosition ?? (e.position === 'before_char' ? 0 : 1),
      priority: e.priority ?? null,
    }))
  sendJson(res, 200, {
    id,
    name: book.name ?? null,
    tokenBudget: book.tokenBudget ?? null,
    recursiveScanning: book.recursiveScanning,
    entries,
    totalCount: book.entries.length,
    enabledCount: book.entries.filter(e => e.enabled).length,
  })
}

/** PATCH /api/worldbooks/:id/entry/:sourceId — 切换独立世界书 entry 的 enabled */
async function handlePatchImportedWorldbookEntry(
  state: AppState, id: string, sourceId: string, req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const book = state.importedWorldbooks.get(id)
  if (book === undefined) return sendError(res, 404, `worldbook not found: ${id}`)
  const body = await readBody(req, 16 * 1024)
  const payload = parseJsonBody(body)
  if (payload === null) return sendError(res, 400, 'invalid JSON body')
  const enabledRaw = (payload as Record<string, unknown>).enabled
  if (typeof enabledRaw !== 'boolean') return sendError(res, 400, 'enabled (boolean) is required')
  const newEntries = book.entries.map(e => e.sourceId === sourceId ? { ...e, enabled: enabledRaw } : e)
  const newBook: ImportedLorebook = { ...book, entries: newEntries }
  state.importedWorldbooks.set(id, newBook)
  // 写盘
  const dir = join(ABS_WORLDBOOKS_DIR, id)
  await writeFile(join(dir, 'entries.json'), JSON.stringify({
    ...(newBook.name === undefined ? {} : { name: newBook.name }),
    ...(newBook.scanDepth === undefined ? {} : { scanDepth: newBook.scanDepth }),
    ...(newBook.tokenBudget === undefined ? {} : { tokenBudget: newBook.tokenBudget }),
    recursiveScanning: newBook.recursiveScanning,
    entries: newEntries,
  }, null, 2), 'utf-8')
  // 重新合并 worldbook(独立书对当前角色是否启用取决于 characterWorldbookConfigs)
  ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, state.currentCharacterId)
  sendJson(res, 200, { id, sourceId, enabled: enabledRaw })
}

/** DELETE /api/worldbooks/:id — 删除一本独立世界书。
 *  同时清理各角色 worldbook-config 里对它的引用(悬空 disabledBookId 无害,但留着脏)。 */
async function handleDeleteImportedWorldbook(state: AppState, id: string, res: ServerResponse): Promise<void> {
  if (!state.importedWorldbooks.has(id)) return sendError(res, 404, `worldbook not found: ${id}`)
  state.importedWorldbooks.delete(id)
  for (const [cid, cfg] of state.characterWorldbookConfigs) {
    if (!cfg.disabledBookIds.has(id)) continue
    const next: CharacterWorldbookConfig = { disabledBookIds: new Set([...cfg.disabledBookIds].filter((x) => x !== id)) }
    state.characterWorldbookConfigs.set(cid, next)
    try { await saveCharacterWorldbookConfig(cid, next) } catch { /* best-effort */ }
  }
  try {
    await rm(join(ABS_WORLDBOOKS_DIR, id), { recursive: true, force: true })
  } catch (err) {
    // 磁盘删失败不让内存状态回滚(书已从运行时移除),只警告。
    process.stderr.write(`[ui-server] warn: failed to remove worldbook dir ${id}: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, state.currentCharacterId)
  sendJson(res, 200, { id, deleted: true })
}

/** 把角色名安全化用作文件名:去掉 Windows 非法字符 + 压缩空白,截到 80 字符。 */
function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/\s+/gu, '_')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'unnamed'
}

/** 把一条角色卡内嵌 lorebook 条目转成 `WorldbookEntry`,并用 `<char>/<entry>` 命名空间隔离。
 *  ST 条目参数(constant/selectiveLogic/probability/position 等)全量透传:
 *  2.1 worldbook-match 用它们组装绿灯候选参数表,③ response 用 constant+position
 *  做独立书蓝灯常驻注入。旧存档缺省字段按 ST 默认处理(and-any / 100 / true)。 */
function lorebookEntryToWorldbookEntry(
  charName: string,
  e: ImportedLorebookEntry,
  recursion: {
    readonly recursiveScanning: boolean
    readonly recursiveBookId: string
    readonly sourceBookId?: string
    readonly sourceBookTokenBudget?: number
  },
): WorldbookEntry {
  const displayName = e.name ?? `(未命名 ${e.sourceId})`
  return {
    path: `${charName}/${displayName}`,
    ...(recursion.sourceBookId === undefined ? {} : { sourceBookId: recursion.sourceBookId }),
    ...(recursion.sourceBookTokenBudget === undefined ? {} : { sourceBookTokenBudget: recursion.sourceBookTokenBudget }),
    ...(e.comment === undefined && e.name === undefined ? {} : { comment: e.comment ?? e.name }),
    keywords: [...e.keys, ...e.secondaryKeys],
    order: e.insertionOrder,
    weight: e.priority ?? 0,
    ...(e.priority === undefined ? {} : { priority: e.priority }),
    content: e.content,
    constant: e.constant,
    enabled: e.enabled,
      secondaryKeywords: [...e.secondaryKeys],
    selective: e.selective,
    selectiveLogic: e.secondaryLogic,
    caseSensitive: e.caseSensitive,
    matchWholeWords: e.matchWholeWords,
    useRegex: e.useRegex,
    probability: e.probability ?? 100,
    useProbability: e.useProbability ?? true,
    position: e.stPosition ?? (e.position === 'before_char' ? 0 : 1),
    ...(e.depth === undefined ? {} : { depth: e.depth }),
    ...(e.role === undefined ? {} : { role: e.role }),
    ...(e.scanDepth === undefined ? {} : { scanDepth: e.scanDepth }),
    recursiveScanning: recursion.recursiveScanning,
    recursiveBookId: recursion.recursiveBookId,
    ...(e.excludeRecursion === undefined ? {} : { excludeRecursion: e.excludeRecursion }),
    ...(e.preventRecursion === undefined ? {} : { preventRecursion: e.preventRecursion }),
    ...(e.delayUntilRecursion === undefined ? {} : { delayUntilRecursion: e.delayUntilRecursion }),
    ...(e.sticky === undefined ? {} : { sticky: e.sticky }),
    ...(e.cooldown === undefined ? {} : { cooldown: e.cooldown }),
    ...(e.delay === undefined ? {} : { delay: e.delay }),
    ...(e.group === undefined ? {} : { group: e.group }),
    ...(e.groupOverride === undefined ? {} : { groupOverride: e.groupOverride }),
    ...(e.groupWeight === undefined ? {} : { groupWeight: e.groupWeight }),
    ...(e.useGroupScoring === undefined ? {} : { useGroupScoring: e.useGroupScoring }),
    ...(e.matchPersonaDescription === undefined ? {} : { matchPersonaDescription: e.matchPersonaDescription }),
    ...(e.matchCharacterDescription === undefined ? {} : { matchCharacterDescription: e.matchCharacterDescription }),
    ...(e.matchCharacterPersonality === undefined ? {} : { matchCharacterPersonality: e.matchCharacterPersonality }),
    ...(e.matchCharacterDepthPrompt === undefined ? {} : { matchCharacterDepthPrompt: e.matchCharacterDepthPrompt }),
    ...(e.matchScenario === undefined ? {} : { matchScenario: e.matchScenario }),
    ...(e.matchCreatorNotes === undefined ? {} : { matchCreatorNotes: e.matchCreatorNotes }),
    ignoreBudget: e.ignoreBudget,
    hasDecorators: e.hasDecorators,
  }
}

/** Convert one Tavern Helper worldbook entry into the common deterministic
 * matcher vocabulary.  The conversion is intentionally lossless for the
 * fields the agent loop understands; unsupported vector/injection fields stay
 * in the session-owned source state and never get silently treated as a
 * different book. */
function tavernHelperWorldbookEntryToWorldbookEntry(bookName: string, entry: TavernWorldbookEntry): WorldbookEntry {
  const logic = entry.strategy.keys_secondary.logic
  const selectiveLogic = logic === 'and_all' ? 'and-all'
    : logic === 'not_all' ? 'not-all'
      : logic === 'not_any' ? 'not-any' : 'and-any'
  const positionMetadata = tavernHelperWorldbookMetadata(entry)
  const path = `酒馆助手/${bookName}/${entry.uid}`
  const extra = entry.extra ?? {}
  const group = typeof extra.group === 'string' && extra.group.trim().length > 0 ? extra.group.trim() : undefined
  const groupOverride = typeof extra.group_override === 'boolean' ? extra.group_override : undefined
  const groupWeight = typeof extra.group_weight === 'number' && Number.isFinite(extra.group_weight)
    ? Math.max(1, Math.trunc(extra.group_weight)) : undefined
  const useGroupScoring = typeof extra.use_group_scoring === 'boolean' ? extra.use_group_scoring : undefined
  const extraMatchFlag = (key: string): boolean | undefined =>
    typeof extra[key] === 'boolean' ? extra[key] as boolean : undefined
  const matchPersonaDescription = extraMatchFlag('match_persona_description')
  const matchCharacterDescription = extraMatchFlag('match_character_description')
  const matchCharacterPersonality = extraMatchFlag('match_character_personality')
  const matchCharacterDepthPrompt = extraMatchFlag('match_character_depth_prompt')
  const matchScenario = extraMatchFlag('match_scenario')
  const matchCreatorNotes = extraMatchFlag('match_creator_notes')
  return {
    path,
    comment: entry.name,
    keywords: [...entry.strategy.keys],
    order: entry.position.order,
    weight: 100,
    content: entry.content,
    constant: entry.strategy.type === 'constant',
    enabled: entry.enabled,
    secondaryKeywords: [...entry.strategy.keys_secondary.keys],
    selective: entry.strategy.type === 'selective',
    selectiveLogic,
    caseSensitive: false,
    matchWholeWords: false,
    useRegex: false,
    probability: entry.probability,
    useProbability: true,
    ...positionMetadata,
    ...(entry.strategy.scan_depth === 'same_as_global' ? {} : { scanDepth: entry.strategy.scan_depth }),
    ...(entry.effect.sticky === null ? {} : { sticky: entry.effect.sticky }),
    ...(entry.effect.cooldown === null ? {} : { cooldown: entry.effect.cooldown }),
    ...(entry.effect.delay === null ? {} : { delay: entry.effect.delay }),
    ...(group === undefined ? {} : { group }),
    ...(groupOverride === undefined ? {} : { groupOverride }),
    ...(groupWeight === undefined ? {} : { groupWeight }),
    ...(useGroupScoring === undefined ? {} : { useGroupScoring }),
    ...(matchPersonaDescription === undefined ? {} : { matchPersonaDescription }),
    ...(matchCharacterDescription === undefined ? {} : { matchCharacterDescription }),
    ...(matchCharacterPersonality === undefined ? {} : { matchCharacterPersonality }),
    ...(matchCharacterDepthPrompt === undefined ? {} : { matchCharacterDepthPrompt }),
    ...(matchScenario === undefined ? {} : { matchScenario }),
    ...(matchCreatorNotes === undefined ? {} : { matchCreatorNotes }),
    ignoreBudget: entry.ignoreBudget === true,
  }
}

/** Resolve the worldbooks visible to the current Tavern Helper session.
 * Explicit bindings follow the extension's global/character/chat precedence;
 * when a script has created books but has not written bindings yet, exposing
 * all session-owned books is the useful and backwards-compatible fallback. */
function tavernHelperActiveWorldbookNames(state: TavernHelperState): string[] {
  const books = state.worldbooks ?? {}
  const bindings = state.worldbookBindings
  const names = new Set<string>()
  if (bindings === undefined) return Object.keys(books)
  for (const name of bindings.global ?? []) names.add(name)
  for (const name of [bindings.character?.primary, ...(bindings.character?.additional ?? []), bindings.chat]) {
    if (typeof name === 'string' && name.length > 0) names.add(name)
  }
  return [...names]
}

/**
 * 把 fixture 库 + 所有已导入角色卡的"动态"世界书条目 + 该角色启用的独立世界书
 * 合并成一个 `MemoryWorldbookStore`。
 * 每次 import / PATCH / 切角色 后调用,让 `state.worldbook` 反映最新集合。
 *
 * 注意:新格式角色卡内嵌世界书的蓝灯和绿灯都会进入当前 Store；蓝灯在 2.1
 * 候选组装时剔除，③ response 按 constant+position 每轮常驻注入。旧存档没有
 * `constantLorebookEntries` 时，已拼入三文档的蓝灯不会再次进入 Store。
 *
 * @param characterId - 该角色"启用"的独立世界书集合,决定哪些 imported 书被合并;
 *                     传 `null` 时只合并 fixture + 角色卡 dynamic(用于启动/无角色场景)
 */
function getMergedWorldbook(
  state: AppState,
  characterId: CharacterId | null,
  sessionId: string | null = state.currentSessionId,
): WorldbookStore {
  // 注意:fixture 必须从 pristine 的 `fixtureWorldbook` 读,不能从 `state.worldbook`
  // 读 —— 后者已经是"fixture+card+imported 合并结果",自引用会把旧条目每
  // rebuild 一次就累加一遍(重复膨胀)。
  const fixtureEntries = [...state.fixtureWorldbook.list()]
  // 角色卡内嵌世界书只跟角色走:只合并 characterId 对应角色的条目；新格式
  // 的 constant 和 dynamic 都进入同一 Store，交给统一 ST position/预算链路。
  // 老存档没有 constantLorebookEntries，因此仍只保留已经预处理进文档的内容。
  const cardEntries: WorldbookEntry[] = []
  if (characterId !== null) {
    const rec = state.characters.get(characterId)
    if (rec !== undefined) {
      for (const e of rec.preprocessed.constantLorebookEntries ?? []) {
        cardEntries.push(lorebookEntryToWorldbookEntry(
          rec.name,
          e,
          {
            recursiveScanning: rec.preprocessed.lorebook?.recursiveScanning === true,
            recursiveBookId: `character:${safeFileName(rec.name)}`,
            sourceBookId: `character:${safeFileName(rec.name)}`,
            ...(rec.preprocessed.lorebook?.tokenBudget === undefined
              ? {}
              : { sourceBookTokenBudget: rec.preprocessed.lorebook.tokenBudget }),
          },
        ))
      }
      for (const e of rec.preprocessed.dynamicLorebookEntries) {
        cardEntries.push(lorebookEntryToWorldbookEntry(
          rec.name,
          e,
          {
            recursiveScanning: rec.preprocessed.lorebook?.recursiveScanning === true,
            recursiveBookId: `character:${safeFileName(rec.name)}`,
            sourceBookId: `character:${safeFileName(rec.name)}`,
            ...(rec.preprocessed.lorebook?.tokenBudget === undefined
              ? {}
              : { sourceBookTokenBudget: rec.preprocessed.lorebook.tokenBudget }),
          },
        ))
      }
    }
  }
  // 决定该角色"显式禁用"的独立世界书 id 集合;不在 disabled 里的 = 启用
  // (这样新 import 的书默认对所有角色启用,符合用户预期)
  let disabledIds: Set<string> | null = null
  if (characterId !== null) {
    const cfg = state.characterWorldbookConfigs.get(characterId)
    if (cfg !== undefined) disabledIds = cfg.disabledBookIds
  }
  const importedEntries: WorldbookEntry[] = []
  for (const [name, book] of state.importedWorldbooks) {
    // 启用判定:
    //   - disabledIds === null(没在 config map 里)→ 默认全启用
    //   - disabledIds 是 Set → 显式禁用的才跳过
    if (disabledIds !== null && disabledIds.has(name)) continue
    for (const e of book.entries) {
      importedEntries.push(lorebookEntryToWorldbookEntry(
        `世界书/${name}`,
        e,
        {
          recursiveScanning: book.recursiveScanning === true,
          recursiveBookId: `worldbook:${name}`,
          sourceBookId: `worldbook:${name}`,
          ...(book.tokenBudget === undefined ? {} : { sourceBookTokenBudget: book.tokenBudget }),
        },
      ))
    }
  }
  const helperEntries: WorldbookEntry[] = []
  const sessionRecord = sessionId === null ? undefined : state.sessionRecords.get(sessionId)
  const helperState = sessionRecord?.characterId === characterId ? sessionRecord.tavernHelperState : undefined
  const deletedHelperBooks = new Set(helperState?.deletedWorldbookNames ?? [])
  const helperBooks = helperState?.worldbooks ?? {}
  for (const bookName of helperState === undefined ? [] : tavernHelperActiveWorldbookNames(helperState)) {
    if (deletedHelperBooks.has(bookName)) continue
    for (const entry of helperBooks[bookName] ?? []) {
      helperEntries.push(tavernHelperWorldbookEntryToWorldbookEntry(bookName, entry))
    }
  }
  const store = new MemoryWorldbookStore([...fixtureEntries, ...cardEntries, ...importedEntries, ...helperEntries])
  // Generate a debug/inspection artifact for the exact active combination.
  // This is a local operation: only ordinary green-light keys are written;
  // entry content stays in the authoritative store and is loaded after a hit.
  const characterName = characterId === null
    ? 'current'
    : state.characters.get(characterId)?.name ?? characterId
  const userPersona = getCurrentUserPersona(state)
  const keyIndex = buildWorldbookKeyIndex(store.list(), {
    user: userPersona?.name ?? null,
    char: characterId === null ? null : characterName,
  })
  const keyIndexMd = renderWorldbookKeyOnlyMd(
    keyIndex,
    `${characterName} — 当前游玩组合 Green Worldbook Key Index`,
  )
  const keyIndexPath = join(ABS_WORLDBOOK_INDEX_DIR, `${safeFileName(characterName)}_key-only.md`)
  queueWorldbookKeyIndexWrite(keyIndexPath, keyIndexMd)
  // Stable alias for tools/UI that need the currently active combination after
  // a character or external-worldbook switch.
  const currentKeyIndexPath = join(ABS_WORLDBOOK_INDEX_DIR, 'current_key-only.md')
  if (currentKeyIndexPath !== keyIndexPath) queueWorldbookKeyIndexWrite(currentKeyIndexPath, keyIndexMd)
  process.stderr.write(`[getMergedWorldbook] char=${characterId ?? 'null'} imported=${state.importedWorldbooks.size} helper=${helperEntries.length} cfgDisabled=${disabledIds === null ? 'none(default enable all)' : [...disabledIds].join(',')} storeSize=${store.list().length} (fixture=${fixtureEntries.length} card=${cardEntries.length} imported=${importedEntries.length})\n`)
  return store
}

/**
 * 把一个角色卡内嵌的 `ImportedLorebook` 渲染成"总条目目录" md:
 *  - 顶部元信息(书名、条目数、启用/禁用、扫描深度、Token 预算、递归扫描)
 *  - `## 索引` 段:markdown 表格,每个条目一行
 *  - `## 条目详情` 段:每个条目的元信息 + 完整内容(放在 ``` 代码块里)
 */
function renderLorebookIndexMd(character: { name: string; lorebook?: ImportedLorebook | undefined }): string {
  if (character.lorebook === undefined) {
    return `# ${character.name} — 世界书目录\n\n（角色卡未内嵌世界书）\n`
  }
  const book = character.lorebook
  const sorted = [...book.entries].sort((a, b) => a.insertionOrder - b.insertionOrder)
  const enabledCount = book.entries.filter(e => e.enabled).length
  const disabledCount = book.entries.length - enabledCount

  const lines: string[] = []
  lines.push(`# ${character.name} — 世界书目录`)
  if (book.name !== undefined && book.name.length > 0) lines.push(`\n> 原书名: ${book.name}`)
  lines.push('')
  lines.push(`- 条目数: ${book.entries.length}`)
  lines.push(`- 启用: ${enabledCount}`)
  lines.push(`- 禁用: ${disabledCount}`)
  if (book.scanDepth !== undefined) lines.push(`- 扫描深度: ${book.scanDepth}`)
  if (book.tokenBudget !== undefined) lines.push(`- Token 预算: ${book.tokenBudget}`)
  lines.push(`- 递归扫描: ${book.recursiveScanning ? '是' : '否'}`)
  lines.push('')
  lines.push('## 索引')
  lines.push('')
  lines.push('| # | 名称 | 关键词 | 插入顺序 | 优先级 | 启用 | 位置 |')
  lines.push('|---|------|--------|----------|--------|------|------|')
  for (const e of sorted) {
    const name = e.name ?? `(未命名 ${e.sourceId})`
    const keys = [...e.keys, ...e.secondaryKeys.map(k => `+${k}`)].join(', ') || '—'
    const priority = e.priority ?? '—'
    const enabled = e.enabled ? '✓' : '✗'
    lines.push(`| ${e.insertionOrder} | ${name} | ${keys} | ${e.insertionOrder} | ${priority} | ${enabled} | ${e.position} |`)
  }
  lines.push('')
  lines.push('## 条目详情')
  lines.push('')
  for (const e of sorted) {
    const name = e.name ?? `(未命名 ${e.sourceId})`
    lines.push(`### ${e.insertionOrder}. ${name}`)
    lines.push('')
    const allKeys = [...e.keys, ...e.secondaryKeys]
    lines.push(`- **关键词**: ${allKeys.length > 0 ? allKeys.join(', ') : '(无)'}`)
    lines.push(`- **启用**: ${e.enabled ? '是' : '否'}`)
    lines.push(`- **位置**: ${e.position}`)
    lines.push(`- **插入顺序**: ${e.insertionOrder}`)
    if (e.priority !== undefined) lines.push(`- **优先级**: ${e.priority}`)
    lines.push(`- **正则**: ${e.useRegex ? '是' : '否'}`)
    lines.push(`- **大小写敏感**: ${e.caseSensitive ? '是' : '否'}`)
    lines.push(`- **整词匹配**: ${e.matchWholeWords ? '是' : '否'}`)
    lines.push(`- **选择性**: ${e.selective ? '是' : '否'}`)
    lines.push(`- **常驻**: ${e.constant ? '是' : '否'}`)
    lines.push('')
    lines.push('**内容**:')
    lines.push('')
    lines.push('```')
    lines.push(e.content)
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 把一个角色卡的 lorebook 写盘为总条目目录 md,返回 `{ path, entryCount, mdContent }`。
 * 写盘失败抛错,由调用方决定 4xx 还是 5xx。
 */
async function writeLorebookIndex(character: PreprocessedCharacter): Promise<{
  path: string
  entryCount: number
  mdContent: string
} | null> {
  if (character.lorebook === undefined) return null
  const md = renderLorebookIndexMd(character)
  const safe = safeFileName(character.name)
  const target = join(ABS_WORLDBOOK_INDEX_DIR, `${safe}_index.md`)
  await mkdir(ABS_WORLDBOOK_INDEX_DIR, { recursive: true })
  await writeFile(target, md, 'utf-8')
  return { path: target, entryCount: character.lorebook.entries.length, mdContent: md }
}

// ─────────────────────────────────────────────────────────────────────────────
// Static file serving
// ─────────────────────────────────────────────────────────────────────────────

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  // Only allow exact /styles.css and / — everything else is a 404.
  if (pathname === '/styles.css') {
    return await serveFile(join(ABS_STATIC_DIR, 'styles.css'), 'text/css; charset=utf-8', res)
  }
  if (pathname === '/' || pathname === '/index.html') {
    return await serveFile(join(ABS_STATIC_DIR, 'index.html'), 'text/html; charset=utf-8', res)
  }
  return false
}

async function serveFile(absPath: string, contentType: string, res: ServerResponse): Promise<boolean> {
  try {
    const body = await readFile(absPath, 'utf8')
    sendText(res, 200, body, contentType)
    return true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/** Boot the HTTP server and bind to the given port. Resolves once listening. */
export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const state = buildState(options, process.env)
  // Extension updates are deliberately not automatic. Loading the local
  // registry is cheap and keeps the bundled adapters usable when offline.
  await state.extensions.load()
  // `--mock` is an explicit test/runtime choice. Do not let the persisted
  // real-provider config silently override it during boot.
  if (options.forceMock !== true) await loadApiConfig(state)

  // ST-Prompt-Template compatible EJS is evaluated in a bounded QuickJS
  // runtime. A failure disables EJS only; ordinary cards and the chat server
  // remain usable.
  try {
    state.ejsEngine = await EjsTemplateEngine.create()
  } catch (error: unknown) {
    state.ejsEngine = undefined
    process.stderr.write(`[ui-server] EJS template runtime unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
  }

  // Worldbook is loaded once at boot — the fixtures are static and small.
  const worldbook = await loadWorldbookFromDir(ABS_WORLDBOOK_DIR)
  ;(state as { fixtureWorldbook: WorldbookStore }).fixtureWorldbook = worldbook
  ;(state as { worldbook: WorldbookStore }).worldbook = worldbook

  // 加载用户 persona 库(必须在 loadPersisted 之前:恢复 currentPersonaId 时要校验库内存在)
  await state.personas.load()
  // 加载全局正则脚本库(酒馆 Regex 扩展)
  await state.regexScripts.load()
  // 加载世界书全局设置(酒馆 world_info_depth;缺省 scanDepth=2 + LLM 匹配)
  state.worldbookSettings = await loadWorldbookSettings()
  // 加载 ⑤ postprocess 开关(缺省 enabled=true)
  state.postprocessSettings = await loadPostprocessSettings()
  // 加载独立 MVU 变量处理配置(缺省启用,模型留空=复用主模型)
  state.mvuSettings = await loadMvuSettings()
  // 加载正文人称/字数设置(缺省跟随角色卡)
  state.responseSettings = await loadResponseSettings()
  // 从磁盘恢复角色库 / 会话 / UI 全局状态(best-effort,失败只打 warning)
  await loadPersisted(state)
  // 加载独立世界书(从 worldbooks/ 目录扫)
  await loadImportedWorldbooks(state)
  // 全部 load 完后,基于当前角色 rebuild worldbook(imported 必须等 load 完才能合并)
  ;(state as { worldbook: WorldbookStore }).worldbook = getMergedWorldbook(state, state.currentCharacterId)

  // Best-effort: load the prompt templates eagerly so the first /api/run
  // doesn't pay the cost. FilePromptLoader resolves on demand too, but
  // warming it surfaces filesystem problems at boot rather than mid-chat.
  const warm = new InMemoryPromptLoader()
  const warmLoader = new FilePromptLoader()
  for (const name of ['intent', 'worldbook-match', 'context-process', 'response', 'mvu', 'summarize']) {
    try { warm.set(name, await warmLoader.load(name)) } catch { /* ignore missing prompts */ }
  }
  void warm

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/styles.css')) {
        if (await serveStatic(url.pathname, res)) return
        return sendError(res, 404, `not found: ${url.pathname}`)
      }

      if (method === 'GET' && url.pathname === '/api/health') return handleHealth(state, res)
      if (method === 'GET' && url.pathname === '/api/state') return handleGetState(state, res)
      if (method === 'GET' && url.pathname === '/api/worldbook') return handleWorldbook(state, res)
      if (method === 'GET' && url.pathname === '/api/worldbook-md') return await handleWorldbookMd(state, req, res)
      if (method === 'GET' && url.pathname === '/api/sessions') return handleListSessions(state, res)
      if (method === 'GET' && url.pathname === '/api/history') return handleHistory(state, req, res)
      if (method === 'GET' && url.pathname === '/api/config') return handleGetConfig(state, res)
      if (method === 'GET' && url.pathname === '/api/models') return await handleGetModels(state, req, res)

      // ─── 酒馆范式:角色库路由 ───
      if (method === 'GET' && url.pathname === '/api/characters') return handleListCharacters(state, res)
      {
        const m = /^\/api\/characters\/([^/]+)$/u.exec(url.pathname)
        if (method === 'GET' && m !== null) return handleGetCharacter(state, decodeURIComponent(m[1] ?? ''), res)
      }
      {
        const m = /^\/api\/characters\/([^/]+)\/select$/u.exec(url.pathname)
        if (method === 'POST' && m !== null) return await handleSelectCharacter(state, decodeURIComponent(m[1] ?? ''), res)
      }
      {
        const m = /^\/api\/characters\/([^/]+)\/sessions$/u.exec(url.pathname)
        if (method === 'GET' && m !== null) return handleListCharacterSessions(state, decodeURIComponent(m[1] ?? ''), res)
      }
      {
        const m = /^\/api\/characters\/([^/]+)\/worldbook$/u.exec(url.pathname)
        if (method === 'GET' && m !== null) return handleGetCharacterWorldbook(state, decodeURIComponent(m[1] ?? ''), res)
      }
      {
        const m = /^\/api\/characters\/([^/]+)\/worldbook\/([^/]+)$/u.exec(url.pathname)
        if (method === 'PATCH' && m !== null) {
          return await handlePatchCharacterWorldbookEntry(
            state,
            decodeURIComponent(m[1] ?? ''),
            decodeURIComponent(m[2] ?? ''),
            req, res,
          )
        }
      }
      {
        const m = /^\/api\/characters\/([^/]+)\/worldbook-config$/u.exec(url.pathname)
        if (m !== null) {
          const cid = decodeURIComponent(m[1] ?? '')
          if (method === 'GET') return await handleGetCharacterWorldbookConfig(state, cid, res)
          if (method === 'PUT') return await handlePutCharacterWorldbookConfig(state, cid, req, res)
        }
      }

      // ─── 独立世界书库(酒馆 World Info .json 格式) ───
      if (method === 'GET' && url.pathname === '/api/worldbooks') return handleListImportedWorldbooks(state, res)
      if (method === 'POST' && url.pathname === '/api/worldbook-import') return await handleImportWorldbook(state, req, res)
      {
        const m = /^\/api\/worldbooks\/([^/]+)$/u.exec(url.pathname)
        if (method === 'GET' && m !== null) return handleGetImportedWorldbook(state, decodeURIComponent(m[1] ?? ''), res)
        if (method === 'DELETE' && m !== null) return await handleDeleteImportedWorldbook(state, decodeURIComponent(m[1] ?? ''), res)
      }
      {
        const m = /^\/api\/worldbooks\/([^/]+)\/entry\/([^/]+)$/u.exec(url.pathname)
        if (method === 'PATCH' && m !== null) {
          return await handlePatchImportedWorldbookEntry(
            state,
            decodeURIComponent(m[1] ?? ''),
            decodeURIComponent(m[2] ?? ''),
            req, res,
          )
        }
      }

      // ─── 用户 persona(酒馆 {{user}}) ───
      if (method === 'GET' && url.pathname === '/api/personas') return handleListPersonas(state, res)
      if (method === 'POST' && url.pathname === '/api/personas') return await handleCreatePersona(state, req, res)
      // ─── 世界书全局设置(酒馆 world_info_depth;绿灯扫描深度) ───
      if (method === 'GET' && url.pathname === '/api/worldbook-settings') return handleGetWorldbookSettings(state, res)
      if (method === 'PUT' && url.pathname === '/api/worldbook-settings') return await handlePutWorldbookSettings(state, req, res)
      // ─── ⑤ 后处理开关 ───
      if (method === 'GET' && url.pathname === '/api/postprocess-settings') return handleGetPostprocessSettings(state, res)
      if (method === 'PUT' && url.pathname === '/api/postprocess-settings') return await handlePutPostprocessSettings(state, req, res)
      if (method === 'POST' && url.pathname === '/api/postprocess-presets') return await handleCreatePostprocessPreset(state, req, res)
      {
        const m = /^\/api\/postprocess-presets\/([^/]+)$/u.exec(url.pathname)
        if (m !== null) {
          const id = decodeURIComponent(m[1] ?? '')
          if (method === 'PUT') return await handleUpdatePostprocessPreset(state, id, req, res)
          if (method === 'DELETE') return await handleDeletePostprocessPreset(state, id, res)
        }
      }
      // ─── 独立 MVU 变量处理模型/预设 ───
      if (method === 'GET' && url.pathname === '/api/mvu-settings') return handleGetMvuSettings(state, res)
      if (method === 'PUT' && url.pathname === '/api/mvu-settings') return await handlePutMvuSettings(state, req, res)
      if (method === 'POST' && url.pathname === '/api/mvu-presets') return await handleCreateMvuPreset(state, req, res)
      {
        const m = /^\/api\/mvu-presets\/([^/]+)$/u.exec(url.pathname)
        if (m !== null) {
          const id = decodeURIComponent(m[1] ?? '')
          if (method === 'PUT') return await handleUpdateMvuPreset(state, id, req, res)
          if (method === 'DELETE') return await handleDeleteMvuPreset(state, id, res)
        }
      }
      if (method === 'GET' && url.pathname === '/api/response-settings') return handleGetResponseSettings(state, res)
      if (method === 'PUT' && url.pathname === '/api/response-settings') return await handlePutResponseSettings(state, req, res)
      {
        const m = /^\/api\/personas\/([^/]+)$/u.exec(url.pathname)
        if (m !== null) {
          const pid = decodeURIComponent(m[1] ?? '')
          if (method === 'PUT') return await handleUpdatePersona(state, pid, req, res)
          if (method === 'DELETE') return await handleDeletePersona(state, pid, res)
        }
      }
      {
        const m = /^\/api\/personas\/([^/]+)\/select$/u.exec(url.pathname)
        if (method === 'POST' && m !== null) return await handleSelectPersona(state, decodeURIComponent(m[1] ?? ''), res)
      }

      // ─── 全局正则脚本(酒馆 Regex 扩展) ───
      if (method === 'GET' && url.pathname === '/api/regex') return handleListRegexScripts(state, res)
      if (method === 'POST' && url.pathname === '/api/regex') return await handleCreateRegexScript(state, req, res)
      if (method === 'POST' && url.pathname === '/api/regex-test') return await handleTestRegexScripts(state, req, res)
      {
        const m = /^\/api\/regex\/([^/]+)$/u.exec(url.pathname)
        if (m !== null) {
          const rid = decodeURIComponent(m[1] ?? '')
          if (method === 'PUT') return await handleUpdateRegexScript(state, rid, req, res)
          if (method === 'DELETE') return handleDeleteRegexScript(state, rid, res)
        }
      }

      // ─── agent prompt 编辑 ───
      if (method === 'GET' && url.pathname === '/api/prompts') return await handleListPrompts(state, res)
      {
        const m = /^\/api\/prompts\/([^/]+)$/u.exec(url.pathname)
        if (m !== null) {
          const name = decodeURIComponent(m[1] ?? '')
          if (method === 'GET') return await handleGetPrompt(state, name, res)
          if (method === 'PUT') return await handlePutPrompt(state, name, req, res)
        }
      }

      // ─── SillyTavern-compatible extension adapters / manual updates ───
      if (method === 'GET' && url.pathname === '/api/extensions') return handleListExtensions(state, res)
      if (method === 'POST' && url.pathname === '/api/extensions/check') return await handleCheckExtensions(state, req, res)
      if (method === 'POST' && url.pathname === '/api/extensions/update') return await handleUpdateExtension(state, req, res)
      if (method === 'POST' && url.pathname === '/api/extensions/activate') return await handleActivateExtension(state, req, res)
      if (method === 'POST' && url.pathname === '/api/extensions/rollback') return await handleRollbackExtension(state, req, res)

      // ─── 会话管理:trace 回看 / 重命名 / 删除 / 删单条消息 ───
      {
        const m = /^\/api\/sessions\/([^/]+)\/traces$/u.exec(url.pathname)
        if (method === 'GET' && m !== null) {
          return await handleGetSessionTraces(state, decodeURIComponent(m[1] ?? ''), req, res)
        }
      }
      {
        const m = /^\/api\/sessions\/([^/]+)\/message\/([^/]+)\/swipe$/u.exec(url.pathname)
        if (method === 'PUT' && m !== null) {
          return await handlePutMessageSwipe(
            state,
            decodeURIComponent(m[1] ?? ''),
            decodeURIComponent(m[2] ?? ''),
            req,
            res,
          )
        }
      }
      {
        const m = /^\/api\/sessions\/([^/]+)\/message\/([^/]+)$/u.exec(url.pathname)
        if (method === 'PUT' && m !== null) {
          return await handlePutMessage(state, decodeURIComponent(m[1] ?? ''), decodeURIComponent(m[2] ?? ''), req, res)
        }
        if (method === 'DELETE' && m !== null) {
          return await handleDeleteMessage(state, decodeURIComponent(m[1] ?? ''), decodeURIComponent(m[2] ?? ''), res)
        }
      }
      {
        const m = /^\/api\/sessions\/([^/]+)\/greeting$/u.exec(url.pathname)
        if (method === 'PUT' && m !== null) {
          return await handlePutSessionGreeting(state, decodeURIComponent(m[1] ?? ''), req, res)
        }
      }
      {
        const m = /^\/api\/sessions\/([^/]+)\/variables$/u.exec(url.pathname)
        if (m !== null) {
          const sid = decodeURIComponent(m[1] ?? '')
          if (method === 'GET') return await handleGetSessionVariables(state, sid, res)
          if (method === 'PUT' || method === 'POST') return await handlePutSessionVariables(state, sid, req, res)
        }
      }
      {
        const m = /^\/api\/sessions\/([^/]+)\/tavern-helper\/generate-raw$/u.exec(url.pathname)
        if (method === 'POST' && m !== null) {
          return await handleTavernGenerateRaw(state, decodeURIComponent(m[1] ?? ''), req, res)
        }
      }
      {
        const m = /^\/api\/sessions\/([^/]+)\/tavern-helper$/u.exec(url.pathname)
        if (method === 'GET' && m !== null) return handleGetSessionTavernHelper(state, decodeURIComponent(m[1] ?? ''), res)
        if (method === 'PUT' || method === 'POST') {
          if (m !== null) return await handlePutSessionTavernHelper(state, decodeURIComponent(m[1] ?? ''), req, res)
        }
      }
      {
        const m = /^\/api\/sessions\/([^/]+)$/u.exec(url.pathname)
        if (m !== null) {
          const sid = decodeURIComponent(m[1] ?? '')
          if (method === 'DELETE') return await handleDeleteSession(state, sid, res)
          if (method === 'PATCH') return await handlePatchSession(state, sid, req, res)
        }
      }

      if (method === 'POST' && url.pathname === '/api/import-png') return await handleImportPng(state, req, res)
      if (method === 'POST' && url.pathname === '/api/import-json') return await handleImportJson(state, req, res)
      if (method === 'POST' && url.pathname === '/api/session') return await handleSession(state, req, res)
      if (method === 'POST' && url.pathname === '/api/run') return await handleRun(state, req, res)

      if (method === 'PUT' && url.pathname === '/api/config') return await handlePutConfig(state, req, res)

      return sendError(res, 404, `no route: ${method} ${url.pathname}`)
    } catch (err) {
      // Last-resort catch so an unexpected throw in a handler can't take the
      // server down.
      console.error('[ui-server] handler crashed:', err)
      if (!res.headersSent) sendError(res, 500, `internal error: ${err instanceof Error ? err.message : String(err)}`)
      else res.end()
    }
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const bootCfg = getGlobalConfig(state)
  process.stderr.write(
    `[ui-server] listening on http://${host}:${port} (provider=${bootCfg.provider}, model=${bootCfg.model})\n`,
  )

  return {
    server,
    host,
    port,
    async close() {
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
