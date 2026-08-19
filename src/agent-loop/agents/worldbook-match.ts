/** Agent 2.1 — Worldbook green-light (keyed) entry matching, SillyTavern 语义适配.
 *
 * 架构决定(与 ST 的差异,docs/st-adaptation-research.md §8):
 *  - 普通绿灯按 WorldbookSettings.mode 处理:strict=ST 关键词,enhanced=ST
 *    基线+LLM 语义追加,native=LLM 语义判断。enhanced/native 都只调用一次
 *    worldbook agent;strict 不调用它。
 *  - ST 的关键词/次关键词逻辑(AND_ANY/NOT_ALL/NOT_ANY/AND_ALL、大小写、整词、
 *    /regex/ 写法)在本地确定性路径执行,作为 enhanced 的基线和 agent 的安全回退。
 *  - probability 掷骰与 {{user}}/{{char}} 宏替换在**代码层**收尾:
 *    key/content 先过 substituteUserCharMacros 再入参(ST 同款时机),
 *    agent 选中后按 `Math.random()*100 <= probability` 掷骰(ST world-info.js:4907-4925)。
 *  - 蓝灯(constant)条目不进本 agent:卡片内嵌书的蓝灯在 preprocess 阶段已合并进
 *    三文档,独立世界书的蓝灯由 ③ response 直接常驻注入(见 response.ts)。
 *    这里构建候选时把 constant / 禁用条目全部排除,避免双重注入。
 *  - 扩展控制条目(@INJECT/[GENERATE]/[RENDER]/decorator)在分类阶段隔离出
 *    plugin lane,不得被 agent 重新解释;EJS-only 条目仍可按普通绿灯激活,
 *    激活后由 response 的隔离渲染器展开。
 */

import {
  WorldbookMatchOutputSchema,
  type IntentOutput,
  type WorldbookMatch,
  type WorldbookMatchOutput,
} from '../schema.ts'
import { substituteUserCharMacros } from '../persona-store.ts'
import type { ChatMessage } from '../provider.ts'
import {
  DEFAULT_WORLDBOOK_SETTINGS,
  resolveWorldbookMatchMode,
  type Agent,
  type AgentContext,
  type WorldbookMatchMode,
} from './types.ts'
import { classifyWorldbookEntry, type WorldbookEntryOwner, type WorldbookPluginKind } from '../worldbook-compat.ts'
import { resolveWorldbookMatches } from '../worldbook-resolver.ts'
import { buildWorldbookPluginOutput } from '../worldbook-plugin.ts'
import { renderWorldbookKeyOnlyMd } from '../worldbook-key-index.ts'
import {
  canEvaluateTimedEffect,
  isTimedEffectStickyActive,
  type TimedEffectState,
} from '../worldbook-timed-effects.ts'

/** 扫描文本里的单条消息(ST:最近 world_info_depth 条聊天消息,user/assistant 都算)。 */
export interface WorldbookScanMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 一条候选绿灯条目的结构化参数(已过 {{user}}/{{char}} 宏替换)。 */
export interface WorldbookMatchCandidate {
  /** 世界书条目路径(唯一标识,agent 只回 path)。 */
  path: string
  /** 条目名(展示用,ST comment)。 */
  comment: string
  /** 主关键词(key,宏替换后)。 */
  keys: readonly string[]
  /** 次关键词(keysecondary,宏替换后)。 */
  secondaryKeys: readonly string[]
  /** 次关键词逻辑:and-any(0=AND_ANY) / not-all(1=NOT_ALL) / not-any(2=NOT_ANY) / and-all(3=AND_ALL)。 */
  selectiveLogic: 'and-any' | 'and-all' | 'not-any' | 'not-all'
  /** 是否启用次关键词筛选；false 时 ST 会忽略 secondary_keys。 */
  selective?: boolean
  /** ST 条目级大小写敏感(默认 false)。 */
  caseSensitive: boolean
  /** ST 条目级整词匹配(默认 false,子串匹配)。 */
  matchWholeWords: boolean
  /** ST 正则 key(/pattern/flags 写法)标记。 */
  useRegex: boolean
  /** ST 激活概率 %(默认 100;由代码掷骰,agent 无需考虑)。 */
  probability: number
  /** ST 概率开关(默认 true;false = 跳过掷骰恒通过)。 */
  useProbability: boolean
  /** ST blue-light marker, retained for special extension semantics. */
  constant?: boolean
  /** ST entry-level scan depth override. */
  scanDepth?: number
  /** Whether the source worldbook may scan newly activated entry content. */
  recursiveScanning?: boolean
  /** Stable source-book identity used to isolate recursive buffers. */
  recursiveBookId?: string
  /** ST `extensions.exclude_recursion`: this entry cannot activate from recursive text. */
  excludeRecursion?: boolean
  /** ST `extensions.prevent_recursion`: this entry's content is not scanned recursively. */
  preventRecursion?: boolean
  /** ST `extensions.delay_until_recursion`: true = level 1, number = that level. */
  delayUntilRecursion?: boolean | number
  sticky?: number
  cooldown?: number
  delay?: number
  /** Macro-expanded authoritative content used only by the local recursive scanner. */
  recursiveContent?: string
  /** ST prompt insertion metadata retained after activation. */
  position?: number
  depth?: number
  role?: 'system' | 'user' | 'assistant'
  /** Decorated entries are preserved for export but are not executable here. */
  hasDecorators?: boolean
  order: number
  weight: number
  /** Which subsystem owns this entry's activation decision. */
  owner?: WorldbookEntryOwner
  /** Special extension features detected during preprocessing. */
  pluginKinds?: readonly WorldbookPluginKind[]
  /** Deterministic ST activation result used by the extension compatibility lane. */
  active?: boolean
}

