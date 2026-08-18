/** Pure, non-LLM merge of worldbook activation candidates. */

import type { WorldbookMatch, WorldbookMatchOutput } from './schema.ts'

export type WorldbookActivationSource = 'st' | 'agent' | 'plugin' | 'st+agent'

export interface WorldbookResolverInput {
  readonly st?: WorldbookMatchOutput
  readonly agent?: WorldbookMatchOutput
  readonly plugin?: WorldbookMatchOutput
}

function withSource(
  match: WorldbookMatch,
  source: WorldbookActivationSource,
): WorldbookMatch {
  return { ...match, source }
}

/**
 * Merge activation results by stable entry path.
 *
 * ST/plugin results are authoritative for entries they own. If the agent
 * independently selects an ST baseline entry, it is retained once and marked
 * `st+agent` for traceability. This function never calls a provider.
 */
export function resolveWorldbookMatches(input: WorldbookResolverInput): WorldbookMatchOutput {
  const merged = new Map<string, WorldbookMatch>()
  const sourceOrder: readonly [WorldbookActivationSource, WorldbookMatchOutput | undefined][] = [
    ['st', input.st],
    ['plugin', input.plugin],
    ['agent', input.agent],
  ]

  for (const [source, output] of sourceOrder) {
    for (const match of output?.matches ?? []) {
      const previous = merged.get(match.path)
      if (previous === undefined) {
        merged.set(match.path, withSource(match, source))
        continue
      }
      const previousSource = previous.source
      const combinedSource: WorldbookActivationSource =
        previousSource === 'st' && source === 'agent' ? 'st+agent'
          : previousSource === 'agent' && source === 'st' ? 'st+agent'
            : previousSource === 'plugin' ? 'plugin'
              : previousSource ?? source
      merged.set(match.path, { ...previous, source: combinedSource })
    }
  }

  const matches = [...merged.values()]
    .sort((a, b) => a.order - b.order || b.weight - a.weight || a.path.localeCompare(b.path))
  // Special-entry plans are already deterministic artifacts. Preserve the
  // explicit plugin lane while resolving ordinary match duplicates; no model
  // output is allowed to overwrite this plan.
  const plugin = input.plugin?.plugin ?? input.st?.plugin ?? input.agent?.plugin
  return plugin === undefined ? { matches } : { matches, plugin }
}
