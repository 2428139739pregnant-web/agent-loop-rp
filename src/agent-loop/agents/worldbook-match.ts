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
  /** Explicit worldbook mode; omitted callers use the context setting. */
  mode?: WorldbookMatchMode
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
    ...(activatedPluginCandidates.length === 0 ? {} : { pluginCandidates: activatedPluginCandidates }),
    mode,
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
  const needles = new Set(keywords.map(k => k.toLowerCase()))
  return candidates.filter(c =>
    c.keys.some(k => needles.has(k.toLowerCase()))
    || c.secondaryKeys.some(k => needles.has(k.toLowerCase()))
  )
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

/** Apply SillyTavern's deterministic key/secondary-key semantics. */
export function deterministicWorldbookMatch(
  input: WorldbookMatchInput,
  options: { readonly rollProbability?: boolean } = {},
): WorldbookMatchCandidate[] {
  const text = [
    ...input.recentMessages.map(message => message.content),
    input.intent.userNarration,
    ...input.intent.metaCommands,
    ...input.intent.keywords,
  ].join('\n')
  // A depth of zero excludes prior chat messages but still scans the current
  // intent/user turn, which is the message ST is evaluating right now.
  if (text.trim() === '') return []
  return input.candidates.filter(candidate => {
    if (candidate.hasDecorators === true) return false
    const depth = candidate.scanDepth === undefined ? input.scanDepth : Math.max(0, Math.trunc(candidate.scanDepth))
    const scanText = depth === 0
      ? ''
      : input.recentMessages.slice(-depth).map(message => message.content).concat(
        input.intent.userNarration,
        ...input.intent.metaCommands,
        ...input.intent.keywords,
      ).join('\n')
    const primary = candidate.keys.some(key => matchesWorldbookKey(scanText, key, candidate))
    if (!primary) return false
    if (candidate.selective === true && !selectiveMatch(candidate, scanText)) return false
    return !candidate.useProbability
      || candidate.probability >= 100
      || options.rollProbability !== false && rollProbability(candidate.probability)
  })
}

/** Convert raw candidates to {@link WorldbookMatch} shells (content left blank
 *  for the caller to fill in from the worldbook store). */
function candidatesToMatchShells(entries: readonly WorldbookMatchCandidate[]): WorldbookMatch[] {
  return entries.map(c => ({
    path: c.path,
    order: c.order,
    weight: c.weight,
    content: '',
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
    const deterministic = deterministicWorldbookMatch(input)
    const stBaseline = resolveMatches(deterministic, ctx, 'st')
    const stSelected = deterministic.filter(candidate => candidate.owner !== 'agent')
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
      .replace('{{candidates}}', formatCandidates(agentInput.candidates))
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
    const matches: WorldbookMatch[] = []
    const seen = new Set<string>()
    for (const m of rawList.matches) {
      if (seen.has(m.path)) continue
      const candidate = candidateByPath.get(m.path)
      if (candidate === undefined) continue  // LLM invented a path that's not a candidate
      seen.add(m.path)
      // 5. probability 掷骰收尾(代码层,ST 公式)。useProbability=false 跳过掷骰;
      //    probability=100 时公式恒真,直接短路省一次随机数。
      if (candidate.useProbability
        && candidate.probability < 100
        && rollProbability(candidate.probability) === false) {
        continue
      }
      matches.push({
        path: m.path,
        order: candidate.order,
        weight: candidate.weight,
        content: macro(ctx.worldbook.getContent(m.path) ?? ''),
        source: 'agent',
      })
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
  }))
  matches.sort((a, b) => a.order - b.order || b.weight - a.weight)
  return { matches }
}
