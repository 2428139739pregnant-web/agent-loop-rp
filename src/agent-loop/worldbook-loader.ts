/** Worldbook directory loader: parses `_index.md` and reads the referenced entry files. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryWorldbookStore } from './session.ts'
import type { WorldbookEntry, WorldbookStore } from './session.ts'

/** One row in `_index.md`. `order` / `weight` may be blank. */
export interface WorldbookIndexEntry {
  keywords: string[]
  path: string
  order: number | null
  weight: number | null
}

const SEPARATOR_PATTERN = /^[-:\s]+$/u

/** Parse a `_index.md` table body. The header + separator rows are skipped. */
export function parseWorldbookIndex(content: string): WorldbookIndexEntry[] {
  const lines = content.split(/\r?\n/u)
  const entries: WorldbookIndexEntry[] = []
  let sawHeader = false

  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length < 4) continue

    if (cells.every(c => SEPARATOR_PATTERN.test(c))) continue

    if (!sawHeader) {
      sawHeader = true
      continue
    }

    const keywordCell = cells[0] ?? ''
    const pathCell = cells[1] ?? ''
    const orderCell = cells[2] ?? ''
    const weightCell = cells[3] ?? ''

    if (pathCell.length === 0) continue

    const keywords = keywordCell
      .split(/[,，]/u)
      .map(k => k.trim())
      .filter(k => k.length > 0)

    const order = parseIntegerOrNull(orderCell)
    const weight = parseIntegerOrNull(weightCell)

    entries.push({ keywords, path: pathCell, order, weight })
  }

  return entries
}

function parseIntegerOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/** Convert an index entry + its file body into a fully-populated `WorldbookEntry`. */
function toWorldbookEntry(indexEntry: WorldbookIndexEntry, content: string): WorldbookEntry {
  return {
    keywords: indexEntry.keywords,
    path: indexEntry.path,
    order: indexEntry.order ?? 0,
    weight: indexEntry.weight ?? 0,
    content,
  }
}

/**
 * Load a worldbook directory (containing `_index.md` plus referenced `.md` files)
 * and return a ready-to-use `WorldbookStore`. The returned store is in-memory;
 * persist the parsed entries elsewhere if you need cross-process state.
 */
export async function loadWorldbookFromDir(dir: string): Promise<WorldbookStore> {
  const indexPath = join(dir, '_index.md')
  const indexContent = await readFile(indexPath, 'utf-8')
  const indexEntries = parseWorldbookIndex(indexContent)
  const entries: WorldbookEntry[] = []

  for (const indexEntry of indexEntries) {
    const filePath = join(dir, indexEntry.path)
    const content = await readFile(filePath, 'utf-8')
    entries.push(toWorldbookEntry(indexEntry, content))
  }

  return new MemoryWorldbookStore(entries)
}
