/** Agent loop orchestrator: 1 → 2.1 → 2.2 → 3 + optional async ④ summarize trigger. */

import type { Agent, AgentContext, PostprocessRuntimeSettings, WorldbookGlobalScanData, WorldbookSettings } from './agents/types.ts'
import { DEFAULT_WORLDBOOK_SETTINGS } from './agents/types.ts'
import type { LLMProvider } from './provider.ts'
import type { PromptLoader } from './agents/types.ts'
import type { SessionStore, WorldbookStore } from './session.ts'
import type { PreprocessedCharacter } from './character-loader.ts'
import type { ResponseGenerationSettings } from './response-settings.ts'
import type { triggerSummarize } from './agents/summarize.ts'
import type { TavernHelperState } from '../tavern-helper.ts'
import { runMvuUpdate, type MvuRuntimeSettings } from './agents/mvu-update.ts'
import { readMvuStateFromMessages } from '../mvu.ts'
import { buildWorldbookMatchInput, deterministicWorldbookMatch } from './agents/worldbook-match.ts'
import { applyWorldbookRenderDirectives } from './worldbook-plugin.ts'
import type {
  ContextSegmentOutput,
  IntentOutput,
  ReplyResult,
  WorldbookMatchOutput,
} from './schema.ts'

/** ②.2 context agent's input shape — re-exported here so callers don't have to dig into the agent file. */
export interface ContextProcessInput {
  intent: IntentOutput
  worldbookMatches?: WorldbookMatchOutput
  worldbookHints?: readonly string[]
  reader: import('./agents/context-process.ts').ContextReader
}

/** ③ response agent's input shape — re-exported here so callers don't have to dig into the agent file. */
export interface ResponseInput {
  intent: IntentOutput
  worldbook: WorldbookMatchOutput
  contextSegmentation: ContextSegmentOutput
  userInput: string
  character: PreprocessedCharacter
  /** 用户 persona(酒馆 {{user}})。null = 未配置。 */
  userPersona?: { name: string; description: string } | null
  /** 用户可配置的人称与正文长度；缺省时跟随角色卡。 */
  responseSettings?: ResponseGenerationSettings
}

/**
 * Build a ContextReader from the in-memory session store.
 * 2.2 needs read-only access to past assistant turns and (later) summaries.
 * The summary layer is empty for now — ④'s async writer will populate it
 * out-of-band once it's wired up.
 */
function buildContextReader(session: SessionStore, sessionId: string): import('./agents/context-process.ts').ContextReader {
  return {
    listConversations: () => {
      const history = session.getHistory(sessionId)
      let turn = 0
      const out: import('./agents/context-process.ts').ConversationSegment[] = []
      for (const m of history) {
        if (m.role !== 'assistant') continue
        turn += 1
        out.push({ id: turn, content: m.content })
      }
      return out
    },
    readConversation: (id) => {
      const history = session.getHistory(sessionId)
      let turn = 0
      for (const m of history) {
        if (m.role !== 'assistant') continue
        turn += 1
        if (turn === id) return { id, content: m.content }
      }
      return undefined
    },
    listSummaries: () => [],
    readSummary: () => undefined,
  }
}

/**
 * User-facing inputs to `runLoop`. The caller hands in the LLM provider,
 * model, stores, session id, and the preprocessed character for that session.
 * Agents are optional — when omitted, the loop short-circuits to a mock reply.
 */
