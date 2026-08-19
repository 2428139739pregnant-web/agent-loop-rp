/** Agent ③ — Final reply generation.
 *
 * Combines the three upstream products (① intent, 2.1 worldbook matches,
 * 2.2 context segmentation) with the preprocessed 3-document character card
 * into one system prompt, asks the LLM to stay in character, and returns the
 * raw reply plus light diagnostics (turn count, which subsystems actually
 * contributed). The output is plain text — no JSON parsing required.
 */

import type { PreprocessedCharacter } from '../character-loader.ts'
import type { ChatMessage } from '../provider.ts'
import type { WorldbookEntry } from '../session.ts'
import { substituteUserCharMacros } from '../persona-store.ts'
import {
  readMvuStateFromMessages,
  substituteMvuMacros,
} from '../../mvu.ts'
import {
  AI_OUTPUT_PLACEMENT,
  renderCharacterPromptView,
  USER_INPUT_PLACEMENT,
} from '../../frontend-regex.ts'
import {
  type ContextSegmentOutput,
  type IntentOutput,
  type ReplyResult,
  type WorldbookMatch,
  type WorldbookMatchOutput,
} from '../schema.ts'
import {
  buildResponseSettingsInstruction,
  DEFAULT_RESPONSE_SETTINGS,
  normalizeResponseSettings,
  responsePromptTokenBudget,
  responseMaxTokens,
  type ResponsePromptBudgetStats,
  type ResponseGenerationSettings,
} from '../response-settings.ts'
import type { Agent, AgentContext } from './types.ts'
import { applyPromptTemplateInjections } from '../../extensions/prompt-template-adapter.ts'
import { classifyWorldbookEntry } from '../worldbook-compat.ts'
import { applyTavernInjectedInChatPrompts } from '../../tavern-helper.ts'

/** Input contract for {@link responseAgent}. */
export interface ResponseInput {
  /** ① intent recognition output. */
  intent: IntentOutput
  /** 2.1 activated worldbook entries (already resolved to authoritative content). */
  worldbook: WorldbookMatchOutput
  /** 2.2 per-segment injection mode. */
  contextSegmentation: ContextSegmentOutput
  /** Raw user turn text, threaded through by the loop. */
  userInput: string
  /** 3-document character card, preprocessed at session bind time. */
  character: PreprocessedCharacter
  /** 用户 persona(酒馆 {{user}})。null = 未配置,系统按"用户"称呼。 */
  userPersona?: { name: string; description: string } | null
  /** 用户可配置的人称与正文长度；缺省时跟随角色卡。 */
  responseSettings?: ResponseGenerationSettings
}

/** Placeholder pattern, e.g. `{{persona}}`. */
const TEMPLATE_VAR_RE = /\{\{(\w+)\}\}/g

/** Placeholder when no worldbook entries activated. */
const NO_WORLDBOOK = '(无激活的世界书条目)'

/** Placeholder when no relevant history segments. */
const NO_HISTORY = '(无相关历史)'

/** Placeholder when the user gave no meta commands / no involved characters. */
const NO_META = '(无)'

/** Placeholder when the card carries no mes_example / system_prompt / post_history_instructions. */
const NO_EXAMPLE_DIALOGUE = '(无示例对话)'
const NO_CARD_SYSTEM_PROMPT = '(卡片未提供 system_prompt)'
const NO_POST_HISTORY = '(无回复后指令)'
/** Marker opt-in for the ST PromptManager-style message tree. */
export const ST_MESSAGE_TREE_MARKER = '<!-- agent-rp:st-message-tree -->'

function regexCharacter(card: PreprocessedCharacter): {
  readonly name: string
  readonly frontend: NonNullable<PreprocessedCharacter['raw']['frontend']>
} {
  return {
    name: card.name,
    frontend: card.raw.frontend ?? {
      regexScripts: [], tavernHelperScriptNames: [], tavernHelperScripts: [], tavernHelperVariables: {},
    },
  }
}

/** Render the supported ST-Prompt-Template EJS subset when the host provides it. */
function renderEjs(
  ctx: AgentContext,
  value: string,
  target?: { readonly worldInfoBookId?: string },
): string {
  if (!/<%[=_-]?[\s\S]*?%>/u.test(value) || ctx.renderTemplate === undefined) return value
  const rendered = ctx.renderTemplate(value, target)
  return rendered.ok === true ? rendered.text : value
}

