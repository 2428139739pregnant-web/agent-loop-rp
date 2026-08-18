/** Agent ① — Intent recognition.
 *
 * Takes one raw user turn and returns a structured {@link IntentOutput}
 * (user narration, meta commands, involved characters, worldbook keywords).
 * Sits at the very front of the agent-loop pipeline; everything downstream
 * (worldbook match, context segmentation, reply) consumes its output.
 */

import { IntentOutputSchema, type IntentOutput } from '../schema.ts'
import type { Agent, AgentContext } from './types.ts'

/** Matches a fenced markdown block: ```json\n{...}\n``` or ```{...}``` */
const FENCED_JSON_RE = /```(?:json)?\s*([\s\S]+?)\s*```/

/** Greedy match for the first balanced-ish `{ ... }` substring.
 *  Used as a last-resort extraction when the model wraps the JSON with prose. */
const FIRST_OBJECT_RE = /\{[\s\S]*\}/

/** A complete `*...*` segment is user-side action/instruction/settings text. */
const STAR_MARKED_SEGMENT_RE = /\*([^*]*)\*/g

/**
 * Enforce the user's star-marker convention after the LLM response is parsed.
 *
 * Text outside complete `*...*` pairs is spoken narration. Text inside pairs is
 * always a meta command (actions, instructions, settings, etc.). This is kept
 * deterministic instead of trusting the model to preserve the boundary.
 */
export function applyStarMarkerSemantics(sourceInput: string, parsed: IntentOutput): IntentOutput {
  const spokenParts: string[] = []
  const markedCommands: string[] = []
  let cursor = 0
  let sawMarker = false

  for (const match of sourceInput.matchAll(STAR_MARKED_SEGMENT_RE)) {
    const start = match.index ?? cursor
    spokenParts.push(sourceInput.slice(cursor, start))
    const command = match[1]?.trim() ?? ''
    if (command.length > 0) markedCommands.push(command)
    cursor = start + match[0].length
    sawMarker = true
  }

  if (!sawMarker) {
    return { ...parsed, userNarration: sourceInput.trim(), metaCommands: [] }
  }

  spokenParts.push(sourceInput.slice(cursor))
  return {
    ...parsed,
    userNarration: spokenParts.join('').trim(),
    metaCommands: markedCommands,
  }
}

/**
 * Parse the model's raw response into a validated {@link IntentOutput}.
 *
 * Fallback ladder (each step is independent — a failure moves on):
 *  1. `JSON.parse` the whole string as-is.
 *  2. Extract the body of the first ```` ```json ... ``` ```` code block.
 *  3. Grab the first `{...}` substring (handles "Here you go: {...}" prose).
 *  4. Give up and return the empty/default schema so downstream agents can
 *     still run with blanks rather than crashing the whole pipeline.
 *
 * Never throws. The empty schema has every field defaulted by
 * `IntentOutputSchema`.
 */
export function parseIntentResponse(raw: string): IntentOutput {
  const candidates: string[] = [raw]

  const fenced = FENCED_JSON_RE.exec(raw)
  if (fenced && fenced[1] !== undefined) candidates.push(fenced[1])

  const first = FIRST_OBJECT_RE.exec(raw)
  if (first && first[0] !== undefined) candidates.push(first[0])

  for (const candidate of candidates) {
    try {
      // JSON.parse returns `any`, which fits the schemastery input slot.
      return IntentOutputSchema(JSON.parse(candidate))
    } catch {
      // Try the next candidate.
    }
  }

  // Last resort: feed `{}` through the schema so all field-level `.default()`
  // values fill in. `JSON.parse('{}')` returns `any`, which the schemastery
  // input slot accepts without a cast.
  return IntentOutputSchema(JSON.parse('{}'))
}

export const intentAgent: Agent<string, IntentOutput> = {
  name: 'intent',

  async run(userInput: string, ctx: AgentContext): Promise<IntentOutput> {
    const systemPrompt = await ctx.prompts.load('intent')

    const result = await ctx.provider.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userInput },
      ],
      {
        model: ctx.model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      },
    )

    return applyStarMarkerSemantics(userInput, parseIntentResponse(result.content))
  },
}
