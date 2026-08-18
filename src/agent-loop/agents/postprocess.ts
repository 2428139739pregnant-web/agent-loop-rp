/** Agent ⑤ — Reply post-processing.
 *
 * Pipeline: gate → (hard checks in code) → pass A (enhance) → pass B (senses & dedup)
 * → pass C (dedup & ending). Up to N rounds.
 * version. Every pass returns span edits applied by code — text not mentioned
 * by an edit survives byte-for-byte, which is what keeps dialogue and plot
 * beats intact across revisions.
 *
 * ## 独立追踪设计
 * 原设计把整个 postprocess 包装成一个 outer stage,内部用 ctx.onProgress
 * 发 sub-step events,前端需要等所有子步骤跑完才能看到 outer done。
 *
 * 新设计把每个子环节(pass-a/b/c/extract)暴露为顶层 async 函数,
 * 每个都是 `async (ctx, ...) => Promise<...>`,**自己不发任何事件**。
 * 公共编排由本文件的 `runPostprocessPipeline` 负责；SSE 服务器只注入
 * `runStageWithTrace('<step-name>', ...)` 作为 stage runner,这样:
 *   1. 每个子环节是独立 stage,各自 start/done,各自 durationMs
 *   2. 失败/超时只影响单个子 stage,不会带跑 best
 *   3. `postprocessAgent.run` 保留作为 Agent 接口实现(向后兼容 demo/tests),
 *      内部直接调这些原子函数 + 自己编排(不依赖 ui-server 的 runStageWithTrace)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { SpanEditOutputSchema, type SpanEdit, type SpanEditOutput } from '../schema.ts'
import type { Agent, AgentContext, PostprocessRuntimeSettings } from './types.ts'

const ANCHOR_MIN = 12
const IMAGERY_KEEP = 40

/** Shared defaults used by both the JSON and SSE run paths. */
export const POSTPROCESS_MAX_ROUNDS = 2
export const POSTPROCESS_DENSITY_MAX = 0.6

// ---------- JSON 兜底梯子（泛化自 intent.ts 的 parseIntentResponse） ----------

const FENCED_JSON_RE = /```(?:json)?\s*([\s\S]+?)\s*```/
const FIRST_OBJECT_RE = /\{[\s\S]*\}/

export function parseJsonLoose<T>(schema: (data: unknown) => T, raw: string, fallback: T): T {
  const candidates: string[] = [raw]
  const fenced = FENCED_JSON_RE.exec(raw)
  if (fenced?.[1] !== undefined) candidates.push(fenced[1])
  const first = FIRST_OBJECT_RE.exec(raw)
  if (first?.[0] !== undefined) candidates.push(first[0])
  for (const candidate of candidates) {
    try {
      return schema(JSON.parse(candidate))
    } catch {
      // Try the next candidate.
    }
  }
  return fallback
}

// ---------- 编辑应用：anchor 必须逐字命中且全文唯一 ----------

export interface EditStats { [key: string]: number }

export function applyEdits(text: string, edits: readonly SpanEdit[], stats: EditStats): string {
  let out = text
  for (const edit of edits) {
    const anchor = edit.anchor
    if (anchor.length < ANCHOR_MIN) { stats.anchor_too_short = (stats.anchor_too_short ?? 0) + 1; continue }
    const at = out.indexOf(anchor)
    if (at < 0) { stats.anchor_miss = (stats.anchor_miss ?? 0) + 1; continue }
    if (out.indexOf(anchor, at + 1) !== -1) { stats.anchor_ambiguous = (stats.anchor_ambiguous ?? 0) + 1; continue }
    out = out.slice(0, at) + edit.replacement + out.slice(at + anchor.length)
    stats[edit.op] = (stats[edit.op] ?? 0) + 1
  }
  return out
}

// ---------- 门槛与密度 ----------

const PREG_KEY_RE = /孕|胎|肚子|腹部|宫缩|妊娠|产/

export function gate(text: string): boolean {
  return PREG_KEY_RE.test(text)
}

function bodyOnly(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<details[\s\S]*?<\/details>/g, '')
}

export function density(text: string): number {
  const sents = bodyOnly(text).split(/[。！？\n]+/).filter(s => s.trim().length > 4)
  if (sents.length === 0) return 0
  const hit = sents.filter(s => PREG_KEY_RE.test(s)).length
  return hit / sents.length
}

// ---------- 程序化硬校验（零 token） ----------

export interface HardFix { where: string; fix: string }