/**
 * 独立世界书(worldbooks/)蓝灯条目的 position → 文档 映射(与 ST 的差异,§8 之 2):
 * 0/before_char → persona;1/after_char → worldview;其他 position(2-7)→ style 尾部。
 * 卡片内嵌书的蓝灯已在 preprocess 阶段合并进三文档,不会出现在 worldbook store,
 * 所以这里只会捞到独立书的蓝灯,无双重注入风险。
 */
export function constantWorldbookDoc(position: number | undefined): 'persona' | 'worldview' | 'style' {
  // position 缺省按 ST 默认 0(before)处理。
  const st = typeof position === 'number' && Number.isFinite(position) ? position : 0
  if (st === 0) return 'persona'
  if (st === 1) return 'worldview'
  return 'style'
}

/**
 * Return the standalone worldbook entries that the response stage injects on
 * every turn.  This is also used by the trace layer so the structured stage
 * input and the actual prompt describe the same source entries.
 */
export interface ConstantWorldbookTraceEntry {
  readonly path: string
  readonly order: number
  readonly position: number | undefined
  readonly content: string
}

export interface ConstantWorldbookOptions {
  /** ST applies probability after constant/keyword activation.  Trace callers
   * can disable the random draw and show all eligible constants. */
  readonly applyProbability?: boolean
  readonly random?: () => number
  /** When World Info budgeting ran, only these activated constant paths survive. */
  readonly allowedPaths?: ReadonlySet<string>
}

function passesWorldbookProbability(entry: WorldbookEntry, random: () => number): boolean {
  if (entry.useProbability === false) return true
  const probability = entry.probability ?? 100
  if (probability >= 100) return true
  if (probability <= 0) return false
  return random() * 100 <= probability
}

export function listConstantWorldbookEntries(
  worldbook: { list(): readonly WorldbookEntry[] },
  macro: (text: string) => string,
  options: ConstantWorldbookOptions = {},
): readonly ConstantWorldbookTraceEntry[] {
  return worldbook
    .list()
    .filter(e => e.constant === true
      && e.enabled !== false
      && classifyWorldbookEntry(e).owner !== 'plugin'
      && (options.allowedPaths === undefined || options.allowedPaths.has(e.path))
      && (options.applyProbability === false || passesWorldbookProbability(e, options.random ?? Math.random)))
    .sort((a, b) => b.order - a.order)
    .map(e => ({
      path: e.path,
      order: e.order,
      position: e.position,
      content: macro(e.content),
    }))
}

/**
 * 从 ctx.worldbook 提取**独立世界书**的蓝灯条目(constant && enabled),
 * 按 position 映射分到三文档,组内按 order **降序**拼接(ST world-info.js:87)。
 * 蓝灯语义 = 无条件每轮注入,不受消息内容/关键词影响(ST checkWorldInfo 第 3 步)。
 * 与 ST 的差异:ST 对 probability<100 的蓝灯也会掷骰,本项目蓝灯严格无条件。
 */
export function buildConstantWorldbookBlocks(
  worldbook: { list(): readonly WorldbookEntry[] },
  macro: (text: string) => string,
  options: ConstantWorldbookOptions = {},
): { persona: string; worldview: string; style: string } {
  const buckets: Record<'persona' | 'worldview' | 'style', string[]> = {
    persona: [], worldview: [], style: [],
  }
  const constants = listConstantWorldbookEntries(worldbook, macro, options)
  for (const e of constants) {
    buckets[constantWorldbookDoc(e.position)].push(
      `### ${e.path} (常驻条目,order=${e.order})\n${e.content}`,
    )
  }
  const render = (blocks: string[]): string =>
    blocks.length === 0 ? '' : `\n\n---\n\n## 常驻世界书条目(独立世界书蓝灯,每轮注入;按 order 降序)\n\n${blocks.join('\n\n')}`
  return {
    persona: render(buckets.persona),
    worldview: render(buckets.worldview),
    style: render(buckets.style),
  }
}

/**
 * Replace `{{name}}` placeholders in a template with values from `vars`.
 * Unknown variables are left untouched so the user can spot them in the
 * rendered prompt instead of silently losing data.
 */
export function renderTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return template.replace(TEMPLATE_VAR_RE, (match, key: string) => {
    const value = vars[key]
    return value === undefined ? match : value
  })
}

