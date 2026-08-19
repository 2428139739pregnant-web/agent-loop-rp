/** SillyTavern character card loader + one-shot preprocessing. */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readCharacterCardPng } from '../import/png.ts'
import {
  parseCharacterCardJson,
  parseCharacterCardJsonBytes,
} from '../import/character-card.ts'
import type { ImportedCharacterCard, ImportedLorebook, ImportedLorebookEntry } from '../import/types.ts'

/**
 * 角色卡导入后的一次性预处理产物。
 * 3 文档结构: 人设 / 世界观 / 文风。
 * 输出回复 agent 读取这 3 份卡片定义，并从 constantLorebookEntries 按
 * ST position 组装常驻世界书消息层。走关键词匹配的"绿灯"条目另存在
 * {@link dynamicLorebookEntries}。
 */
export interface PreprocessedCharacter {
  /** 角色名(从 card.name 取) */
  readonly name: string
  /** 原始卡片,完整保留不丢字段 */
  readonly raw: ImportedCharacterCard
  /** 拆分后的 3 份角色卡文档(新格式不预先合并蓝灯)。 */
  readonly persona: string
  readonly worldview: string
  readonly style: string
  /** 新格式中所有启用的蓝灯条目，交给统一 ST position 链路。 */
  readonly constantLorebookEntries?: readonly ImportedLorebookEntry[]
  /** 旧存档兼容：常驻世界书的 atDepth 条目。 */
  readonly atDepthLorebookEntries?: readonly ImportedLorebookEntry[]
  /**
   * 主开场白(对应角色卡 V2/V3 的 `first_mes` 字段,酒馆里"打开会话"立刻看到的那条)。
   * 已 trim;若卡片未提供则为占位文案。
   */
  readonly firstMes: string
  /**
   * 备选开场白列表(对应 V2/V3 的 `alternate_greetings[]`)。
   * 顺序与原卡一致;空白条目会被过滤掉。
   */
  readonly alternateGreetings: readonly string[]
  /**
   * 示例对话(对应 V2/V3 的 `mes_example`):`<START>` 分组、
   * `{{user}}:` / `{{char}}:` 行。注入 response prompt 的示例消息区
   * (人设后、历史前,ST 同款位置)。已 trim;卡未提供为空串。
   * (旧 preprocessed.json 存档缺此字段,加载时给空串默认。)
   */
  readonly mesExample: string
  /**
   * 卡片自定义系统提示词(对应 `system_prompt`):response 组装时**前置**在
   * system prompt 最前(ST power_user 允许它覆盖主 system prompt,本项目取前置拼接)。
   * 已 trim;卡未提供为空串。
   */
  readonly systemPrompt: string
  /**
   * 回复后指令(对应 `post_history_instructions`):注入在聊天历史**之后**,
   * 对模型是最后的强调指令(ST 同款位置)。已 trim;卡未提供为空串。
   */
  readonly postHistoryInstructions: string
  /**
   * 角色卡内嵌世界书(对应 V2/V3 的 `data.character_book`)。
   * 角色卡未携带 `character_book` 字段或字段为空 entries 时为 `undefined`。
   * 完整保留,供 `/api/characters/:id/worldbook` 给 UI 显示全量条目(基础 + 动态)。
   * `preprocessed.json` 持久化这个完整版本。
   */
  readonly lorebook?: ImportedLorebook | undefined
  /**
   * 仅"绿灯"类世界书条目(非 constant):走 2.1 LLM 语义匹配 → agent 3 决定是否使用。
    * 蓝灯条目保存在 constantLorebookEntries 中,不再列入此处,避免重复注入;
   * 禁用条目(enabled === false,即 ST disable)两边都不进,完全跳过(ST 语义)。
   */
  readonly dynamicLorebookEntries: readonly ImportedLorebookEntry[]
  /** 预处理时间戳(ISO 字符串) */
  readonly preprocessedAt: string
}

/**
 * 世界书条目按"蓝灯常驻元数据 vs 绿灯动态匹配"分类的结果。
 *
 * 蓝灯(constant: true 且 enabled)保留 ST position；实际 0–7 插入由
 * response 的统一消息树处理。这里的 split 桶仅保留旧 API/诊断兼容。
 * 绿灯(非 constant)→ dynamic,交给 2.1 worldbook-match agent。
 */
export interface CharacterLorebookSplit {
  /** All enabled constant entries, retaining their full ST position metadata. */
  readonly constant: readonly ImportedLorebookEntry[]
  /** 旧三文档消费者使用的 persona 桶(position 0 / before_char)。 */
  readonly persona: readonly ImportedLorebookEntry[]
  /** 旧三文档消费者使用的 worldview 桶(position 1 / after_char)。 */
  readonly worldview: readonly ImportedLorebookEntry[]
  /** 旧三文档消费者使用的 style 回退桶(position 2-7)。 */
  readonly style: readonly ImportedLorebookEntry[]
  /** position=4 (atDepth) entries kept separate from the style document. */
  readonly atDepth: readonly ImportedLorebookEntry[]
  /** 走 2.1 LLM 语义匹配的绿灯条目 */
  readonly dynamic: readonly ImportedLorebookEntry[]
}