export function programmaticChecks(text: string): HardFix[] {
  const issues: HardFix[] = []
  const sizes = /三围[:：]?\s*「?\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*\/\s*(\d{2,3})/.exec(text)
  const preg = /妊娠状态[:：]?\s*「?\s*(\d{1,2})\s*周/.exec(text)
  if (sizes && preg) {
    const bust = Number(sizes[1]); const waist = Number(sizes[2]); const hips = Number(sizes[3])
    const week = Number(preg[1])
    if (week >= 13 && !(waist > bust && waist > hips)) {
      issues.push({ where: '三围', fix: `孕${week}周(已过孕中期)腰围必须大于胸围与臀围，当前${bust}/${waist}/${hips}，请修正三围数值并同步受影响的正文表述` })
    }
  }
  if (preg && Number(preg[1]) < 36 && /羊水破|宫口开|见红|产程|要生了/.test(text)) {
    issues.push({ where: '产程', fix: '未到临产周数，不得出现破水/宫口/产程推进，请回退相关表述' })
  }
  for (const label of ['妊娠状态', '胎儿状态', '子宫状态', '肚子状态']) {
    const m = new RegExp(label + '[:：]?\\s*「?([^\\n」]{0,400})').exec(text)
    const desc = m?.[1]?.trim() ?? ''
    if (desc.length > 0 && desc.length < 50) {
      issues.push({ where: label, fix: `${label}描述不足50字，请扩写` })
    }
  }
  return issues
}

// ---------- 意象记忆：按会话存盘，镜像 summaryPath 的惯例 ----------

export class ImageryStore {
  private readonly appendTails = new Map<string, Promise<void>>()

  constructor(private readonly dir = 'imagery') {}

  private path(sessionId: string): string {
    return `${this.dir}/${sessionId}.json`
  }

  async list(sessionId: string): Promise<string[]> {
    try {
      const raw = JSON.parse(await readFile(this.path(sessionId), 'utf8')) as string[]
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  async append(sessionId: string, lines: readonly string[]): Promise<void> {
    // Deferred extraction can finish concurrently for two turns. Serialize
    // read-modify-write per session so a later append cannot overwrite an
    // earlier one that has not reached disk yet.
    const previous = this.appendTails.get(sessionId) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      const path = this.path(sessionId)
      const merged = [...await this.list(sessionId), ...lines].slice(-IMAGERY_KEEP)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(merged, null, 1), 'utf8')
    })
    this.appendTails.set(sessionId, task)
    try {
      await task
    } finally {
      if (this.appendTails.get(sessionId) === task) this.appendTails.delete(sessionId)
    }
  }
}

export interface PostprocessImageryStore {
  list(sessionId: string): Promise<string[]>
  append(sessionId: string, lines: readonly string[]): Promise<void>
}

const defaultImagery = new ImageryStore()

// ---------- 原子 LLM 调用(无事件) ----------

/** 调用一次 LLM,返回原始字符串 + usage(供上层 stage 追踪)。 */
async function callLlm(
  ctx: AgentContext,
  systemContent: string,
  userContent: string,
  temperature: number,
  model?: string,
): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
  const r = await ctx.provider.chat(
    [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ],
    { model: model ?? ctx.model, temperature, response_format: { type: 'json_object' } },
  )
  return {
    content: r.content,
    usage: r.usage ?? { prompt_tokens: 0, completion_tokens: 0 },
  }
}

/** 解析 LLM 返回的 edits(JSON 兜底梯子)。 */
function parseEdits(raw: string): SpanEdit[] {
  const empty: SpanEditOutput = { edits: [] }
  return parseJsonLoose<SpanEditOutput>(SpanEditOutputSchema as never, raw, empty).edits
}

// ---------- 暴露给 ui-server 编排的原子步骤 ----------

/** A pass:扩写与张力增强。`hard` 是程序化硬校验(可空)。 */
export async function runPostprocessPassA(
  ctx: AgentContext,
  text: string,
  hard: readonly HardFix[],
  model?: string,
): Promise<SpanEdit[]> {
  const template = await ctx.prompts.load('postprocess-a')
  const { content } = await callLlm(
    ctx,
    renderPassTemplate(template),
    JSON.stringify({ text, hard_fixes: hard }),
    0.8,
    model,
  )
  return parseEdits(content)
}