/**
 * Build the context block fed to the LLM, honoring the 2.2 segmentation.
 *
 * Segment ids are 1-based over assistant turns in `history` (user turns are
 * skipped — only the assistant's voice counts as a "segment"). Missing ids
 * default to `drop` so the LLM never sees a stale mode if 2.2 ever drops one.
 * The `_sessionId` parameter is reserved for the ④ summary hook and is
 * intentionally unused this round.
 */
export function buildContextBlock(
  segmentation: ContextSegmentOutput,
  history: readonly ChatMessage[],
  _sessionId: string,
  readSummary: (turn: number) => string | undefined,
  card?: PreprocessedCharacter,
  userName?: string,
): string {
  const lines: string[] = []
  let assistantTurn = 0
  for (const [historyIndex, msg] of history.entries()) {
    if (msg.role !== 'assistant') continue
    assistantTurn += 1
    const seg = segmentation.segments.find(s => s.id === assistantTurn)
    const mode = seg?.mode ?? 'drop'
    if (mode === 'drop') continue
    if (mode === 'full') {
      const content = card === undefined ? msg.content : renderCharacterPromptView(
        msg.content, regexCharacter(card),
        AI_OUTPUT_PLACEMENT,
        history.length - 1 - historyIndex,
        userName,
      )
      lines.push(`[对话 ${assistantTurn}]\n${content}\n`)
      continue
    }
    // mode === 'summary'
    const summary = readSummary(assistantTurn)
    if (summary) lines.push(`[对话 ${assistantTurn} 摘要]\n${summary}\n`)
  }
  return lines.join('\n')
}

/**
 * Build the ST-style chat-history message layer from context decisions.
 *
 * The old compatibility path flattened selected history into one system
 * string. SillyTavern's chat-completion path keeps each selected turn as a
 * real user/assistant message so role-sensitive presets and in-chat depth
 * injections can see the same message tree. The current user turn is removed
 * by the caller before this function is called.
 */
export function buildContextMessages(
  segmentation: ContextSegmentOutput,
  history: readonly ChatMessage[],
  readSummary: (turn: number) => string | undefined,
  card?: PreprocessedCharacter,
  userName?: string,
): ChatMessage[] {
  const decisions = new Map(segmentation.segments.map(segment => [segment.id, segment.mode]))
  const messages: ChatMessage[] = []
  const pending: Array<{ message: ChatMessage; index: number }> = []
  let assistantTurn = 0

  const renderHistoryMessage = (message: ChatMessage, index: number): ChatMessage => {
    if (card === undefined || message.role === 'system' || message.role === 'tool') return { ...message }
    const placement = message.role === 'assistant' ? AI_OUTPUT_PLACEMENT : USER_INPUT_PLACEMENT
    return {
      ...message,
      content: renderCharacterPromptView(
        message.content,
        regexCharacter(card),
        placement,
        history.length - 1 - index,
        userName,
      ),
    }
  }

  for (const [index, message] of history.entries()) {
    if (message.role !== 'assistant') {
      pending.push({ message, index })
      continue
    }
    assistantTurn += 1
    const mode = decisions.get(assistantTurn) ?? 'drop'
    if (mode === 'full') {
      for (const item of pending) messages.push(renderHistoryMessage(item.message, item.index))
      messages.push(renderHistoryMessage(message, index))
    } else if (mode === 'summary') {
      const summary = readSummary(assistantTurn)
      if (summary) messages.push({ role: 'system', content: `[对话 ${assistantTurn} 摘要]\n${summary}` })
    }
    pending.length = 0
  }
  return messages
}

/** A prompt inserted into the reversed ST chat-history surface. */
export interface STDepthPrompt {
  readonly content: string
  readonly depth: number
  readonly role: 'system' | 'user' | 'assistant'
  readonly order: number
}

/**
 * Parse a Character Card `mes_example` using SillyTavern's line-oriented
 * `<START>`/`name:` convention. ST sends each example line as a separate
 * system-role message with the speaker name stripped from the content; the
 * optional `name` is retained for providers that support it.
 */
