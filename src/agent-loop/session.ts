/** In-memory session and worldbook stores for the agent loop. */

import type { ChatMessage } from './provider.ts'

export interface SessionStore {
  getHistory(sessionId: string): readonly ChatMessage[]
  appendMessage(sessionId: string, message: ChatMessage): void
  /** 整体替换某会话的历史(删消息/重 roll 截断用);counter 同步重算。 */
  setHistory(sessionId: string, messages: readonly ChatMessage[]): void
  turnCount(sessionId: string): number
  /** Returns the path where ④ should write its summary; resolves lazily. */
  summaryPath(sessionId: string): string
}

/** A simple in-process session store. Resets on process restart by design. */
export class MemorySessionStore implements SessionStore {
  private readonly histories = new Map<string, ChatMessage[]>()
  private readonly counter = new Map<string, number>()

  getHistory(sessionId: string): readonly ChatMessage[] {
    return this.histories.get(sessionId) ?? []
  }

  appendMessage(sessionId: string, message: ChatMessage): void {
    const list = this.histories.get(sessionId) ?? []
    list.push(message)
    this.histories.set(sessionId, list)
    this.counter.set(sessionId, list.filter(m => m.role === 'assistant').length)
  }

  setHistory(sessionId: string, messages: readonly ChatMessage[]): void {
    const list = [...messages]
    this.histories.set(sessionId, list)
    this.counter.set(sessionId, list.filter(m => m.role === 'assistant').length)
  }

  turnCount(sessionId: string): number {
    return this.counter.get(sessionId) ?? 0
  }

  summaryPath(sessionId: string): string {
    return `summary/${sessionId}.md`
  }
}

/** One worldbook entry with its declaration metadata. */
export interface WorldbookEntry {
  path: string
  /** ST comment/memo; extension directives are commonly stored here. */
  comment?: string
  keywords: string[]
  order: number
  weight: number
  content: string
  // ─── SillyTavern 条目参数透传(可选:老 fixture / 旧存档缺省时按 ST 默认值处理)───
  /** ST 蓝灯(constant):true = 无条件每轮激活,不进 2.1 绿灯匹配池。缺省 false。 */
  constant?: boolean
  /** ST disable 取反。缺省视为 true(启用)。false = 完全跳过(既不匹配也不常驻)。 */
  enabled?: boolean
  /** ST 次关键词(keysecondary),配合 selectiveLogic 判定。 */
  secondaryKeywords?: readonly string[]
  /** ST 是否启用次关键词筛选；缺省 false。 */
  selective?: boolean
  /** ST 次关键词逻辑:and-any(0) / not-all(1) / not-any(2) / and-all(3)。缺省 and-any。 */
  selectiveLogic?: 'and-any' | 'and-all' | 'not-any' | 'not-all'
  /** ST 条目级大小写敏感(缺省 false,不敏感)。 */
  caseSensitive?: boolean
  /** ST 条目级整词匹配(缺省 false,子串匹配)。 */
  matchWholeWords?: boolean
  /** ST 正则关键词(key 写法 /pattern/flags)标记。 */
  useRegex?: boolean
  /** ST 激活概率 %(缺省 100)。绿灯由代码在 agent 选中后掷骰。 */
  probability?: number
  /** ST 概率开关(缺省 true;false = 跳过掷骰)。 */
  useProbability?: boolean
  /** ST position 枚举原值(0=before_char,1=after_char,2-7 其他)。蓝灯常驻注入的文档映射用。 */
  position?: number
  /** Optional message role supplied by Tavern Helper's position descriptor. */
  role?: 'system' | 'user' | 'assistant'
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
  /** ST/Tavern Helper timed effect: keep active for N subsequent messages. */
  sticky?: number
  /** ST/Tavern Helper timed effect: block activation for N subsequent messages. */
  cooldown?: number
  /** ST/Tavern Helper timed effect: require N chat messages before activation. */
  delay?: number
  /** Preserve ST's budget bypass flag for deterministic activation. */
  ignoreBudget?: boolean
  /** Decorated/template entries are retained but not activated by the Harness. */
  hasDecorators?: boolean
}

export interface WorldbookStore {
  /** Returns entries whose `keywords` overlap (case-insensitive substring) with any of the input keywords. */
  match(keywords: readonly string[]): WorldbookEntry[]
  /** Reads the raw content of a worldbook file by relative path. */
  getContent(path: string): string | undefined
  /** Lists every known entry — useful for tests and tooling. */
  list(): readonly WorldbookEntry[]
}

/** A worldbook store seeded from a list of entries (typically loaded from _fixtures). */
export class MemoryWorldbookStore implements WorldbookStore {
  private readonly byPath = new Map<string, WorldbookEntry>()

  constructor(entries: readonly WorldbookEntry[] = []) {
    for (const entry of entries) this.byPath.set(entry.path, entry)
  }

  match(keywords: readonly string[]): WorldbookEntry[] {
    if (keywords.length === 0) return []
    const lowered = keywords.map(k => k.toLowerCase())
    const hits: WorldbookEntry[] = []
    for (const entry of this.byPath.values()) {
      const entryKeys = entry.keywords.map(k => k.toLowerCase())
      const matched = lowered.some(needle => entryKeys.some(key => key.includes(needle)))
      if (matched) hits.push(entry)
    }
    hits.sort((a, b) => a.order - b.order || b.weight - a.weight)
    return hits
  }

  getContent(path: string): string | undefined {
    return this.byPath.get(path)?.content
  }

  list(): readonly WorldbookEntry[] {
    return [...this.byPath.values()].sort((a, b) => a.order - b.order)
  }
}