/** B pass:感官细节 + 重复去除。`imagery` 是意象记忆(可空)。 */
export async function runPostprocessPassB(
  ctx: AgentContext,
  text: string,
  imagery: readonly string[],
  model?: string,
): Promise<SpanEdit[]> {
  const template = await ctx.prompts.load('postprocess-b')
  const { content } = await callLlm(
    ctx,
    renderPassTemplate(template),
    JSON.stringify({ text, imagery }),
    0.5,
    model,
  )
  return parseEdits(content)
}

/** C pass:重复去除 + 留白收尾；densityMax 作为提示词中的密度参考。 */
export async function runPostprocessPassC(
  ctx: AgentContext,
  text: string,
  densityMax: number = POSTPROCESS_DENSITY_MAX,
  model?: string,
): Promise<SpanEdit[]> {
  const template = await ctx.prompts.load('postprocess-c')
  const { content } = await callLlm(
    ctx,
    renderPassTemplate(template, { density_max: String(densityMax) }),
    JSON.stringify({ text, density_max: densityMax }),
    0.5,
    model,
  )
  return parseEdits(content)
}

/** extract:从当前文本抽意象,返回 string[](每条带 [源域:...] 后缀)。 */
export async function runPostprocessExtract(
  ctx: AgentContext,
  text: string,
  model?: string,
): Promise<string[]> {
  const template = await ctx.prompts.load('postprocess-extract')
  const { content } = await callLlm(ctx, template, JSON.stringify({ text }), 0.1, model)
  let extracted: string[] = []
  try {
    const parsed = JSON.parse(FENCED_JSON_RE.exec(content)?.[1] ?? content) as { sentences?: { text?: string; domain?: string }[] }
    extracted = (parsed.sentences ?? [])
      .filter(s => typeof s.text === 'string' && s.text.length > 0)
      .map(s => `${s.text} [源域:${s.domain ?? '无'}]`)
  } catch {
    extracted = []
  }
  return extracted
}

// ---------- ⑤ pipeline orchestration (shared by JSON and SSE paths) ----------

export type PostprocessStageName =
  | 'postprocess-gate'
  | 'postprocess-pass-a'
  | 'postprocess-pass-b'
  | 'postprocess-pass-c'
  | 'postprocess-extract'

/**
 * A stage runner supplied by the SSE server. Returning null means that one
 * stage failed; the pipeline keeps the text accumulated by earlier stages.
 * The default runner has the same non-fatal behaviour without tracing.
 */
export type PostprocessStageRunner = <T>(
  name: PostprocessStageName,
  input: unknown,
  fn: () => Promise<T>,
) => Promise<T | null>

export interface PostprocessRoundResult {
  round: number
  text: string
  stats: Readonly<EditStats>
}

export interface PostprocessPipelineOptions {
  maxRounds?: number
  densityMax?: number
  modelOverrides?: PostprocessRuntimeSettings['modelOverrides']
  imageryStore?: PostprocessImageryStore
  /** Do not make the user wait for the cross-turn imagery memory update. */
  deferExtract?: boolean
  runStage?: PostprocessStageRunner
  /** Runner for deferred extraction. It is started without delaying `best`,
   *  but can still publish a trace/usage record when the caller supplies one. */
  runAsyncStage?: PostprocessStageRunner
  onRound?: (result: PostprocessRoundResult) => void
}

async function runDirectPostprocessStage<T>(
  _name: PostprocessStageName,
  _input: unknown,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    console.error('[postprocess] stage failed, keeping accumulated text:', err)
    return null
  }
}

async function extractAndStoreImagery(
  ctx: AgentContext,
  text: string,
  imageryStore: PostprocessImageryStore,
  model?: string,
): Promise<{ count: number; lines: string[] }> {
  const lines = await runPostprocessExtract(ctx, text, model)
  await imageryStore.append(ctx.sessionId, lines)
  return { count: lines.length, lines }
}

/**
 * Run the postprocess chain in one place. Every pass consumes the text
 * produced by the previous pass and its span edits are applied immediately:
 *
 *   raw → A edits → B edits → C edits → best
 *
 * Keeping this orchestration shared is important: the normal JSON endpoint
 * and the SSE endpoint must not be able to silently diverge in ordering,
 * density defaults, or best-version handling.
 */