/** Agent 2.1 的结构化输入:最近 N 条消息 + 候选绿灯条目参数表。 */
export interface WorldbookMatchInput {
  /** ① 的意图识别输出(关键词等作为扫描文本的补充)。 */
  intent: IntentOutput
  /** 扫描深度 N(条消息)。 */
  scanDepth: number
  /** 最近 N 条消息(时间升序,最后一条最新)。 */
  recentMessages: readonly WorldbookScanMessage[]
  /** 候选绿灯条目(已剔除蓝灯/禁用条目,key 已过宏替换)。 */
  candidates: readonly WorldbookMatchCandidate[]
  /** ST-Prompt-Template/扩展条目，仅用于 trace 与后续兼容适配，不进 agent 候选池。 */
  pluginCandidates?: readonly WorldbookMatchCandidate[]
  /**
   * Code-generated merged key-only Markdown for the current worldbook
   * combination. The LLM prompt reads this compact index instead of receiving
   * full worldbook content. Optional for backwards-compatible callers/tests;
   * the agent falls back to the in-memory formatter when omitted.
   */
  keyIndexMarkdown?: string
  /** Explicit worldbook mode; omitted callers use the context setting. */
  mode?: WorldbookMatchMode
  /** Session-local World Info timed effects; rerolls reuse this snapshot. */
  timedEffects?: TimedEffectState
  /** Model-visible message count before this generation starts. */
  messageCount?: number
}

/** 单条消息文本超长时的截断上限(字符数近似 token,§8 差异之 4:无 tokenizer 依赖)。 */
const SCAN_MESSAGE_MAX_CHARS = 2000

/** 条目名兜底:未命名时用路径最后一段。 */
function entryComment(path: string): string {
  const last = path.split('/').pop() ?? path
  return last.replace(/\.md$/u, '')
}

/**
 * 从 AgentContext 组装 2.1 的结构化输入:
 *  - `recentMessages`:会话历史里最近 `ctx.worldbookSettings.scanDepth`(默认 2)条消息;
 *  - `candidates`:`ctx.worldbook.list()` 里的**绿灯**条目(enabled && 非 constant),
 *    key/secondaryKey 先过 {{user}}/{{char}} 宏替换(ST 语义:匹配前替换)。
 *
 * 该函数独立导出,让 loop / ui-server 用同一份输入喂 agent,并让 agent-trace
 * 能看到完整的结构化输入(消息 + 条目参数表)。
 */