export interface RunLoopDeps {
  provider: LLMProvider
  model: string
  prompts: PromptLoader
  session: SessionStore
  worldbook: WorldbookStore
  sessionId: string
  /** 3-document character card, preprocessed at session bind time. Required when response agent is supplied. */
  character?: PreprocessedCharacter
  /** 用户 persona(酒馆 {{user}})。可选;未配置时 response 以"用户"泛称。 */
  userPersona?: { name: string; description: string } | null
  /** 用户可配置的人称与正文长度；缺省时跟随角色卡。 */
  responseSettings?: ResponseGenerationSettings
  /** 重 roll 用:跳过把 userInput 重新 append 进历史(该轮 user 消息已在历史里)。 */
  skipUserAppend?: boolean
  /** 落库前的确定性后处理(正则脚本 ai_output 位)。在 ⑤ postprocess 之后应用。 */
  transformReply?: (reply: string) => string
  /**
   * 世界书全局设置(绿灯扫描深度 / LLM 匹配开关,酒馆 world_info_depth 对应物)。
   * 可选;缺省 scanDepth=2 + useLlmMatcher=true(ST 默认,见 DEFAULT_WORLDBOOK_SETTINGS)。
   */
  worldbookSettings?: WorldbookSettings
  /** ST World Info chat-independent scan fields. */
  worldbookGlobalScanData?: WorldbookGlobalScanData
  /** Session-owned Tavern Helper prompt injections and scan text. */
  tavernHelperState?: TavernHelperState
  /** Optional ⑤ postprocess settings; omitted callers use the agent defaults. */
  postprocessSettings?: PostprocessRuntimeSettings
  /** Optional independent MVU post-response analysis settings. */
  mvu?: MvuRuntimeSettings
  /**
   * Optional async ④ summarize trigger. When provided, `runLoop` fires it
   * (fire-and-forget) after appending the assistant reply so the next turn's
   * 2.2 can read the just-written summary.
   */
  summarize?: (ctx: AgentContext, input: Parameters<typeof triggerSummarize>[0]) => void
}

/** Optional agent overrides. When any agent is omitted the loop returns a mock reply. */
export interface RunLoopAgents {
  intent?: Agent<string, IntentOutput>
  /** 2.1 绿灯匹配:输入由 {@link buildWorldbookMatchInput} 组装(最近 N 条消息 + 候选条目参数表)。 */
  worldbook?: Agent<import('./agents/worldbook-match.ts').WorldbookMatchInput, WorldbookMatchOutput>
  context?: Agent<ContextProcessInput, ContextSegmentOutput>
  response?: Agent<ResponseInput, ReplyResult>
  postprocess?: Agent<string, string>
}

const DEFAULT_TEMPERATURE = 0.7
const MOCK_REPLY =
  '（mock reply）agent 链路尚未接入。传入完整的 agents 集合即可触发真实回复。'

function buildContext(deps: RunLoopDeps): AgentContext {
  return {
    provider: deps.provider,
    model: deps.model,
    temperature: DEFAULT_TEMPERATURE,
    prompts: deps.prompts,
    session: deps.session,
    worldbook: deps.worldbook,
    sessionId: deps.sessionId,
    // 世界书设置(扫描深度等);缺省走 ST 默认(scanDepth=2)。
    worldbookSettings: deps.worldbookSettings ?? DEFAULT_WORLDBOOK_SETTINGS,
    ...(deps.worldbookGlobalScanData === undefined ? {} : { worldbookGlobalScanData: deps.worldbookGlobalScanData }),
    ...(deps.tavernHelperState === undefined ? {} : { tavernHelperState: deps.tavernHelperState }),
    ...(deps.postprocessSettings === undefined ? {} : { postprocessSettings: deps.postprocessSettings }),
    // {{user}}/{{char}} 宏替换源:persona 名 + 角色名(酒馆语义:WI key 匹配与
    // content 注入前替换)。未配置时对应侧传 null,保持宏原样。
    macros: {
      user: deps.userPersona?.name ?? null,
      char: deps.character?.name ?? null,
    },
  }
}

/**
 * Run the full 1→2.1→2.2→3 chain for one user turn.
 *
 * Minimal version: when the caller does not supply every agent in the chain,
 * the loop returns a deterministic mock reply and only records bookkeeping
 * (append the user input, append the assistant reply, expose the new turn
 * count). The full agent chain will replace this body once each agent is
 * implemented.
 */