export async function runPostprocessPipeline(
  rawReply: string,
  ctx: AgentContext,
  options: PostprocessPipelineOptions = {},
): Promise<string> {
  const runStage = options.runStage ?? runDirectPostprocessStage
  const densityMax = options.densityMax ?? ctx.postprocessSettings?.densityMax ?? POSTPROCESS_DENSITY_MAX
  const imageryStore = options.imageryStore ?? defaultImagery
  const requestedRounds = options.maxRounds ?? ctx.postprocessSettings?.maxRounds ?? POSTPROCESS_MAX_ROUNDS
  const modelOverrides = options.modelOverrides ?? ctx.postprocessSettings?.modelOverrides
  const maxRounds = Number.isFinite(requestedRounds)
    ? Math.max(1, Math.floor(requestedRounds))
    : POSTPROCESS_MAX_ROUNDS

  if (!gate(rawReply)) {
    await runStage(
      'postprocess-gate',
      { reply_len: rawReply.length },
      async () => ({ passed: false, reason: 'no pregnancy keywords' }),
    )
    return rawReply
  }

  const stats: EditStats = {}
  const imageryLines = await imageryStore.list(ctx.sessionId)
  let text = rawReply
  let best = rawReply
  let hard = programmaticChecks(rawReply)
  const appliedEditKeys = new Set<string>()
  const applyPipelineEdits = (current: string, edits: readonly SpanEdit[]): string => {
    const fresh = edits.filter(edit => {
      const key = `${edit.op}\u0000${edit.anchor}\u0000${edit.replacement}`
      if (appliedEditKeys.has(key)) return false
      const at = current.indexOf(edit.anchor)
      if (at < 0 || current.indexOf(edit.anchor, at + 1) !== -1) return true
      appliedEditKeys.add(key)
      return true
    })
    return applyEdits(current, fresh, stats)
  }

  await runStage(
    'postprocess-gate',
    { reply_len: rawReply.length },
    async () => ({ passed: true, reply_len: rawReply.length }),
  )

  for (let round = 1; round <= maxRounds; round++) {
    const editsA = await runStage(
      'postprocess-pass-a',
      { text, hard_fixes: hard, round },
      () => runPostprocessPassA(ctx, text, hard, modelOverrides?.a),
    )
    if (editsA !== null) text = applyPipelineEdits(text, editsA)

    const editsB = await runStage(
      'postprocess-pass-b',
      { text, imagery: imageryLines, round },
      () => runPostprocessPassB(ctx, text, imageryLines, modelOverrides?.b),
    )
    if (editsB !== null) text = applyPipelineEdits(text, editsB)

    const editsC = await runStage(
      'postprocess-pass-c',
      { text, density_max: densityMax, round },
      () => runPostprocessPassC(ctx, text, densityMax, modelOverrides?.c),
    )
    if (editsC !== null) text = applyPipelineEdits(text, editsC)
    best = text
    options.onRound?.({ round, text, stats: { ...stats } })
  }

  const extractText = best
  if (options.deferExtract === true) {
    // Extraction is only cross-turn memory maintenance. Do not keep the
    // response request or SSE stream waiting for this extra LLM call.
    const runAsyncStage = options.runAsyncStage ?? runDirectPostprocessStage
    void runAsyncStage(
      'postprocess-extract',
      { text_len: extractText.length },
      () => extractAndStoreImagery(ctx, extractText, imageryStore, modelOverrides?.extract),
    )
      .then(result => {
        if (result !== null) console.info(`[postprocess] async imagery extract done session=${ctx.sessionId} count=${result.count}`)
      })
      .catch(err => console.error('[postprocess] async imagery extract failed:', err))
  } else {
    await runStage(
      'postprocess-extract',
      { text_len: extractText.length },
      () => extractAndStoreImagery(ctx, extractText, imageryStore, modelOverrides?.extract),
    )
  }

  return best
}

// 模板渲染(从 response.ts 借来 renderTemplate,但这里我们手写一个轻量版避免循环依赖)
function renderPassTemplate(template: string, vars: Record<string, string> = {}): string {
  let out = template
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v)
  }
  return out
}

// ---------- ⑤ agent 本体(向后兼容,demo / test 走这里) ----------

export const postprocessAgent: Agent<string, string> = {
  name: 'postprocess',

  async run(reply: string, ctx: AgentContext): Promise<string> {
    return runPostprocessPipeline(reply, ctx, {
      deferExtract: ctx.postprocessSettings?.deferExtract ?? true,
      onRound: ({ round, text, stats }) => {
        console.info(
          `[postprocess] round=${round} bestLen=${text.length} origLen=${reply.length}`
          + ` stats=${JSON.stringify(stats)}`,
        )
      },
    })
  },
}
