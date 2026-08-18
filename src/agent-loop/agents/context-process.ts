/** Agent 2.2 — Context segmentation.
 *
 * Takes the user's intent, the activated worldbook matches, and a read-only
 * {@link ContextReader} that exposes past conversation segments + their
 * pre-computed summaries. For every segment, decides whether downstream
 * should inject the full text, the summary only, or drop the segment
 * entirely. Returns a `ContextSegmentOutput` consumed by the reply agent.
 *
 * Falls back to a deterministic keyword scan whenever the LLM either fails
 * to respond, returns malformed JSON, omits a segment id, or emits an
 * invalid `mode`. The fallback keeps the pipeline alive: as long as the
 * reader has data, we always return one decision per segment.
 */

import {
  ContextSegmentOutputSchema,
  type ContextSegment,
  type ContextSegmentOutput,
  type IntentOutput,
  type WorldbookMatchOutput,
} from '../schema.ts'
import type { Agent, AgentContext } from './types.ts'

/** One past conversation segment as stored by the loop. */
export interface ConversationSegment {
  /** Stable segment id (1-based, monotonic). */
  id: number
  /** Full assistant output for that turn. */
  content: string
}

/** One pre-computed summary for a conversation segment. */
export interface SummarySegment {
  id: number
  summary: string
}

/**
 * Read-only view of the historical dialogue store.
 *
 * The loop injects a real implementation; tests pass a stub. We intentionally
 * do not couple this to `SessionStore` because summaries are written by ④
 * asynchronously and may live in a separate index.
 */
export interface ContextReader {
  /** All conversation segments, ordered by id ascending. */
  listConversations(): readonly ConversationSegment[]
  /** Look up one segment by id. May be missing (gap in the log). */
  readConversation(id: number): ConversationSegment | undefined
  /** All summaries whose corresponding segment has been summarized. */
  listSummaries(): readonly SummarySegment[]
  /** Look up one summary by id. May be missing (not yet summarized). */
  readSummary(id: number): SummarySegment | undefined
}

/** Input contract for {@link contextProcessAgent}. */
export interface ContextProcessInput {
  intent: IntentOutput
  worldbookMatches: WorldbookMatchOutput
  reader: ContextReader
}

/** Matches a fenced markdown block: ```json\n{...}\n``` or ```{...}``` */
const FENCED_JSON_RE = /```(?:json)?\s*([\s\S]+?)\s*```/

/** Greedy match for the first balanced-ish `{ ... }` substring. */
const FIRST_OBJECT_RE = /\{[\s\S]*\}/

/** Variable placeholder used in prompt templates, e.g. `{{intent}}`. */
const TEMPLATE_VAR_RE = /\{\{(\w+)\}\}/g

/**
 * Replace `{{name}}` placeholders in a template with values from `vars`.
 * Unknown variables are left untouched so the user can spot them in the
 * rendered prompt instead of silently losing data.
 */
function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(TEMPLATE_VAR_RE, (match, key: string) => {
    const value = vars[key]
    return value === undefined ? match : value
  })
}

/**
 * Parse the model's raw response into a validated {@link ContextSegmentOutput}.
 *
 * Fallback ladder — each step is independent, a failure moves to the next:
 *  1. `JSON.parse` the whole string as-is.
 *  2. Extract the body of the first ```` ```json ... ``` ```` code block.
 *  3. Grab the first `{...}` substring (handles "Here you go: {...}" prose).
 *  4. Give up and return `{ segments: [] }` so the keyword-scan fallback can
 *     rebuild the list from scratch.
 *
 * Never throws. Schemastery applies its defaults for any missing fields.
 */
export function parseContextSegmentResponse(raw: string): ContextSegmentOutput {
  const candidates: string[] = [raw]

  const fenced = FENCED_JSON_RE.exec(raw)
  if (fenced && fenced[1] !== undefined) candidates.push(fenced[1])

  const first = FIRST_OBJECT_RE.exec(raw)
  if (first && first[0] !== undefined) candidates.push(first[0])

  for (const candidate of candidates) {
    try {
      // JSON.parse returns `any`, which fits the schemastery input slot.
      return ContextSegmentOutputSchema(JSON.parse(candidate))
    } catch {
      // Try the next candidate.
    }
  }

  // Last resort: empty list. Caller will fall back to keyword scan and
  // rebuild one decision per segment from scratch.
  return { segments: [] }
}