export async function runLoop(
  userInput: string,
  deps: RunLoopDeps,
  agents: RunLoopAgents = {},
): Promise<ReplyResult> {
  if (deps.skipUserAppend !== true) {
    deps.session.appendMessage(deps.sessionId, { role: 'user', content: userInput })
  }

  const ctx = buildContext(deps)
  let reply = MOCK_REPLY
  let displayReply: string | undefined
  let usedWorldbook = false
  let usedContextSegmentation = false

  if (
    agents.intent !== undefined
    && agents.worldbook !== undefined
    && agents.context !== undefined
    && agents.response !== undefined
  ) {
    if (deps.character === undefined) {
      throw new Error('runLoop: deps.character is required when the full agent chain is supplied')
    }
    const intent = await agents.intent.run(userInput, ctx)
    // 2.1 输入改为结构化(最近 N 条消息 + 候选绿灯条目参数表,ST 语义适配):
    // 组装逻辑在 buildWorldbookMatchInput 内(读 ctx.session / ctx.worldbook /
    // ctx.worldbookSettings / ctx.macros),输出 schema 不变。
    const worldbookInput = buildWorldbookMatchInput(intent, ctx)
    const reader = buildContextReader(deps.session, deps.sessionId)
    // Worldbook semantics and context compaction are independent calls. The
    // context branch receives only a local ST keyword baseline as a hint, so it
    // never waits for or consumes the semantic matcher output.
    const worldbookHints = deterministicWorldbookMatch(worldbookInput, { rollProbability: false })
      .map(candidate => candidate.path)
    const [worldbookMatch, contextSegs] = await Promise.all([
      agents.worldbook.run(worldbookInput, ctx),
      agents.context.run({ intent, worldbookHints, reader }, ctx),
    ])
    const responseInput: ResponseInput = {
      intent,
      worldbook: worldbookMatch,
      contextSegmentation: contextSegs,
      userInput,
      character: deps.character,
      userPersona: deps.userPersona ?? null,
      ...(deps.responseSettings === undefined ? {} : { responseSettings: deps.responseSettings }),
    }
    const result = await agents.response.run(responseInput, ctx)
    if (result.reply.length > 0) reply = result.reply
    usedWorldbook = worldbookMatch.matches.length > 0
    usedContextSegmentation = contextSegs.segments.length > 0

    // ⑤ postprocess: revise the reply in place before persistence.
    // Skipped for the mock reply so the demo path stays cheap.
    if (agents.postprocess !== undefined && reply !== MOCK_REPLY) {
      try {
        reply = await agents.postprocess.run(reply, ctx)
      } catch (err) {
        console.error('[runLoop] postprocess failed, keeping raw reply:', err)
      }
    }

    // The final ai_output transformation belongs to the prose path. Keep it
    // before MVU so machine tags added by the dedicated call cannot be
    // accidentally rewritten by an output regex.
    if (deps.transformReply !== undefined) {
      reply = deps.transformReply(reply)
    }

    // MVU is a separate post-response call. It sees the final prose from the
    // response/postprocess path, uses its own model/temperature, and is
    // allowed to fail without discarding the user-visible reply.
    if (deps.mvu?.enabled === true && reply !== MOCK_REPLY) {
      const currentMvu = readMvuStateFromMessages(
        deps.character.raw,
        deps.session.getHistory(deps.sessionId),
        { user: deps.userPersona?.name ?? '用户', char: deps.character.name },
      )
      if (currentMvu !== undefined) {
        try {
          const update = await runMvuUpdate(
            { character: deps.character, userInput, assistantReply: reply, statData: currentMvu.statData },
            ctx,
            deps.mvu,
          )
          if (update.update !== undefined) reply = `${reply.trimEnd()}\n\n${update.update}`
        } catch (err) {
          console.error('[runLoop] MVU update failed, keeping prose:', err)
        }
      }
    }

    // [RENDER:*] is display-only. Keep the canonical reply in SessionStore so
    // reroll/context never feed a rendered decoration back into the model.
    const rendered = applyWorldbookRenderDirectives(reply, worldbookMatch.plugin?.renderDirectives ?? [])
    if (rendered !== reply) displayReply = rendered
  }

  deps.session.appendMessage(deps.sessionId, { role: 'assistant', content: reply })

  // Fire-and-forget ④ summarize: never await, never block the response flow.
  if (deps.summarize !== undefined) {
    try {
      const summarizeMessages = [
        { role: 'user' as const, content: userInput },
        { role: 'assistant' as const, content: reply },
      ]
      const char = deps.character
      deps.summarize(ctx, char
        ? { messages: summarizeMessages, character: { name: char.name, persona: char.persona } }
        : { messages: summarizeMessages },
      )
    } catch (err) {
      console.error('[runLoop] summarize trigger threw synchronously:', err)
    }
  }

  return {
    reply,
    ...(displayReply === undefined ? {} : { displayReply }),
    sessionId: deps.sessionId,
    turn: deps.session.turnCount(deps.sessionId),
    usedWorldbook,
    usedContextSegmentation,
  }
}
