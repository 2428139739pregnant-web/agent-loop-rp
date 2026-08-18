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
 *  与 ST 的差异(有意裁剪):
 *   - placement 用字符串枚举而非数字;SLASH_COMMAND/REASONING 不适用本架构
 *   - markdownOnly/promptOnly 用显式 placement 表达(display=只影响显示不改存档)
 *   - minDepth/maxDepth/runOnEdit、scoped(角色卡内)与 preset 脚本类型暂不支持
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
    const m = input.match(/(\/?)(.+)\1([a-z]*)/i)
    if (m === null) return null
    if (m[3] !== undefined && m[3] !== '' && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/u.test(m[3])) {
      return new RegExp(input)
    }
    return new RegExp(m[2] ?? input, m[3] ?? '')
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
export function runRegexScript(script: RegexScript, rawString: string, macros: RegexMacros): string {
  if (script.disabled || script.findRegex.length === 0 || rawString.length === 0) return rawString
  const find = regexFromString(script.findRegex)
  if (find === null) return rawString
  if (find.global || find.sticky) find.lastIndex = 0
  try {
    return rawString.replace(find, (...args: unknown[]) => {
      const groups = args[args.length - 1] as Record<string, string> | undefined
      // {{match}} → $0(ST 同款预映射),由下面的捕获组分支统一处理
      const template = script.replaceString.replace(/\{\{match\}\}/giu, '$0')
      const replaced = template.replace(/\$(\d+)|\$<([^>]+)>/gu, (_m, num: string | undefined, name: string | undefined) => {
        let captured: string | undefined
        if (num !== undefined) captured = args[Number(num)] as string | undefined
        else if (name !== undefined) captured = groups?.[name]
        if (captured === undefined || captured === null) return ''
        return filterString(captured, script.trimStrings, macros)
      })
      return substituteMacros(replaced, macros)
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
): string {
  let out = text
  for (const script of scripts) {
    if (script.disabled) continue
    if (!script.placement.includes(placement)) continue
    out = runRegexScript(script, out, macros)
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