/**
 * 角色卡字段到 3 文档的映射规则(硬编码字段映射)。
 * 同时提取 `first_mes` 主开场白、`alternate_greetings[]` 备选开场白,以及
 * `mes_example` / `system_prompt` / `post_history_instructions` 三个独立字段
 * (后两者不再混入文风文档,由 response 按酒馆位置单独注入:
 * system_prompt 前置、post_history_instructions 追加在历史之后)。
 *
   * 如果角色卡原始字段为空,会在结尾追加"必须从世界书蓝灯条目推断"的占位提示,
   * 而不是只显示"暂未提供"——蓝灯条目会在 response 消息树中随后注入。
 */
function splitIntoThreeDocuments(card: ImportedCharacterCard): {
  persona: string
  worldview: string
  style: string
  firstMes: string
  alternateGreetings: string[]
  mesExample: string
  systemPrompt: string
  postHistoryInstructions: string
} {
  // 人设: 角色主描述
  const persona = card.description.trim()
    || '（角色卡未提供 description;请按下方世界书常驻条目中标注为人设的内容回复。）'

  // 世界观: 场景设定
  const worldview = card.scenario.trim()
    || '（角色卡未提供 scenario;请按下方世界书常驻条目中标注为世界/背景的内容回复。）'

  // 文风: 性格(明确称为"要求",体现硬性约束)。
  // 注意:system_prompt / post_history_instructions 已拆成独立字段,不再拼进 style
  //(否则 response 的前置/追加注入会造成重复)。
  const styleParts: string[] = []
  styleParts.push('【回复要求 — 必须遵守】')
  if (card.personality.trim()) {
    styleParts.push(`性格特征(用于驱动语气):\n${card.personality.trim()}`)
  }
  if (styleParts.length === 1) {
    styleParts.push('（角色卡未提供文风;请按下方世界书常驻条目中标注为文风/叙事风格/回复格式的内容回复。）')
  }
  const style = styleParts.join('\n\n')

  // 主开场白: 角色卡 V2/V3 的 `first_mes` (字段名在 ImportedCharacterCard 里是
  // camelCase 的 `firstMessage`,对应 JSON 的 snake_case `first_mes`)。
  const firstMes = card.firstMessage.trim() || '（角色暂未设置开场白）'
  // 备选开场白: 过滤掉纯空白条目,保留非空字符串。
  const alternateGreetings = card.alternateGreetings
    .map(g => g.trim())
    .filter(g => g.length > 0)

  // 三个独立字段(酒馆位置语义见 PreprocessedCharacter 字段注释)。
  // ?? '' 兜底:旧存档 / wire 反序列化可能缺字段(undefined),统一空串默认。
  const mesExample = (card.messageExample ?? '').trim()
  const systemPrompt = (card.systemPrompt ?? '').trim()
  const postHistoryInstructions = (card.postHistoryInstructions ?? '').trim()

  return {
    persona, worldview, style, firstMes, alternateGreetings,
    mesExample, systemPrompt, postHistoryInstructions,
  }
}

// ─── 世界书条目分类:蓝灯常驻(position 映射)vs 绿灯动态 ───────────────────

/**
 * ST position 枚举 → 数值。换算与 ST world-info.js:5517 一致:
 * `extensions.position ?? (position === 'before_char' ? 0 : 1)`。
 */
export function entryStPosition(entry: ImportedLorebookEntry): number {
  if (typeof entry.stPosition === 'number' && Number.isFinite(entry.stPosition)) {
    return entry.stPosition
  }
  return entry.position === 'before_char' ? 0 : 1
}

/**
 * 启发式时代(按 content 关键词猜 persona/worldview/style)已被 ST position 映射
 * 取代:蓝灯条目的注入位置由卡片自带 position 决定,语义严格 = `constant && !disable`。
 *
 * 判定规则:
 * 1. `constant !== true`(绿灯)→ dynamic
 * 2. 蓝灯 → 按 position 保留元数据；response 阶段映射到 ST 八个插入点。
 *    legacy split 桶仅为旧调用方保留，不决定新 response 的实际插入。
 *
 * 禁用条目(enabled === false,ST disable)由 {@link classifyLorebookEntries}
 * 在分类前整体剔除——既不进文档也不进动态池(ST: disable → 直接跳过)。
 */
