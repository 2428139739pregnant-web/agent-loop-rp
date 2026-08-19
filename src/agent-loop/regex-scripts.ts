/** 正则脚本模块 —— SillyTavern Regex 扩展的对应物。
 *
 *  字段命名对齐 ST(`scriptName/findRegex/replaceString/trimStrings/placement/disabled`),
 *  便于以后与酒馆的正则脚本 JSON 互导。
 *
 *  应用语义逐条对齐 ST `public/scripts/extensions/regex/engine.js`:
 *   - `findRegex` 支持 `/pattern/flags` 字面量或裸 pattern(默认 g,ST regexFromString 同款)
 *   - `replaceString` 里 `{{match}}` → 整个匹配;`$1`/`$<name>` → 捕获组;
 *     trimStrings 从**捕获组内容**里剥掉(ST filterString 语义,不是整串 trim)
 *   - 宏替换({{user}}/{{char}})在最后一步作用到替换结果(ST substituteParams 时机)
 *   - 多脚本按数组顺序依次应用,disabled 跳过
 *
 *  与 ST 的边界:
 *   - placement 用字符串枚举;当前产品面只暴露 user_input/ai_output/display/world_info
 *   - scoped/preset 脚本仍由角色卡 import 层单独保留,不混入全局脚本库
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 应用点位。ST 对应:USER_INPUT=1 / AI_OUTPUT=2 / MD_DISPLAY=0 / WORLD_INFO=5。 */
export type RegexPlacement = 'user_input' | 'ai_output' | 'display' | 'world_info'

export const REGEX_PLACEMENTS: readonly RegexPlacement[] = ['user_input', 'ai_output', 'display', 'world_info']

/** 一条正则脚本(全局级;ST 的 scoped/preset 类型暂不支持)。 */
export interface RegexScript {
  readonly id: string
  scriptName: string
  findRegex: string
  replaceString: string
  trimStrings: string[]
  placement: RegexPlacement[]
  disabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  runOnEdit: boolean
  substituteRegex: number
  minDepth: number | null
  maxDepth: number | null
  createdAt: string
}

/** 宏上下文:{{user}}/{{char}} 的替换源(未知传 null,宏原样保留)。 */
export interface RegexMacros {
  user: string | null
  char: string | null
}

/** ST `utils.js regexFromString` 同款:`/pattern/flags` 字面量或裸 pattern。无效返回 null。 */
export function regexFromString(input: string): RegExp | null {
  try {
    const literal = input.match(/^\/([\s\S]*)\/([a-z]*)$/iu)
    if (literal === null) return new RegExp(input)
    const flags = literal[2] ?? ''
    // Keep the same accepted modern JavaScript flag set as the card-owned
    // regex path (including `d`/`v`), while letting native RegExp reject
    // duplicate or runtime-unsupported combinations.
    if (flags !== '' && !/^(?!.*?(.).*?\1)[dgimsuvy]+$/u.test(flags)) return new RegExp(input)
    return new RegExp(literal[1] ?? '', flags)
  } catch {
    return null
  }
}

/** {{user}}/{{char}} 宏(与 persona-store.substituteUserCharMacros 同规则)。 */
function substituteMacros(text: string, macros: RegexMacros): string {
  let out = text
  if (macros.user !== null) out = out.replaceAll('{{user}}', macros.user)
  if (macros.char !== null) out = out.replaceAll('{{char}}', macros.char)
  return out
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()\[\]{}|/\-]/gu, '\\$&')
}

function substituteFindMacros(text: string, macros: RegexMacros, mode: number): string {
  if (mode === 0) return text
  const substituted = substituteMacros(text, macros)
  return mode === 2
    ? escapeRegex(substituted)
    : substituted
}

/** ST `filterString`:从串里剥掉所有 trimStrings(先过宏)。 */
function filterString(raw: string, trimStrings: readonly string[], macros: RegexMacros): string {
  let out = raw
  for (const t of trimStrings) {
    if (t.length === 0) continue
    out = out.replaceAll(substituteMacros(t, macros), '')
  }
  return out
}