export function buildWorldbookMatchInput(intent: IntentOutput, ctx: AgentContext): WorldbookMatchInput {
  const settings = ctx.worldbookSettings ?? DEFAULT_WORLDBOOK_SETTINGS
  const scanDepth = Number.isFinite(settings.scanDepth) && settings.scanDepth >= 0
    ? Math.floor(settings.scanDepth)
    : DEFAULT_WORLDBOOK_SETTINGS.scanDepth

  // 最近 N 条消息(任意角色,'tool' 不算扫描文本)。单条超长截断,防止 prompt 爆炸。
  const history = ctx.session.getHistory(ctx.sessionId) as readonly ChatMessage[]
  const recentMessages: WorldbookScanMessage[] = history
    .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
    .slice(-scanDepth)
    .map(m => ({
      role: (m.role === 'assistant' || m.role === 'system') ? m.role : 'user',
      content: m.content.length > SCAN_MESSAGE_MAX_CHARS
        ? `${m.content.slice(0, SCAN_MESSAGE_MAX_CHARS)}…(已截断)`
        : m.content,
    }))

  const macro = (text: string): string =>
    substituteUserCharMacros(text, ctx.macros?.user ?? null, ctx.macros?.char ?? null)

  // 绿灯候选:蓝灯普通条目由 response 常驻注入;但 special plugin entries
  // (例如 [GENERATE] blue entries) 仍必须进入兼容 lane。
  const candidates: WorldbookMatchCandidate[] = []
  const pluginCandidates: WorldbookMatchCandidate[] = []
  for (const e of ctx.worldbook.list()) {
    const classification = classifyWorldbookEntry(e)
    if (e.enabled === false && classification.owner !== 'plugin') continue // ST disable → 完全跳过
    const candidate: WorldbookMatchCandidate = {
      path: e.path,
      comment: e.comment ?? entryComment(e.path),
      keys: e.keywords.map(k => macro(k)),
      secondaryKeys: (e.secondaryKeywords ?? []).map(k => macro(k)),
      selectiveLogic: e.selectiveLogic ?? 'and-any',
      selective: e.selective === true,
      caseSensitive: e.caseSensitive === true,
      matchWholeWords: e.matchWholeWords === true,
      useRegex: e.useRegex === true,
      probability: typeof e.probability === 'number' ? e.probability : 100,
      useProbability: e.useProbability !== false,
      ...(e.constant === undefined ? {} : { constant: e.constant }),
      ...(e.scanDepth === undefined ? {} : { scanDepth: e.scanDepth }),
      ...(e.recursiveScanning === undefined ? {} : { recursiveScanning: e.recursiveScanning }),
      ...(e.recursiveBookId === undefined ? {} : { recursiveBookId: e.recursiveBookId }),
      ...(e.excludeRecursion === undefined ? {} : { excludeRecursion: e.excludeRecursion }),
      ...(e.preventRecursion === undefined ? {} : { preventRecursion: e.preventRecursion }),
      ...(e.delayUntilRecursion === undefined ? {} : { delayUntilRecursion: e.delayUntilRecursion }),
      ...(e.sticky === undefined ? {} : { sticky: e.sticky }),
      ...(e.cooldown === undefined ? {} : { cooldown: e.cooldown }),
      ...(e.delay === undefined ? {} : { delay: e.delay }),
      ...(e.recursiveScanning === true
        ? { recursiveContent: macro(ctx.worldbook.getContent(e.path) ?? '') }
        : {}),
      ...(e.position === undefined ? {} : { position: e.position }),
      ...(e.role === undefined ? {} : { role: e.role }),
      ...(e.hasDecorators === undefined ? {} : { hasDecorators: e.hasDecorators }),
      order: e.order,
      weight: e.weight,
      owner: classification.owner,
      ...(classification.pluginKinds.length === 0 ? {} : { pluginKinds: classification.pluginKinds }),
    }
    if (classification.owner === 'plugin') pluginCandidates.push(candidate)
    else if (e.constant !== true) candidates.push(candidate)
  }

  const pluginActivation = new Set(
    deterministicWorldbookMatch({
      intent,
      scanDepth,
      recentMessages,
      candidates: pluginCandidates,
      mode: 'strict',
    }, { rollProbability: false }).map(candidate => candidate.path),
  )
  const activatedPluginCandidates = pluginCandidates.map(candidate => ({
    ...candidate,
    active: pluginActivation.has(candidate.path),
  }))
  const mode = resolveWorldbookMatchMode(ctx.worldbookSettings)
  return {
    intent,
    scanDepth,
    recentMessages,
    candidates,
    // The persisted/indexed document includes every green entry, including
    // ST-owned regex entries. The prompt tells the LLM to select only the
    // owner=agent subset; ST-owned paths remain controlled by the local base.
    keyIndexMarkdown: renderWorldbookKeyOnlyMd(candidates),
    ...(activatedPluginCandidates.length === 0 ? {} : { pluginCandidates: activatedPluginCandidates }),
    mode,
    ...(ctx.worldbookTimedEffects === undefined ? {} : { timedEffects: ctx.worldbookTimedEffects }),
    messageCount: history.length,
  }
}

/** 次关键词逻辑的中文语义标注(喂给 LLM 的说明列)。 */
const SELECTIVE_LOGIC_LABELS: Record<WorldbookMatchCandidate['selectiveLogic'], string> = {
  'and-any': 'AND_ANY(任一次关键词命中即激活)',
  'not-all': 'NOT_ALL(任一次关键词未命中即激活)',
  'not-any': 'NOT_ANY(全部次关键词未命中才激活)',
  'and-all': 'AND_ALL(全部次关键词命中才激活)',
}

