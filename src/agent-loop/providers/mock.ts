/** Deterministic mock LLM provider for demos and tests. */

import type { ChatMessage, ChatOptions, LLMProvider, LLMResult } from '../provider.ts'

const INTENT_FIXTURE = JSON.stringify({
  userNarration: '你好，我想问问莉娜关于火系法术的事',
  metaCommands: [],
  involvedCharacters: ['莉娜'],
  keywords: ['火系', '法术', '莉娜'],
})

const WORLDBOOK_FIXTURE = JSON.stringify({
  matches: [
    {
      path: '魔法.md',
      order: 1,
      weight: 10,
      content: '本世界的魔法分为火系、冰系、雷系三大派系。火系擅长攻击，冰系擅长控制，雷系擅长连锁。',
    },
    {
      path: '角色背景.md',
      order: 2,
      weight: 8,
      content: '莉娜出身于北方渔村，幼年目睹家园被冰系法师冻结，立志成为火系法师。',
    },
  ],
})

const CONTEXT_FIXTURE = JSON.stringify({
  segments: [
    { id: 1, mode: 'full' },
    { id: 2, mode: 'summary' },
    { id: 3, mode: 'drop' },
  ],
})

const RESPONSE_FIXTURE =
  '莉娜抬起头，火光在她眼底跳动：「你想了解火系？那得先知道它的代价——' +
  '吟唱虽短，但每一次过度施法都会引燃施法者本身。我之所以选择这条路，' +
  '是因为……算了，这些事说来话长。」\n\n' +
  // ⑤ postprocess 链路在 mock 模式下也能完整跑通:fixture 末尾带孕期关键词让 gate 通过。
  // extract 已改为后台异步，不阻塞 mock/真实回复的 final 事件。
  '妊娠状态：孕 12 周，腹部微微隆起。胎儿状态：胎心稳定。'

function classify(systemContent: string): string {
  // Match the exact first-line phrase from each prompt template. Each agent
  // references the others (e.g. 2.1 mentions "① 意图识别 agent"), so we
  // anchor on the unique first line of the agent's own prompt.
  if (systemContent.startsWith('你是角色扮演场景的意图识别')) return INTENT_FIXTURE
  if (systemContent.startsWith('你是世界书关键词匹配')) return WORLDBOOK_FIXTURE
  if (systemContent.startsWith('你是上下文处理')) return CONTEXT_FIXTURE
  if (systemContent.startsWith('你是角色扮演输出回复')) return RESPONSE_FIXTURE
  if (systemContent.startsWith('你是异步摘要')) return ''  // ④ returns plain text
  return 'mock-fallback'
}

/** Returns hard-coded structured responses keyed off the system prompt topic. */
export class MockProvider implements LLMProvider {
  readonly name = 'mock'
  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<LLMResult> {
    const system = messages.find(m => m.role === 'system')?.content ?? ''
    const user = messages.find(m => m.role === 'user')?.content ?? ''
    // Stash the system prompt so tests / the demo can inspect routing.
    MockProvider.lastSystem = system
    const content = classify(system)
    // Stash the last classification so tests / the demo can inspect routing.
    MockProvider.lastRoute = (() => {
      if (content === INTENT_FIXTURE) return 'intent'
      if (content === WORLDBOOK_FIXTURE) return 'worldbook'
      if (content === CONTEXT_FIXTURE) return 'context'
      if (content === RESPONSE_FIXTURE) return 'response'
      if (content === '') return 'summarize'
      return 'fallback'
    })()
    return {
      content,
      usage: {
        prompt_tokens: system.length + user.length,
        completion_tokens: content.length,
      },
    }
  }

  /** Last classified route — exposed for the demo to print the agent chain. */
  static lastRoute: 'intent' | 'worldbook' | 'context' | 'response' | 'summarize' | 'fallback' = 'fallback'
  /** Last system prompt seen — exposed for debugging misroutes. */
  static lastSystem: string = ''
}