/** 应用单条脚本。任何解析/执行异常都返回原文(正则是增益,不是链路依赖)。 */
export interface RegexExecutionOptions {
  readonly depth?: number
  readonly isEdit?: boolean
  readonly surface?: 'prompt' | 'display'
}

function appliesAtDepth(script: RegexScript, depth: number | undefined): boolean {
  if (depth === undefined) return true
  if (script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) return false
  if (script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) return false
  return true
}

function appliesToSurface(script: RegexScript, surface: RegexExecutionOptions['surface']): boolean {
  if (surface === 'display') return script.markdownOnly || (!script.markdownOnly && !script.promptOnly)
  return script.promptOnly || (!script.markdownOnly && !script.promptOnly)
}

function expandReplacement(
  template: string,
  match: string,
  captures: readonly unknown[],
  groups: Record<string, string | undefined> | undefined,
  offset: number,
  input: string,
  trimStrings: readonly string[],
  macros: RegexMacros,
): string {
  const prefix = input.slice(0, offset)
  const suffix = input.slice(offset + match.length)
  const replaced = template
    .replace(/\{\{match\}\}/giu, match)
    .replace(/\$\$|\$&|\$`|\$'|\$\d{1,2}|\$<([^>]+)>/gu, (token, named: string | undefined) => {
      if (token === '$$') return '$'
      if (token === '$&') return match
      if (token === '$`') return prefix
      if (token === "$'") return suffix
      if (named !== undefined) {
        const value = groups?.[named]
        return value === undefined ? '' : filterString(value, trimStrings, macros)
      }
      const number = Number(token.slice(1))
      if (number === 0) return match
      const value = captures[number - 1]
      return value === undefined || value === null ? '' : filterString(String(value), trimStrings, macros)
    })
  return substituteMacros(replaced, macros)
}

/** Run one script with ST's surface/edit/depth gates applied. */
export function runRegexScript(
  script: RegexScript,
  rawString: string,
  macros: RegexMacros,
  options: RegexExecutionOptions = {},
): string {
  if (script.disabled || script.findRegex.length === 0 || rawString.length === 0) return rawString
  if (!appliesToSurface(script, options.surface ?? 'prompt')) return rawString
  if (options.isEdit === true && !script.runOnEdit) return rawString
  if (!appliesAtDepth(script, options.depth)) return rawString
  const find = regexFromString(substituteFindMacros(script.findRegex, macros, script.substituteRegex))
  if (find === null) return rawString
  if (find.global || find.sticky) find.lastIndex = 0
  try {
    return rawString.replace(find, (...args: unknown[]) => {
      const last = args.at(-1)
      const groups = last !== null && typeof last === 'object'
        ? last as Record<string, string | undefined> : undefined
      const input = typeof (groups === undefined ? last : args.at(-2)) === 'string'
        ? String(groups === undefined ? last : args.at(-2)) : rawString
      const offsetIndex = groups === undefined ? args.length - 2 : args.length - 3
      const offset = typeof args[offsetIndex] === 'number' ? args[offsetIndex] as number : 0
      const match = String(args[0] ?? '')
      return expandReplacement(
        script.replaceString,
        match,
        args.slice(1, offsetIndex),
        groups,
        offset,
        input,
        script.trimStrings,
        macros,
      )
    })
  } catch {
    return rawString
  }
}

/** 按序应用所有命中 placement 的未禁用脚本(ST getRegexedString 的主体)。 */
export function applyRegexScripts(
  scripts: readonly RegexScript[],
  text: string,
  placement: RegexPlacement,
  macros: RegexMacros,
  options: RegexExecutionOptions = {},
): string {
  let out = text
  for (const script of scripts) {
    if (script.disabled) continue
    if (!script.placement.includes(placement)) continue
    out = runRegexScript(script, out, macros, options)
  }
  return out
}

/** 全局正则脚本持久化:单文件 JSON(数组)。 */
export class RegexScriptStore {
  private scripts: RegexScript[] = []