/** Render candidate green entries as a markdown parameter table for the LLM prompt. */
export function formatCandidates(candidates: readonly WorldbookMatchCandidate[]): string {
  if (candidates.length === 0) return '(无候选条目)'
  const rows = candidates.map(c => {
    const keys = c.keys.length > 0 ? c.keys.join(', ') : '(无)'
    const secondary = c.secondaryKeys.length > 0 ? c.secondaryKeys.join(', ') : '(无)'
    return [
      `| ${c.path} | ${c.comment} | ${keys} | ${secondary} | ${SELECTIVE_LOGIC_LABELS[c.selectiveLogic]} |`,
      `  ${c.caseSensitive ? '是' : '否'} | ${c.matchWholeWords ? '是' : '否'} | ${c.useRegex ? '是' : '否'} | ${c.probability} | ${c.order} | ${c.weight} |`,
    ].join('')
  })
  return [
    '| 路径 | 名称 | 主关键词 | 次关键词 | 次关键词逻辑 | 大小写敏感 | 整词匹配 | 正则 | 概率% | 顺序 | 权重 |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

/** Render the recent scan messages as a numbered list for the LLM prompt. */
export function formatRecentMessages(messages: readonly WorldbookScanMessage[]): string {
  if (messages.length === 0) return '(无最近消息)'
  const roleLabel: Record<WorldbookScanMessage['role'], string> = {
    user: '用户',
    assistant: '角色',
    system: '系统',
  }
  return messages
    .map((m, i) => `[${i + 1}] ${roleLabel[m.role]}: ${m.content}`)
    .join('\n\n')
}

/** ST 激活概率掷骰(world-info.js:4907-4925 同款公式,边界含等号):
 *  `Math.random()*100 <= probability`。probability=100 恒通过;
 *  probability=0 仅当随机数恰好取到 0.0 时通过(概率 2^-53,实测恒不通过)。
 *  rng 参数仅为单测注入用,生产走 Math.random。 */
export function rollProbability(probability: number, rng: () => number = Math.random): boolean {
  return rng() * 100 <= probability
}

/** Case-insensitive exact-keyword match across candidates — the LLM-failure fallback.
 *  (仅当 LLM 输出彻底不可解析时的安全网,不是语义匹配路径,见文件头差异说明 1。) */
export function exactKeywordMatch(
  keywords: readonly string[],
  candidates: readonly WorldbookMatchCandidate[],
): WorldbookMatchCandidate[] {
  // The fallback receives the compact intent keywords rather than the full
  // chat buffer.  Treat them as scan text, but keep ST's two-stage rule:
  // secondary keys can constrain an already-matched primary key; they can
  // never activate an entry on their own.
  const scanText = keywords.join('\n')
  return candidates.filter(candidate => {
    const primary = candidate.keys.some(key => matchesWorldbookKey(scanText, key, candidate))
    if (!primary) return false
    return candidate.selective !== true || selectiveMatch(candidate, scanText)
  })
}

/** Render the local ST result that the semantic matcher is allowed to extend. */
export function formatStBaseline(matches: readonly WorldbookMatch[]): string {
  if (matches.length === 0) return '(ST 本地基线为空)'
  return matches
    .map(match => `- ${match.path} (order=${match.order}, weight=${match.weight})`)
    .join('\n')
}

function compileWorldbookRegex(raw: string, caseSensitive: boolean): RegExp | undefined {
  if (raw.length === 0 || raw.length > 16_384) return undefined
  try {
    const literal = raw.match(/^\/([\s\S]*)\/([a-z]*)$/iu)
    const source = literal?.[1] ?? raw
    let flags = literal?.[2] ?? ''
    if (!caseSensitive && !flags.includes('i')) flags += 'i'
    // World Info keys are predicates, not replacement expressions. Global and
    // sticky state would make repeated checks order-dependent.
    flags = [...new Set(flags.replace(/[gy]/gu, ''))].join('')
    return new RegExp(source, flags)
  } catch {
    return undefined
  }
}

function matchesWorldbookKey(
  text: string,
  key: string,
  candidate: WorldbookMatchCandidate,
): boolean {
  if (key.length === 0) return false
  if (candidate.useRegex) {
    const regex = compileWorldbookRegex(key, candidate.caseSensitive)
    if (regex === undefined) return false
    regex.lastIndex = 0
    return regex.test(text)
  }
  const haystack = candidate.caseSensitive ? text : text.toLocaleLowerCase()
  const needle = candidate.caseSensitive ? key : key.toLocaleLowerCase()
  if (!candidate.matchWholeWords || /\s/u.test(needle)) return haystack.includes(needle)
  let offset = haystack.indexOf(needle)
  while (offset >= 0) {
    const before = offset === 0 ? '' : haystack[offset - 1]!
    const end = offset + needle.length
    const after = end >= haystack.length ? '' : haystack[end]!
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true
    offset = haystack.indexOf(needle, offset + 1)
  }
  return false
}

function selectiveMatch(
  candidate: WorldbookMatchCandidate,
  text: string,
): boolean {
  if (!candidate.selectiveLogic || candidate.secondaryKeys.length === 0) return true
  const matched = candidate.secondaryKeys.map(key => matchesWorldbookKey(text, key, candidate))
  switch (candidate.selectiveLogic) {
    case 'and-all': return matched.every(Boolean)
    case 'not-any': return matched.every(value => !value)
    case 'not-all': return matched.some(value => !value)
    default: return matched.some(Boolean)
  }
}

const MAX_SAFE_RECURSION_LEVEL = 1000
const DEFAULT_RECURSION_BOOK_ID = '__worldbook__'

function recursionDelayLevel(candidate: WorldbookMatchCandidate): number {
  if (candidate.delayUntilRecursion === true) return 1
  if (typeof candidate.delayUntilRecursion !== 'number' || !Number.isFinite(candidate.delayUntilRecursion)) return 0
  return Math.min(MAX_SAFE_RECURSION_LEVEL, Math.max(0, Math.trunc(candidate.delayUntilRecursion)))
}

function recursionBookId(candidate: WorldbookMatchCandidate): string | undefined {
  if (candidate.recursiveScanning !== true) return undefined
  return candidate.recursiveBookId ?? DEFAULT_RECURSION_BOOK_ID
}

function scanTextForCandidate(
  input: WorldbookMatchInput,
  candidate: WorldbookMatchCandidate,
  recursiveText = '',
): string {
  const depth = candidate.scanDepth === undefined
    ? input.scanDepth
    : Math.max(0, Math.trunc(candidate.scanDepth))
  const baseText = depth === 0
    ? ''
    : input.recentMessages.slice(-depth).map(message => message.content).concat(
      input.intent.userNarration,
      ...input.intent.metaCommands,
      ...input.intent.keywords,
    ).join('\n')
  return recursiveText.length === 0 ? baseText : [baseText, recursiveText].filter(Boolean).join('\n')
}

function candidateMatchesText(
  input: WorldbookMatchInput,
  candidate: WorldbookMatchCandidate,
  recursiveText = '',
): boolean {
  if (candidate.constant === true) return true
  const text = scanTextForCandidate(input, candidate, recursiveText)
  const primary = candidate.keys.some(key => matchesWorldbookKey(text, key, candidate))
  return primary && (candidate.selective !== true || selectiveMatch(candidate, text))
}

function appendRecursiveContent(
  textByBook: Map<string, string>,
  candidate: WorldbookMatchCandidate,
): boolean {
  const bookId = recursionBookId(candidate)
  if (bookId === undefined || candidate.preventRecursion === true) return false
  const content = candidate.recursiveContent ?? ''
  if (content.length === 0) return false
  const previous = textByBook.get(bookId) ?? ''
  textByBook.set(bookId, [previous, content].filter(value => value.length > 0).join('\n'))
  return true
}

/**
 * Apply the deterministic ST key semantics and recursively scan activated
 * entry content. `seedCandidates` is used by the one existing semantic call:
 * an LLM-selected ordinary entry can seed the same local recursive pass, but
 * recursion never causes another LLM request.
 */
function collectWorldbookActivations(
  input: WorldbookMatchInput,
  seedCandidates: readonly WorldbookMatchCandidate[] = [],
  includeInitial = true,
): Set<string> {
  const active = new Set<string>()
  const textByBook = new Map<string, string>()
  const byPath = new Map(input.candidates.map(candidate => [candidate.path, candidate]))

  const activate = (candidate: WorldbookMatchCandidate): void => {
    if (active.has(candidate.path)) return
    active.add(candidate.path)
    appendRecursiveContent(textByBook, candidate)
  }

  // Initial ST matching. Delayed entries are intentionally left for a
  // recursive pass, even when their key appears in the current chat turn.
  if (includeInitial) {
    for (const candidate of input.candidates) {
      if (candidate.hasDecorators === true) continue
      const messageCount = input.messageCount ?? input.recentMessages.length
      if (isTimedEffectStickyActive(input.timedEffects ?? {}, candidate.path, messageCount)) {
        activate(candidate)
        continue
      }
      if (!canEvaluateTimedEffect(candidate, input.timedEffects ?? {}, messageCount)
        || recursionDelayLevel(candidate) > 0) continue
      if (candidateMatchesText(input, candidate)) activate(candidate)
    }
  }

  // Semantic selections are normal (non-recursive) activations. They are
  // allowed to seed recursion only after the caller has applied probability.
  for (const seed of seedCandidates) {
    const candidate = byPath.get(seed.path)
    if (candidate === undefined || candidate.hasDecorators === true || recursionDelayLevel(candidate) > 0) continue
    activate(candidate)
  }

  const recursiveBooks = new Map<string, WorldbookMatchCandidate[]>()
  for (const candidate of input.candidates) {
    const bookId = recursionBookId(candidate)
    if (bookId === undefined) continue
    const entries = recursiveBooks.get(bookId) ?? []
    entries.push(candidate)
    recursiveBooks.set(bookId, entries)
  }

  for (const [bookId, entries] of recursiveBooks) {
    const delayedLevels = [...new Set(entries
      .map(recursionDelayLevel)
      .filter(level => level > 0))].sort((left, right) => left - right)
    if ((textByBook.get(bookId) ?? '').length === 0 && delayedLevels.length === 0) continue
    const levels = delayedLevels.length > 0 ? delayedLevels : [0]

    for (const recursionLevel of levels) {
      while (true) {
        const recursiveText = textByBook.get(bookId) ?? ''
        const newlyActivated: WorldbookMatchCandidate[] = []
        for (const candidate of entries) {
          if (active.has(candidate.path)
            || candidate.hasDecorators === true
            || candidate.excludeRecursion === true
            || recursionDelayLevel(candidate) > recursionLevel) continue
          if (!canEvaluateTimedEffect(
            candidate,
            input.timedEffects ?? {},
            input.messageCount ?? input.recentMessages.length,
          )) continue
          if (!candidateMatchesText(input, candidate, recursiveText)) continue
          activate(candidate)
          newlyActivated.push(candidate)
        }
        // ST repeats a recursive pass only when it added new recursive text.
        // An activated `preventRecursion` entry therefore cannot keep the loop
        // alive by itself.
        if (!newlyActivated.some(candidate =>
          candidate.preventRecursion !== true
          && (candidate.recursiveContent ?? '').length > 0)) break
      }
    }
  }

  return active
}

/** Apply SillyTavern's deterministic key/secondary-key semantics. */
export function deterministicWorldbookMatch(
  input: WorldbookMatchInput,
  options: {
    readonly rollProbability?: boolean
    /** Additional already-selected entries that may seed recursive scanning. */
    readonly seedCandidates?: readonly WorldbookMatchCandidate[]
  } = {},
): WorldbookMatchCandidate[] {
  const active = collectWorldbookActivations(input, options.seedCandidates)
  return input.candidates.filter(candidate => {
    if (!active.has(candidate.path)) return false
    return !candidate.useProbability
      || candidate.probability >= 100
      || options.rollProbability !== false && rollProbability(candidate.probability)
  })
}

/** Return only entries newly activated by an already-selected semantic seed. */
export function recursiveWorldbookMatch(
  input: WorldbookMatchInput,
  seedCandidates: readonly WorldbookMatchCandidate[],
): WorldbookMatchCandidate[] {
  const seedPaths = new Set(seedCandidates.map(candidate => candidate.path))
  const active = collectWorldbookActivations(input, seedCandidates, false)
  return input.candidates.filter(candidate => active.has(candidate.path) && !seedPaths.has(candidate.path))
}

/** Convert raw candidates to {@link WorldbookMatch} shells (content left blank
 *  for the caller to fill in from the worldbook store). */
function candidatesToMatchShells(entries: readonly WorldbookMatchCandidate[]): WorldbookMatch[] {
  return entries.map(c => ({
    path: c.path,
    order: c.order,
    weight: c.weight,
    content: '',
    ...(c.position === undefined ? {} : { position: c.position }),
    ...(c.depth === undefined ? {} : { depth: c.depth }),
    ...(c.role === undefined ? {} : { role: c.role }),
  }))
}

/** Parse the model's JSON response into a {@link WorldbookMatchOutput}. Never throws.
 *
 *  Fallback ladder (each step is independent — a failure moves on):
 *  1. `JSON.parse` the whole string and run it through the schema.
 *  2. Extract the body of the first ```` ```json ... ``` ```` code block.
 *  3. Return the precomputed `fallback` (exact-keyword matches).
 */
export function parseWorldbookMatchResponse(
  raw: string,
  fallback: readonly WorldbookMatch[],
): WorldbookMatchOutput {
  // Strategy 1: direct parse.
  try {
    return WorldbookMatchOutputSchema(JSON.parse(raw))
  } catch {
    // fall through to the next strategy
  }

  // Strategy 2: extract a markdown code block.
  const fenced = /```(?:json)?\s*([\s\S]+?)\s*```/.exec(raw)
  if (fenced && fenced[1] !== undefined) {
    try {
      return WorldbookMatchOutputSchema(JSON.parse(fenced[1]))
    } catch {
      // fall through
    }
  }

  // Last resort: the caller already computed exact-keyword matches.
  return { matches: [...fallback] }
}

/** 扫描文本是否完全没有内容(无消息 + 意图关键词/叙述为空)→ 不值得调 LLM。 */
function scanTextIsEmpty(input: WorldbookMatchInput): boolean {
  const hasMessage = input.recentMessages.some(m => m.content.trim().length > 0)
  return !hasMessage
    && input.intent.keywords.length === 0
    && input.intent.userNarration.trim().length === 0
}

export const worldbookMatchAgent: Agent<WorldbookMatchInput, WorldbookMatchOutput> = {
  name: 'worldbook-match',

  async run(input: WorldbookMatchInput, ctx: AgentContext): Promise<WorldbookMatchOutput> {
    const mode = input.mode ?? resolveWorldbookMatchMode(ctx.worldbookSettings)
    const plugin = input.pluginCandidates === undefined || input.pluginCandidates.length === 0
      ? undefined
      : buildWorldbookPluginOutput(input.pluginCandidates, ctx)
    const withPlugin = (output: WorldbookMatchOutput): WorldbookMatchOutput => plugin === undefined
      ? output
      : { ...output, plugin }
    // ST-owned entries (including native ST regex keys) are always resolved
    // locally. Enhanced mode uses this as its baseline; strict mode stops here.
    // First determine ST key activation without rolling.  Probability is a
    // per-entry, per-turn final gate; keeping it separate lets us remember the
    // result when enhanced mode asks the agent about the same entry.
    const deterministicActivation = deterministicWorldbookMatch(input, { rollProbability: false })
    const probabilityByPath = new Map<string, boolean>()
    const passesProbability = (candidate: WorldbookMatchCandidate): boolean => {
      const cached = probabilityByPath.get(candidate.path)
      if (cached !== undefined) return cached
      const sticky = isTimedEffectStickyActive(
        input.timedEffects ?? {},
        candidate.path,
        input.messageCount ?? input.recentMessages.length,
      )
      const passed = sticky
        || candidate.useProbability === false
        || candidate.probability >= 100
        || rollProbability(candidate.probability)
      probabilityByPath.set(candidate.path, passed)
      return passed
    }
    const deterministic = deterministicActivation.filter(passesProbability)
    const stBaseline = resolveMatches(deterministic, ctx, 'st')
    const stSelected = deterministic.filter(candidate => candidate.owner !== 'agent'
      || isTimedEffectStickyActive(
        input.timedEffects ?? {},
        candidate.path,
        input.messageCount ?? input.recentMessages.length,
      ))
    const stOwnedOutput = resolveMatches(stSelected, ctx, 'st')
    const agentCandidates = input.candidates.filter(candidate => candidate.owner === 'agent' || candidate.owner === undefined)

    // No semantic candidates / empty scan text → no extra LLM call.
    if (mode === 'strict') return withPlugin(stBaseline)
    if (agentCandidates.length === 0 || scanTextIsEmpty(input)) {
      return withPlugin(mode === 'enhanced' ? stBaseline : stOwnedOutput)
    }

    // The semantic matcher sees only ordinary entries. Plugin directives and
    // native ST regex entries are never reinterpreted by the model.
    const agentInput: WorldbookMatchInput = {
      ...input,
      candidates: agentCandidates,
      ...(input.pluginCandidates === undefined ? {} : { pluginCandidates: [] }),
    }

    // 1. Load + render the prompt template (ST 参数语义说明见 worldbook-match.md)。
    const template = await ctx.prompts.load('worldbook-match')
    const systemPrompt = template
      .replace('{{keywords}}', JSON.stringify(agentInput.intent.keywords))
      .replace('{{scan_depth}}', String(agentInput.scanDepth))
      .replace('{{recent_messages}}', formatRecentMessages(agentInput.recentMessages))
      // New prompts use {{key_index}}. Keep {{candidates}} as a compatibility
      // alias for custom/older prompt templates.
      .replace('{{key_index}}', agentInput.keyIndexMarkdown ?? formatCandidates(agentInput.candidates))
      .replace('{{candidates}}', agentInput.keyIndexMarkdown ?? formatCandidates(agentInput.candidates))
      .replace('{{st_baseline}}', formatStBaseline(stBaseline.matches))
      + (template.includes('{{st_baseline}}') ? '' : `\n\n## ST 本地关键词基线(不可删除,只允许追加语义候选)\n${formatStBaseline(stBaseline.matches)}`)

    // 2. Ask the LLM which paths activate (绿灯语义判断)。
    const result = await ctx.provider.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `用户意图:\n${JSON.stringify(input.intent, null, 2)}` },
      ],
      {
        model: ctx.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      },
    )

    // 3. Parse; if the LLM output is unusable, fall back to exact match (安全网).
    const fallback = candidatesToMatchShells(exactKeywordMatch(agentInput.intent.keywords, agentInput.candidates))
    const rawList = parseWorldbookMatchResponse(result.content, fallback)

    // 4. Resolve each returned path against the worldbook store and read the
    //    authoritative content. The LLM is the source of truth for "which
    //    paths" but the worldbook store is the source of truth for "what
    //    content" — never trust the LLM's content field. Content 再过一遍
    //    {{user}}/{{char}} 宏替换(ST 语义:content 注入前替换)。
    const candidateByPath = new Map(agentInput.candidates.map(c => [c.path, c]))
    const macro = (text: string): string =>
      substituteUserCharMacros(text, ctx.macros?.user ?? null, ctx.macros?.char ?? null)
    const semanticSeeds: WorldbookMatchCandidate[] = []
    const acceptedModelMatches: Array<{ readonly match: WorldbookMatch; readonly candidate: WorldbookMatchCandidate }> = []
    const modelSeen = new Set<string>()
    for (const m of rawList.matches) {
      if (modelSeen.has(m.path)) continue
      const candidate = candidateByPath.get(m.path)
      if (candidate === undefined) continue  // LLM invented a path that's not a candidate
      // delay_until_recursion entries cannot be activated by the ordinary
      // semantic pass. They can still be reached from a non-delayed seed.
      if (recursionDelayLevel(candidate) > 0
        || !canEvaluateTimedEffect(
          candidate,
          input.timedEffects ?? {},
          input.messageCount ?? input.recentMessages.length,
        )) continue
      if (!passesProbability(candidate)) continue
      modelSeen.add(m.path)
      semanticSeeds.push(candidate)
      acceptedModelMatches.push({ match: m, candidate })
    }
    const recursivelyActivated = recursiveWorldbookMatch(agentInput, semanticSeeds)
    const recursivelyActivatedByPath = new Map(recursivelyActivated.map(candidate => [candidate.path, candidate]))
    const matches: WorldbookMatch[] = []
    const seen = new Set<string>()
    const addMatch = (candidate: WorldbookMatchCandidate): void => {
      if (seen.has(candidate.path)) return
      seen.add(candidate.path)
      if (!passesProbability(candidate)) return
      matches.push({
        path: candidate.path,
        order: candidate.order,
        weight: candidate.weight,
        content: macro(ctx.worldbook.getContent(candidate.path) ?? ''),
        source: 'agent',
        ...(candidate.position === undefined ? {} : { position: candidate.position }),
        ...(candidate.depth === undefined ? {} : { depth: candidate.depth }),
        ...(candidate.role === undefined ? {} : { role: candidate.role }),
      })
    }
    // 5. Probability is cached from the deterministic pass when this path
    // already matched ST keys.  A semantic-only path is rolled here once;
    // neither route can roll the same entry twice in one run.
    for (const { candidate } of acceptedModelMatches) addMatch(candidate)
    // Recursive hits are deterministic additions from authoritative content;
    // they do not require a second semantic matcher call.
    for (const candidate of recursivelyActivatedByPath.values()) {
      addMatch(candidate)
    }

    // 6. Sort: order asc (low = injected earlier), weight desc (stronger first).
    //    (与 ST 的差异:ST 同一注入点内 order 降序;本项目沿用 response 注入管道
    //    既有排序约定,蓝灯常驻块才按 ST order 降序拼接。)
    matches.sort((a, b) => a.order - b.order || b.weight - a.weight)
    const agentOutput: WorldbookMatchOutput = { matches }
    return withPlugin(mode === 'enhanced'
      ? resolveWorldbookMatches({ st: stBaseline, agent: agentOutput })
      : resolveWorldbookMatches({
          ...(stOwnedOutput.matches.length > 0 ? { st: stOwnedOutput } : {}),
          agent: agentOutput,
        }))
  },
}

function resolveMatches(
  selected: readonly WorldbookMatchCandidate[],
  ctx: AgentContext,
  source: 'st' | 'agent' = 'agent',
): WorldbookMatchOutput {
  const macro = (text: string): string =>
    substituteUserCharMacros(text, ctx.macros?.user ?? null, ctx.macros?.char ?? null)
  const matches = selected.map(candidate => ({
    path: candidate.path,
    order: candidate.order,
    weight: candidate.weight,
    content: macro(ctx.worldbook.getContent(candidate.path) ?? ''),
    source,
    ...(candidate.position === undefined ? {} : { position: candidate.position }),
    ...(candidate.depth === undefined ? {} : { depth: candidate.depth }),
    ...(candidate.role === undefined ? {} : { role: candidate.role }),
  }))
  matches.sort((a, b) => a.order - b.order || b.weight - a.weight)
  return { matches }
}