export function parseSillyTavernExampleMessages(
  raw: string,
  userName: string | null | undefined,
  charName: string,
): ChatMessage[] {
  const normalized = raw.replace(/\r/gu, '')
  const blocks = /^\s*<START>\s*$/imu.test(normalized)
    ? normalized.split(/^\s*<START>\s*$/gimu)
    : [normalized]
  const labels = [...new Set([
    userName?.trim() || '{{user}}',
    charName.trim() || '{{char}}',
    '{{user}}',
    '{{char}}',
  ].filter(Boolean))]
  const result: ChatMessage[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    let current: { label: string; lines: string[] } | undefined
    let sawSpeaker = false
    const flush = (): void => {
      if (current === undefined) return
      const content = current.lines.join('\n').trim()
      if (content.length > 0) result.push({ role: 'system', content, name: current.label })
      current = undefined
    }
    for (const line of lines) {
      const label = labels.find(candidate => line.startsWith(`${candidate}:`))
      if (label !== undefined) {
        flush()
        sawSpeaker = true
        current = { label, lines: [line.slice(label.length + 1).replace(/^\s+/u, '')] }
      } else if (current !== undefined) {
        current.lines.push(line)
      }
    }
    flush()
    // A malformed/non-labelled example should remain visible instead of
    // silently disappearing. ST's parser normally gets labelled blocks, but
    // cards in the wild sometimes provide a prose-only example.
    if (!sawSpeaker && block.trim().length > 0) {
      result.push({ role: 'system', content: block.trim() })
    }
  }
  return result
}

/**
 * Apply ST's at-depth insertion rule to an oldest-to-newest message array.
 * Prompts are grouped by depth, order (descending), then system/user/
 * assistant role, inserted into the reversed history, and reversed back.
 */
export function applySillyTavernDepthPrompts(
  baseMessages: readonly ChatMessage[],
  prompts: readonly STDepthPrompt[],
): ChatMessage[] {
  const byDepth = new Map<number, STDepthPrompt[]>()
  for (const prompt of prompts) {
    if (prompt.content.trim().length === 0) continue
    const depth = Math.max(0, Math.trunc(prompt.depth))
    const bucket = byDepth.get(depth) ?? []
    bucket.push(prompt)
    byDepth.set(depth, bucket)
  }
  if (byDepth.size === 0) return baseMessages.map(message => ({ ...message }))
  const messages = baseMessages.map(message => ({ ...message })).reverse()
  let totalInsertedMessages = 0
  const roleOrder: readonly STDepthPrompt['role'][] = ['system', 'user', 'assistant']
  for (const depth of [...byDepth.keys()].sort((left, right) => left - right)) {
    const depthPrompts = byDepth.get(depth) ?? []
    const orders = [...new Set(depthPrompts.map(prompt => prompt.order))].sort((left, right) => right - left)
    const roleMessages: ChatMessage[] = []
    for (const order of orders) {
      const orderPrompts = depthPrompts.filter(prompt => prompt.order === order)
      for (const role of roleOrder) {
        const content = orderPrompts
          .filter(prompt => prompt.role === role)
          .map(prompt => prompt.content.trim())
          .filter(Boolean)
          .join('\n')
        if (content.length > 0) roleMessages.push({ role, content })
      }
    }
    if (roleMessages.length === 0) continue
    const index = Math.min(depth + totalInsertedMessages, messages.length)
    messages.splice(index, 0, ...roleMessages)
    totalInsertedMessages += roleMessages.length
  }
  return messages.reverse()
}

function estimateResponseMessageTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => {
    const name = message.name === undefined ? '' : message.name
    // Chat-completion tokenizers charge a small per-message envelope in
    // addition to content. This conservative chars/4 estimate is also the
    // fallback used by the host token tracker when a provider reports none.
    return total + Math.max(1, Math.ceil([...`${name}\n${message.content}`].length / 4)) + 4
  }, 0)
}

/**
 * Apply the ST/OpenAI context-window rule to the already assembled message
 * tree. `assemble` is rerun after every removal so depth and extension
 * injections are recalculated against the shortened history rather than
 * leaving stale message indexes behind.
 */
