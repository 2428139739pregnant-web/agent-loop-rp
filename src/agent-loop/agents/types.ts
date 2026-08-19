/** Shared agent-loop types: context, agent contract, prompt loader. */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { EjsTemplateResult, EjsTemplateTarget } from '../../ejs-template.ts'
import type { LLMProvider } from '../provider.ts'
import type { SessionStore, WorldbookStore } from '../session.ts'
import type { TimedEffectState } from '../worldbook-timed-effects.ts'
import type { TavernHelperState } from '../../tavern-helper.ts'

/** Reads a prompt template by name. The `name` is the file stem in the prompts directory. */
export interface PromptLoader {
  load(name: string): Promise<string>
}

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

/** Loads `.md` files from `src/agent-loop/prompts/` keyed by file stem. */
export class FilePromptLoader implements PromptLoader {
  private readonly dir: string
  constructor(rootDir?: string) {
    this.dir = rootDir ? resolve(rootDir) : PROMPTS_DIR
  }

  async load(name: string): Promise<string> {
    const path = join(this.dir, `${name}.md`)
    return readFile(path, 'utf8')
  }
}

/** In-memory loader for tests and the demo. */
export class InMemoryPromptLoader implements PromptLoader {
  private readonly entries = new Map<string, string>()
  set(name: string, body: string): void {
    this.entries.set(name, body)
  }
  async load(name: string): Promise<string> {
    const body = this.entries.get(name)
    if (body === undefined) throw new Error(`prompt template not found: ${name}`)
    return body
  }
}

export type WorldbookMatchMode = 'strict' | 'enhanced' | 'native'

/** Chat-independent fields exposed to ST World Info matching. */
export interface WorldbookGlobalScanData {
  readonly personaDescription?: string
  readonly characterDescription?: string
  readonly characterPersonality?: string
  readonly characterDepthPrompt?: string
  readonly scenario?: string
  readonly creatorNotes?: string
}

/** 世界书全局设置(对应 SillyTavern world_info_depth 等 world-info.js:69-86 全局项)。 */
export interface WorldbookSettings {
  /**
   * 绿灯扫描深度:取最近 N 条消息(用户+角色都算)作为 2.1 匹配的扫描文本。
   * ST 默认 `world_info_depth = 2`,本项目同款默认。
   */
  readonly scanDepth: number
  /**
   * 兼容旧配置的开关。未提供 mode 时,false 映射为 strict,true 映射为 enhanced。
   * 新配置应使用 mode。
   */
  readonly useLlmMatcher: boolean
  /** 普通绿灯条目的最终判断权。默认 enhanced。 */
  readonly mode?: WorldbookMatchMode
}

/** Resolve the explicit mode while preserving old worldbook-settings.json files. */
export function resolveWorldbookMatchMode(settings?: WorldbookSettings): WorldbookMatchMode {
  if (settings?.mode !== undefined) return settings.mode
  return settings?.useLlmMatcher === false ? 'strict' : 'enhanced'
}

/** 绿灯匹配的默认设置:扫描最近 2 条消息 + ST 基线与 agent 语义增强。 */
export const DEFAULT_WORLDBOOK_SETTINGS: WorldbookSettings = {
  scanDepth: 2,
  useLlmMatcher: true,
  mode: 'enhanced',
}

/** Runtime knobs for the optional ⑤ postprocess pipeline. */
export interface PostprocessRuntimeSettings {
  readonly maxRounds?: number
  readonly densityMax?: number
  readonly deferExtract?: boolean
  readonly modelOverrides?: {
    readonly a?: string
    readonly b?: string
    readonly c?: string
    readonly extract?: string
  }
}

/** Optional progress callback for agents that run multiple sub-steps (e.g. postprocess).
 *  `step` is a short label (e.g. "pass-a"); `detail` is any extra data to surface. */
export type AgentProgressCallback = (step: string, detail?: Record<string, unknown>) => void

/** Runtime context handed to every agent. */
export interface AgentContext {
  readonly provider: LLMProvider
  readonly model: string
  readonly temperature: number
  readonly prompts: PromptLoader
  readonly session: SessionStore
  readonly worldbook: WorldbookStore
  /** Current session identifier, so agents don't have to thread it through their inputs. */
  readonly sessionId: string
  /**
   * 世界书全局设置(扫描深度 / LLM 匹配开关)。缺省用
   * {@link DEFAULT_WORLDBOOK_SETTINGS}(scanDepth=2,useLlmMatcher=true)。
   */
  readonly worldbookSettings?: WorldbookSettings
  /** Session-owned ST World Info sticky/cooldown/delay state. */
  readonly worldbookTimedEffects?: TimedEffectState
  /** ST World Info global scan data; entries opt into each field individually. */
  readonly worldbookGlobalScanData?: WorldbookGlobalScanData
  /** Session-owned Tavern Helper state, including prompt injections and scan text. */
  readonly tavernHelperState?: TavernHelperState
  /** Optional ⑤ postprocess settings supplied by the host. */
  readonly postprocessSettings?: PostprocessRuntimeSettings
  /**
   * {{user}} / {{char}} 宏替换源(酒馆语义:世界书 key 匹配前与 content 注入前替换,
   * macros.js / persona 的 name1)。null = 该侧不替换(未配置 persona / 无角色)。
   * 缺省(整个字段不传)= 两侧都不替换。
   */
  readonly macros?: { user: string | null; char: string | null }
  /** Optional isolated ST-Prompt-Template EJS renderer for card-owned text. */
  readonly renderTemplate?: (template: string, target?: EjsTemplateTarget) => EjsTemplateResult
  /** Current MVU `stat_data`, exposed to prompts/templates when available. */
  readonly statData?: JsonValue
  /**
   * 可选进度回调:多步骤 agent(如 ⑤ postprocess)在每个子步骤开始/完成时调用,
   * step = 子步骤名(如 "pass-a"), detail = 附加数据。
   */
  readonly onProgress?: AgentProgressCallback
}

/** Every agent is a tiny object with one async `run` method. */
export interface Agent<I, O> {
  readonly name: string
  run(input: I, ctx: AgentContext): Promise<O>
}

/** Helper: parse the model's JSON output and validate it through a schemastery schema. */
export function parseJson<T>(schema: (data: unknown) => T, raw: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`failed to parse agent JSON output: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return schema(parsed)
}