  constructor(private readonly jsonPath: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.jsonPath, 'utf-8')) as unknown
      if (!Array.isArray(raw)) return
      const valid: RegexScript[] = []
      for (const item of raw) {
        const parsed = parseScriptShape(item)
        if (parsed !== null) valid.push(parsed)
      }
      this.scripts = valid
    } catch {
      // 文件不存在/损坏 = 空库启动
    }
  }

  list(): readonly RegexScript[] {
    return [...this.scripts]
  }

  get(id: string): RegexScript | undefined {
    return this.scripts.find(s => s.id === id)
  }

  /** 新建。findRegex 无效时抛错(路由层转 400)。 */
  create(fields: Partial<Omit<RegexScript, 'id' | 'createdAt'>>): RegexScript {
    const script = normalizeScript(fields, {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    })
    if (regexFromString(script.findRegex) === null) {
      throw new Error(`invalid findRegex: ${script.findRegex}`)
    }
    this.scripts.push(script)
    void this.persist()
    return script
  }

  /** 更新(按字段合并)。同样校验 findRegex。 */
  update(id: string, fields: Partial<Omit<RegexScript, 'id' | 'createdAt'>>): RegexScript | null {
    const idx = this.scripts.findIndex(s => s.id === id)
    if (idx < 0) return null
    const current = this.scripts[idx]
    if (current === undefined) return null
    const merged = normalizeScript({ ...current, ...fields }, {
      id: current.id,
      createdAt: current.createdAt,
    })
    if (regexFromString(merged.findRegex) === null) {
      throw new Error(`invalid findRegex: ${merged.findRegex}`)
    }
    this.scripts[idx] = merged
    void this.persist()
    return merged
  }

  delete(id: string): boolean {
    const before = this.scripts.length
    this.scripts = this.scripts.filter(s => s.id !== id)
    if (this.scripts.length === before) return false
    void this.persist()
    return true
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(dirname(this.jsonPath), { recursive: true })
      await writeFile(this.jsonPath, JSON.stringify(this.scripts, null, 2), 'utf-8')
    } catch (err) {
      process.stderr.write(`[regex-scripts] warn: persist failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
}

/** 从未知 JSON 形状解析/规整一条脚本;id/createdAt 由调用方给定。不校验 findRegex 可编译。 */
function normalizeScript(
  fields: Partial<Omit<RegexScript, 'id' | 'createdAt'>>,
  identity: { id: string; createdAt: string },
): RegexScript {
  const str = (v: unknown, fallback = ''): string => typeof v === 'string' ? v : fallback
  const placementRaw = Array.isArray(fields.placement) ? fields.placement : []
  const placement = placementRaw.filter((p): p is RegexPlacement =>
    typeof p === 'string' && (REGEX_PLACEMENTS as readonly string[]).includes(p))
  const trimRaw = Array.isArray(fields.trimStrings) ? fields.trimStrings : []
  return {
    id: identity.id,
    createdAt: identity.createdAt,
    scriptName: str(fields.scriptName, '未命名正则').slice(0, 100) || '未命名正则',
    findRegex: str(fields.findRegex),
    replaceString: str(fields.replaceString),
    trimStrings: trimRaw.filter((t): t is string => typeof t === 'string'),
    placement: placement.length > 0 ? placement : ['display'],
    disabled: fields.disabled === true,
    markdownOnly: fields.markdownOnly === true,
    promptOnly: fields.promptOnly === true,
    runOnEdit: fields.runOnEdit === true,
    substituteRegex: Number.isFinite(fields.substituteRegex) ? Math.trunc(fields.substituteRegex as number) : 0,
    minDepth: typeof fields.minDepth === 'number' && Number.isFinite(fields.minDepth) ? Math.trunc(fields.minDepth) : null,
    maxDepth: typeof fields.maxDepth === 'number' && Number.isFinite(fields.maxDepth) ? Math.trunc(fields.maxDepth) : null,
  }
}

function parseScriptShape(value: unknown): RegexScript | null {
  if (value === null || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  if (typeof obj.findRegex !== 'string' || obj.findRegex.length === 0) return null
  if (typeof obj.id !== 'string') return null
  return normalizeScript(obj as Partial<RegexScript>, {
    id: obj.id,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
  })
}