export function fitResponsePromptToBudget(
  history: readonly ChatMessage[],
  settings: ResponseGenerationSettings,
  assemble: (history: readonly ChatMessage[]) => readonly ChatMessage[],
): { messages: ChatMessage[]; stats: ResponsePromptBudgetStats } {
  const contextTokens = settings.maxContextTokens ?? 32_768
  const promptBudgetTokens = responsePromptTokenBudget(settings)
  const originalHistoryTokens = estimateResponseMessageTokens(history)
  let candidate = history.map(message => ({ ...message }))
  let messages = [...assemble(candidate)]
  let estimatedPromptTokens = estimateResponseMessageTokens(messages)
  let droppedHistoryMessages = 0

  while (estimatedPromptTokens > promptBudgetTokens && candidate.length > 1) {
    // The last message is the current user turn. Remove the oldest complete
    // user/assistant pair where possible; this keeps the remaining chat
    // history role-balanced and never drops the current request.
    let removeCount = 1
    const first = candidate[0]
    const second = candidate[1]
    if (first?.role === 'user' && second?.role === 'assistant' && candidate.length - 2 >= 1) {
      removeCount = 2
    }
    candidate = candidate.slice(removeCount)
    droppedHistoryMessages += removeCount
    messages = [...assemble(candidate)]
    estimatedPromptTokens = estimateResponseMessageTokens(messages)
  }

  const keptHistoryTokens = estimateResponseMessageTokens(candidate)
  return {
    messages,
    stats: {
      contextTokens,
      promptBudgetTokens,
      estimatedPromptTokens,
      droppedHistoryMessages,
      droppedHistoryTokens: Math.max(0, originalHistoryTokens - keptHistoryTokens),
      keptHistoryMessages: candidate.length,
      overBudget: estimatedPromptTokens > promptBudgetTokens,
    },
  }
}

/**
 * Render worldbook matches as a markdown block, sorted by (order asc,
 * weight desc). 2.1 already sorts, this re-sorts defensively in case the
 * upstream ordering ever drifts.
 */
export function buildWorldbookBlock(
  matches: WorldbookMatchOutput,
  card?: PreprocessedCharacter,
  userName?: string,
): string {
  if (matches.matches.length === 0) return ''
  const sorted = [...matches.matches].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return b.weight - a.weight
  })
  return sorted
    .map(m => `### ${m.path} (order=${m.order}, weight=${m.weight})\n${card === undefined
      ? m.content
      : renderCharacterPromptView(m.content, regexCharacter(card), 5, undefined, userName)}`)
    .join('\n\n')
}

/**
 * Split activated World Info entries according to ST's eight insertion
 * positions.  The response prompt is intentionally still one configurable
 * template, so the buckets map onto its closest stable anchors (persona,
 * examples, author-note/post-history, atDepth and the legacy worldbook
 * block).  Keeping the split here prevents every caller from silently
 * flattening positions back into one undifferentiated paragraph.
 */
export interface WorldbookMatchPlacementBuckets {
  beforeCharacter: WorldbookMatch[]
  afterCharacter: WorldbookMatch[]
  beforeExamples: WorldbookMatch[]
  afterExamples: WorldbookMatch[]
  beforeAuthorNote: WorldbookMatch[]
  afterAuthorNote: WorldbookMatch[]
  atDepth: WorldbookMatch[]
  outlet: WorldbookMatch[]
  unplaced: WorldbookMatch[]
}

function sortedWorldbookMatches(matches: readonly WorldbookMatch[]): WorldbookMatch[] {
  return [...matches].sort((a, b) => a.order - b.order || b.weight - a.weight || a.path.localeCompare(b.path))
}

export function splitWorldbookMatches(
  matches: readonly WorldbookMatch[],
): WorldbookMatchPlacementBuckets {
  const buckets: WorldbookMatchPlacementBuckets = {
    beforeCharacter: [],
    afterCharacter: [],
    beforeExamples: [],
    afterExamples: [],
    beforeAuthorNote: [],
    afterAuthorNote: [],
    atDepth: [],
    outlet: [],
    unplaced: [],
  }
  for (const match of sortedWorldbookMatches(matches)) {
    switch (match.position) {
      case 0: buckets.beforeCharacter.push(match); break
      case 1: buckets.afterCharacter.push(match); break
      case 2: buckets.beforeExamples.push(match); break
      case 3: buckets.afterExamples.push(match); break
      case 4: buckets.atDepth.push(match); break
      case 5: buckets.beforeAuthorNote.push(match); break
      case 6: buckets.afterAuthorNote.push(match); break
      case 7: buckets.outlet.push(match); break
      default: buckets.unplaced.push(match); break
    }
  }
  return buckets
}

function formatWorldbookFragments(
  entries: readonly WorldbookMatch[],
  card: PreprocessedCharacter,
  userName: string | undefined,
  label: string,
): string {
  if (entries.length === 0) return ''
  const body = sortedWorldbookMatches(entries)
    .map(match => `### ${match.path} (order=${match.order}, weight=${match.weight})\n${renderCharacterPromptView(
      match.content,
      regexCharacter(card),
      5,
      undefined,
      userName,
    )}`)
    .join('\n\n')
  return `\n\n---\n\n## ${label}\n\n${body}`
}