/**
 * Decide a mode for each segment using a deterministic keyword scan.
 * Pure function, no LLM — used when the LLM output is missing, malformed,
 * or covers only part of the conversation.
 *
 * Rules:
 *  - hit on intent keywords or activated worldbook paths → `full`
 *  - miss but summary present → `summary`
 *  - no summary at all → `drop`
 */
export function fallbackKeywordScan(
  intent: IntentOutput,
  worldbookPaths: readonly string[],
  reader: ContextReader,
): ContextSegment[] {
  const needles: string[] = [
    ...intent.keywords.map(k => k.toLowerCase()),
    // Activated worldbook paths correlate with relevant scenes.
    ...worldbookPaths.map(p => p.toLowerCase()),
  ]

  const segments: ContextSegment[] = []
  for (const conv of reader.listConversations()) {
    const summary = reader.readSummary(conv.id)
    if (!summary) {
      segments.push({ id: conv.id, mode: 'drop' })
      continue
    }
    const haystack = summary.summary.toLowerCase()
    const hit = needles.some(needle => haystack.includes(needle))
    segments.push({ id: conv.id, mode: hit ? 'full' : 'summary' })
  }
  return segments
}

/** Type guard: `declaredMode` is one of the three legal string literals. */
function isLegalMode(value: unknown): value is ContextSegment['mode'] {
  return value === 'full' || value === 'summary' || value === 'drop'
}

export const contextProcessAgent: Agent<ContextProcessInput, ContextSegmentOutput> = {
  name: 'context-process',

  async run(input: ContextProcessInput, ctx: AgentContext): Promise<ContextSegmentOutput> {
    const { intent, worldbookMatches, reader } = input

    // 1. Snapshot the data the LLM needs to see.
    const conversations = reader.listConversations()
    const summaries = reader.listSummaries()
    const worldbookPaths = worldbookMatches.matches.map(m => m.path)

    // 2. Render the system prompt with the current turn's signals.
    const template = await ctx.prompts.load('context-process')
    const systemPrompt = renderTemplate(template, {
      intent: JSON.stringify(intent, null, 2),
      worldbook_paths: JSON.stringify(worldbookPaths),
      conversation_count: String(conversations.length),
      summary_count: String(summaries.length),
    })

    // 3. Ask the LLM to label every segment. Summaries are the cheap signal;
    //    the LLM is not expected to re-read full conversation text.
    const result = await ctx.provider.chat(
      [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content:
            `可用摘要列表(每条: id, summary 前 100 字):\n` +
            summaries
              .map(s => `id=${s.id}: ${s.summary.slice(0, 100)}`)
              .join('\n'),
        },
      ],
      {
        model: ctx.model,
        // Low temperature: this is a classification task, not creative writing.
        temperature: 0.2,
        response_format: { type: 'json_object' },
      },
    )

    // 4. Parse the LLM's response (any failure → empty list).
    const parsed = parseContextSegmentResponse(result.content)
    const declared = new Map<number, ContextSegment['mode']>()
    for (const seg of parsed.segments) {
      if (isLegalMode(seg.mode)) declared.set(seg.id, seg.mode)
    }

    // 5. Always pre-compute the fallback so we can substitute on a per-id basis.
    //    The LLM may have covered only a subset, or used an illegal mode.
    const fallback = fallbackKeywordScan(intent, worldbookPaths, reader)
    const fallbackMap = new Map(fallback.map(s => [s.id, s.mode]))

    // 6. Merge: prefer the LLM's legal value, otherwise take the fallback.
    const finalSegments: ContextSegment[] = conversations.map(conv => {
      const declaredMode = declared.get(conv.id)
      const mode: ContextSegment['mode'] = declaredMode ?? fallbackMap.get(conv.id) ?? 'drop'
      return { id: conv.id, mode }
    })

    return { segments: finalSegments }
  },
}