export function classifyLorebookEntry(entry: ImportedLorebookEntry): 'persona' | 'worldview' | 'style' | 'dynamic' {
  // 规则 1:非蓝灯 → 一定走动态(绿灯,2.1 LLM 语义匹配)
  if (entry.constant !== true) return 'dynamic'
  // 规则 2:蓝灯 → 保留 position；新 response 消费完整八位置计划。
  const st = entryStPosition(entry)
  if (st === 0) return 'persona'
  if (st === 1) return 'worldview'
  return 'style'
}

/** 把整本 lorebook 拆成"蓝灯常驻(position 映射)vs 绿灯动态"。 */
export function classifyLorebookEntries(book: ImportedLorebook): CharacterLorebookSplit {
  const constant: ImportedLorebookEntry[] = []
  const persona: ImportedLorebookEntry[] = []
  const worldview: ImportedLorebookEntry[] = []
  const style: ImportedLorebookEntry[] = []
  const atDepth: ImportedLorebookEntry[] = []
  const dynamic: ImportedLorebookEntry[] = []
  for (const e of book.entries) {
    // ST disable → 完全跳过(既不常驻注入,也不进匹配池)。
    if (e.enabled === false) continue
    const bucket = classifyLorebookEntry(e)
    if (e.constant) constant.push(e)
    if (bucket === 'persona') persona.push(e)
    else if (bucket === 'worldview') worldview.push(e)
    else if (bucket === 'style') {
      if (entryStPosition(e) === 4) atDepth.push(e)
      else style.push(e)
    }
    else dynamic.push(e)
  }
  // 蓝灯三桶按 insertionOrder(= ST order)**降序**拼接(ST world-info.js:87
  // sortFn = b.order - a.order);dynamic 保持升序稳定输出(下游 2.1 输出排序
  // 由 agent 统一处理,这里只保证稳定可调试)。
  const byOrderDesc = (a: ImportedLorebookEntry, b: ImportedLorebookEntry) => b.insertionOrder - a.insertionOrder
  const byOrderAsc = (a: ImportedLorebookEntry, b: ImportedLorebookEntry) => a.insertionOrder - b.insertionOrder
  return {
    constant: [...constant].sort(byOrderDesc),
    persona: [...persona].sort(byOrderDesc),
    worldview: [...worldview].sort(byOrderDesc),
    style: [...style].sort(byOrderDesc),
    atDepth: [...atDepth].sort(byOrderDesc),
    dynamic: [...dynamic].sort(byOrderAsc),
  }
}

/**
 * 从 PNG 文件加载角色卡并预处理。
 * @param filePath PNG 文件绝对路径
 */
export async function loadCharacterCardFromPng(filePath: string): Promise<PreprocessedCharacter> {
  const data = await readFile(resolve(filePath))
  const payload = readCharacterCardPng(new Uint8Array(data))
  // payload = { keyword: 'ccv3' | 'chara', json: string }
  const card = parseCharacterCardJson(payload.json)
  return preprocessCharacterCard(card)
}

/**
 * 从 JSON 字符串加载角色卡(已经是角色卡 JSON,不是 PNG 字节)。
 * 用于: 用户从酒馆导出 JSON 卡片、API 接收的 JSON 字符串。
 */
export function loadCharacterCardFromJson(json: string): PreprocessedCharacter {
  const card = parseCharacterCardJson(json)
  return preprocessCharacterCard(card)
}

/**
 * 从 JSON 字节加载。
 */
export function loadCharacterCardFromJsonBytes(data: Uint8Array): PreprocessedCharacter {
  const card = parseCharacterCardJsonBytes(data)
  return preprocessCharacterCard(card)
}

/**
 * 核心预处理: 从 ImportedCharacterCard 拆 3 文档 + 提取开场白与三个独立字段
 * (mes_example / system_prompt / post_history_instructions)+ 分类世界书条目。
 * 纯函数,方便单测。
 */
export function preprocessCharacterCard(card: ImportedCharacterCard): PreprocessedCharacter {
  const {
    persona, worldview, style, firstMes, alternateGreetings,
    mesExample, systemPrompt, postHistoryInstructions,
  } = splitIntoThreeDocuments(card)
  // 蓝灯条目保留完整 position 元数据；绿灯条目走 dynamic 路径。
  const split: CharacterLorebookSplit = card.lorebook !== undefined
    ? classifyLorebookEntries(card.lorebook)
    : { constant: [], persona: [], worldview: [], style: [], atDepth: [], dynamic: [] }
  const constantLorebookEntries = split.constant
  return {
    name: card.name,
    raw: card,
    persona,
    worldview,
    style,
    constantLorebookEntries,
    // New cards route every constant through the merged WorldbookStore. Keep
    // the legacy field empty so response cannot inject position=4 twice.
    atDepthLorebookEntries: [],
    firstMes,
    alternateGreetings,
    mesExample,
    systemPrompt,
    postHistoryInstructions,
    lorebook: card.lorebook,
    dynamicLorebookEntries: split.dynamic,
    preprocessedAt: new Date().toISOString(),
  }
}