export const responseAgent: Agent<ResponseInput, ReplyResult> = {
  name: 'response',

  async run(input: ResponseInput, ctx: AgentContext): Promise<ReplyResult> {
    const responseSettings = normalizeResponseSettings(
      input.responseSettings ?? DEFAULT_RESPONSE_SETTINGS,
    )
    // 1. Load + render the system prompt.
    const template = renderEjs(ctx, await ctx.prompts.load('response'))
    const useStMessageTree = template.includes(ST_MESSAGE_TREE_MARKER)
    const history = ctx.session.getHistory(ctx.sessionId)
    const currentMvu = ctx.statData === undefined
      ? readMvuStateFromMessages(input.character.raw, history)
      : { statData: ctx.statData, updateCount: 0 }
    const statData = currentMvu?.statData

    const metaCommandsBlock = input.intent.metaCommands.length > 0
      ? input.intent.metaCommands.join('\n')
      : NO_META
    const involvedBlock = input.intent.involvedCharacters.length > 0
      ? input.intent.involvedCharacters.join(', ')
      : NO_META

    // {{user}}/{{char}} 宏替换:角色三文档 + 世界书块 + 用户人设描述统一过一遍,
    // 保证卡文本里的 {{user}} 在进 prompt 前就落到实际用户名(酒馆同款时机)。
    const userName = input.userPersona?.name ?? null
    const charName = input.character.name
    const macro = (text: string): string =>
      substituteUserCharMacros(substituteMvuMacros(renderEjs(ctx, text), statData), userName, charName)
    const contextBlockFallback = buildContextBlock(
      input.contextSegmentation,
      history,
      ctx.sessionId,
      // Stub: ④ summary agent isn't wired in yet, so no summaries available.
      () => undefined,
      input.character,
      userName ?? undefined,
    )
    // The session already contains the just-appended user turn. Do not send
    // it once as history and once as the current generation input.
    const historyBeforeCurrent = history.at(-1)?.role === 'user'
      && history.at(-1)?.content === input.userInput
      ? history.slice(0, -1)
      : history
    const contextMessages = buildContextMessages(
      input.contextSegmentation,
      historyBeforeCurrent,
      () => undefined,
      input.character,
      userName ?? undefined,
    )
    // Keep custom response templates informative while avoiding duplicate
    // history: selected turns now travel as real chat messages below.
    const contextBlock = contextMessages.length > 0
      ? '(相关历史已按 ST chatHistory 消息层注入)'
      : contextBlockFallback
    const resolvedWorldbookMatches = input.worldbook.matches.map(match => ({
      ...match,
      content: renderEjs(ctx, match.content),
    }))
    const worldbookPlacement = splitWorldbookMatches(resolvedWorldbookMatches)
    const worldbookBlock = buildWorldbookBlock({
      matches: worldbookPlacement.unplaced.concat(worldbookPlacement.outlet),
    }, input.character, userName ?? undefined)

    // 用户人设段:有 persona 且带描述时注入;只有名字时也注入名字段(角色至少
    // 该知道怎么称呼用户);完全没配置时留占位,提示模型用"用户"泛称。
    const userPersonaBlock = input.userPersona !== undefined && input.userPersona !== null
      ? (input.userPersona.description.length > 0
        ? `名字:${input.userPersona.name}\n${input.userPersona.description}`
        : `名字:${input.userPersona.name}\n(未提供详细人设,以"用户"身份参与剧情)`)
      : '(未配置用户人设,以"用户"泛称)'

    // 独立世界书蓝灯条目:position 映射追加进三文档尾部(每轮注入,不受消息影响)。
    // 卡片内嵌书的蓝灯已在 preprocess 合并进文档,这里只处理 worldbooks/ 的独立书。
    const constantBlocks = buildConstantWorldbookBlocks(ctx.worldbook, macro, {
      ...(input.worldbook.budget?.keptConstantPaths === undefined
        ? {} : { allowedPaths: new Set(input.worldbook.budget.keptConstantPaths) }),
    })

    // 三个新字段(mes_example / system_prompt / post_history_instructions)都过宏替换。
    // 旧存档/旧客户端可能不带这些字段(undefined),兜底空串 → 占位文案。
    const mesExample = macro(input.character.mesExample ?? '')
    const cardSystemPrompt = macro(input.character.systemPrompt ?? '')
    const worldbookBeforeCharacter = formatWorldbookFragments(
      worldbookPlacement.beforeCharacter,
      input.character,
      userName ?? undefined,
      '世界书 Before Character Definition',
    )
    const worldbookAfterCharacter = formatWorldbookFragments(
      worldbookPlacement.afterCharacter,
      input.character,
      userName ?? undefined,
      '世界书 After Character Definition',
    )
    const worldbookBeforeExamples = formatWorldbookFragments(
      worldbookPlacement.beforeExamples,
      input.character,
      userName ?? undefined,
      '世界书 Before Example Messages',
    )
    const worldbookAfterExamples = formatWorldbookFragments(
      worldbookPlacement.afterExamples,
      input.character,
      userName ?? undefined,
      '世界书 After Example Messages',
    )
    const worldbookBeforeAuthorNote = formatWorldbookFragments(
      worldbookPlacement.beforeAuthorNote,
      input.character,
      userName ?? undefined,
      '世界书 Before Author Note',
    )
    const worldbookAfterAuthorNote = formatWorldbookFragments(
      worldbookPlacement.afterAuthorNote,
      input.character,
      userName ?? undefined,
      '世界书 After Author Note',
    )
    const postHistoryInstructions = macro(input.character.postHistoryInstructions ?? '')
      + worldbookBeforeAuthorNote
      + worldbookAfterAuthorNote
    const exampleDialogue = worldbookBeforeExamples
      + (mesExample.length > 0 ? mesExample : NO_EXAMPLE_DIALOGUE)
      + worldbookAfterExamples
    const atDepthWorldbook = (input.character.atDepthLorebookEntries ?? []).map(entry =>
      `### ${entry.name ?? `世界书 #${entry.insertionOrder}`} (atDepth=${entry.stPosition ?? 4})\n${macro(entry.content)}`,
    )
    const dynamicAtDepth = worldbookPlacement.atDepth.map(entry =>
      `### ${entry.path} (atDepth=${entry.depth ?? 4}, order=${entry.order})\n${macro(entry.content)}`,
    )

    const responseSettingsInstruction = buildResponseSettingsInstruction(responseSettings)
    const renderedSystemPrompt = renderTemplate(template, {
      character_name: macro(input.character.name),
      persona: macro(input.character.persona) + constantBlocks.persona + worldbookBeforeCharacter,
      worldview: macro(input.character.worldview) + constantBlocks.worldview + worldbookAfterCharacter,
      style: macro(input.character.style) + constantBlocks.style,
      at_depth_worldbook: atDepthWorldbook.concat(dynamicAtDepth).join('\n\n') || '(无 atDepth 条目)',
      mvu_state: statData === undefined ? '(未启用 MVU)' : JSON.stringify(statData, null, 2),
      user_persona: macro(userPersonaBlock),
      card_system_prompt: cardSystemPrompt.length > 0 ? cardSystemPrompt : NO_CARD_SYSTEM_PROMPT,
      example_dialogue: exampleDialogue,
      post_history_instructions: postHistoryInstructions.length > 0 ? postHistoryInstructions : NO_POST_HISTORY,
      user_narration: input.intent.userNarration,
      meta_commands: metaCommandsBlock,
      involved_characters: involvedBlock,
      keywords: input.intent.keywords.join(', '),
      intent_context: [
        `用户叙述：${input.intent.userNarration}`,
        `元指令：${metaCommandsBlock}`,
        `涉及角色：${involvedBlock}`,
        `关键词：${input.intent.keywords.join(', ') || NO_META}`,
      ].join('\n'),
      worldbook_block: macro(worldbookBlock) || NO_WORLDBOOK,
      context_block: contextBlock || NO_HISTORY,
      response_settings: responseSettingsInstruction,
    })
    // Keep the setting effective even when a user replaces response.md with a
    // custom template that does not include the new placeholder.
    const systemPrompt = template.includes('{{response_settings}}')
      ? renderedSystemPrompt
      : `${renderedSystemPrompt}\n\n## 当前回复设置（用户可配置）\n\n${responseSettingsInstruction}`

    const promptUserInput = renderCharacterPromptView(
      input.userInput,
      regexCharacter(input.character),
      USER_INPUT_PLACEMENT,
      0,
      userName ?? undefined,
    )

    // 2. Apply ST-Prompt-Template prompt injections to the exact message array
    //    that this project sends. This is deterministic and happens before the
    //    one existing response call; it never creates a second LLM stage.
    const depthPrompts: STDepthPrompt[] = [
      ...(input.character.atDepthLorebookEntries ?? []).map(entry => ({
        content: `### ${entry.name ?? `世界书 #${entry.insertionOrder}`}\n${macro(entry.content)}`,
        depth: typeof entry.depth === 'number' ? entry.depth : 4,
        role: entry.role ?? 'system',
        order: entry.insertionOrder,
      })),
      ...worldbookPlacement.atDepth.map(entry => ({
        content: `### ${entry.path} (atDepth=${entry.depth ?? 4}, order=${entry.order})\n${macro(entry.content)}`,
        depth: entry.depth ?? 4,
        role: entry.role ?? 'system',
        order: entry.order,
      })),
    ]
    const pluginOutput = input.worldbook.plugin ?? {
      promptInjections: [],
      renderDirectives: [],
      skipped: [],
    }
    const assemblePromptMessages = (historyBase: readonly ChatMessage[]): ChatMessage[] => {
      const historyAndCurrent = useStMessageTree
        ? applySillyTavernDepthPrompts(historyBase, depthPrompts)
        : historyBase.map(message => ({ ...message }))
      const structuredMessages: ChatMessage[] = useStMessageTree
        ? [
          { role: 'system', content: renderedSystemPrompt.replace(ST_MESSAGE_TREE_MARKER, '').trim() },
          ...(worldbookBeforeCharacter.trim() ? [{ role: 'system' as const, content: worldbookBeforeCharacter.trim() }] : []),
          { role: 'system', content: `角色名：${macro(input.character.name)}\n\n${macro(input.character.persona) + constantBlocks.persona}` },
          ...(worldbookAfterCharacter.trim() ? [{ role: 'system' as const, content: worldbookAfterCharacter.trim() }] : []),
          { role: 'system', content: macro(input.character.style) + constantBlocks.style },
          { role: 'system', content: macro(input.character.worldview) + constantBlocks.worldview },
          ...(macro(userPersonaBlock).trim() ? [{ role: 'system' as const, content: `用户人设：\n${macro(userPersonaBlock).trim()}` }] : []),
          ...(worldbookBlock.trim() ? [{ role: 'system' as const, content: `激活的世界书条目：\n${macro(worldbookBlock).trim()}` }] : []),
          ...(worldbookBeforeExamples.trim() ? [{ role: 'system' as const, content: worldbookBeforeExamples.trim() }] : []),
          ...(mesExample.trim().length > 0 ? [{ role: 'system' as const, content: '[Example Chat]' }] : []),
          ...parseSillyTavernExampleMessages(mesExample, userName, charName),
          ...(worldbookAfterExamples.trim() ? [{ role: 'system' as const, content: worldbookAfterExamples.trim() }] : []),
          ...historyAndCurrent,
          ...(postHistoryInstructions.trim() ? [{ role: 'system' as const, content: postHistoryInstructions.trim() }] : []),
        ]
        : [
          { role: 'system', content: systemPrompt },
          ...historyAndCurrent,
        ]
      const promptTemplateMessages = applyPromptTemplateInjections(structuredMessages, pluginOutput)
      return applyTavernInjectedInChatPrompts(promptTemplateMessages, ctx.tavernHelperState)
    }
    const budgeted = fitResponsePromptToBudget([
      ...contextMessages,
      { role: 'user', content: promptUserInput },
    ], responseSettings, assemblePromptMessages)
    const promptMessages = budgeted.messages

    // 3. Call the LLM. Plain text — no response_format.
    const maxTokens = responseMaxTokens(responseSettings)
    const result = await ctx.provider.chat(
      promptMessages,
      {
        model: ctx.model,
        temperature: ctx.temperature,
        ...(maxTokens === undefined
          ? {}
          : { max_tokens: maxTokens }),
      },
    )

    return {
      reply: result.content,
      sessionId: ctx.sessionId,
      turn: ctx.session.turnCount(ctx.sessionId),
      usedWorldbook: input.worldbook.matches.length > 0,
      usedContextSegmentation: input.contextSegmentation.segments.length > 0,
      promptBudget: budgeted.stats,
    }
  },
}
