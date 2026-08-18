/** Deterministic compilation stages between display-regex text and browser rendering. */

/** One ordered piece of a display-regex result. */
export type CharacterDisplaySegment =
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'html'; readonly source: string }
  | { readonly kind: 'inline-html'; readonly source: string }

/** Non-sensitive evidence about transformations applied before browser rendering. */
export interface CardDisplayDiagnostic {
  readonly code: 'frontend-document' | 'inline-html' | 'legacy-center-normalized' | 'unknown-wrapper-removed'
  readonly count: number
  readonly tags?: readonly string[]
}

/** Segments plus stage diagnostics that never include card prose or markup. */
export interface CompiledCharacterDisplay {
  readonly segments: readonly CharacterDisplaySegment[]
  readonly diagnostics: readonly CardDisplayDiagnostic[]
}

interface SourceLine {
  readonly start: number
  readonly end: number
  readonly text: string
}

interface MutableDiagnostics {
  frontendDocuments: number
  inlineHtml: number
  unknownWrapperCount: number
  readonly unknownWrapperTags: Set<string>
}

const HTML_DISPLAY_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em',
  'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input',
  'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'menu', 'meta',
  'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture',
  'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section',
  'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title',
  'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'use', 'symbol', 'view',
])

function stripUnknownTagsOutsideCode(value: string): {
  readonly text: string
  readonly removedCount: number
  readonly removedTags: readonly string[]
} {
  let result = ''
  let cursor = 0
  let codeTicks = 0
  let removedCount = 0
  const removedTags = new Set<string>()
  while (cursor < value.length) {
    if (value[cursor] === '`') {
      let end = cursor + 1
      while (value[end] === '`') end += 1
      const ticks = end - cursor
      if (codeTicks === 0) codeTicks = ticks
      else if (ticks === codeTicks) codeTicks = 0
      result += value.slice(cursor, end)
      cursor = end
      continue
    }
    if (codeTicks === 0 && value[cursor] === '<') {
      const tag = value.slice(cursor).match(/^<\/?([A-Za-z][A-Za-z0-9:_-]*)(?:\s[^<>]*?)?\s*\/?>/u)
      const name = tag?.[1]?.toLowerCase()
      if (tag?.[0] !== undefined && name !== undefined && !HTML_DISPLAY_TAGS.has(name)) {
        removedCount += 1
        removedTags.add(name)
        cursor += tag[0].length
        continue
      }
    }
    result += value[cursor]
    cursor += 1
  }
  return { text: result, removedCount, removedTags: [...removedTags].sort() }
}

function hasDisplayHtmlOutsideCode(value: string): boolean {
  let cursor = 0
  let codeTicks = 0
  while (cursor < value.length) {
    if (value[cursor] === '`') {
      let end = cursor + 1
      while (value[end] === '`') end += 1
      const ticks = end - cursor
      if (codeTicks === 0) codeTicks = ticks
      else if (ticks === codeTicks) codeTicks = 0
      cursor = end
      continue
    }
    if (codeTicks === 0 && value[cursor] === '<') {
      const tag = value.slice(cursor).match(/^<\/?([A-Za-z][A-Za-z0-9:_-]*)(?:\s[^<>]*?)?\s*\/?>/u)
      const name = tag?.[1]?.toLowerCase()
      if (name !== undefined && HTML_DISPLAY_TAGS.has(name)) return true
    }
    cursor += 1
  }
  return false
}

function sourceLines(value: string): SourceLine[] {
  const lines: SourceLine[] = []
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/gu
  for (const match of value.matchAll(pattern)) {
    const text = match[0]
    const start = match.index
    if (text === '' && start === value.length) break
    lines.push({ start, end: start + text.length, text })
  }
  return lines
}

function normalizeMarkdown(value: string): {
  readonly text: string
  readonly removedCount: number
  readonly removedTags: readonly string[]
} {
  let fence: { readonly marker: string; readonly length: number } | undefined
  let removedCount = 0
  const removedTags = new Set<string>()
  const text = sourceLines(value).map(line => {
    const candidate = line.text.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]
    if (candidate !== undefined) {
      if (fence === undefined) {
        fence = { marker: candidate[0] ?? '', length: candidate.length }
      } else if (candidate[0] === fence.marker && candidate.length >= fence.length
        && /^ {0,3}(`{3,}|~{3,})[ \t]*(?:\r\n|\r|\n|$)$/u.test(line.text)) {
        fence = undefined
      }
      return line.text
    }
    if (fence !== undefined) return line.text
    const stripped = stripUnknownTagsOutsideCode(line.text)
    removedCount += stripped.removedCount
    stripped.removedTags.forEach(tag => { removedTags.add(tag) })
    return stripped.text
  }).join('')
  return { text, removedCount, removedTags: [...removedTags].sort() }
}

/** Match SillyTavern Markdown display for model-defined wrapper elements. */
export function normalizeSillyTavernMarkdown(value: string): string {
  return normalizeMarkdown(value).text
}

function isFrontendDocument(info: string, source: string): boolean {
  const completeDocument = /<!doctype\s+html\b|<html(?:\s|>)/iu.test(source)
    && /<\/html\s*>/iu.test(source)
  if (completeDocument) return true
  const language = info.trim().split(/\s+/u)[0]?.toLowerCase()
  if (language !== undefined && language !== '') return language === 'html'
  return /<!doctype\s+html\b|<html(?:\s|>)|<(?:head|body|style|script|link|div|section|article|main|header|footer|nav|aside|details|summary|table|form|button|canvas|svg|h[1-6])(?:\s|>)/iu.test(source)
}

function isFrontendFragment(source: string): boolean {
  const trimmed = source.trimStart()
  return /^(?:<!doctype\s+html\b|<html(?:\s|>)|<(?:head|body|style|script|link|div|section|article|main|header|footer|nav|aside|details|summary|table|form|button|canvas|svg|h[1-6])(?:\s|>))/iu.test(trimmed)
}

function appendMarkdown(
  segments: CharacterDisplaySegment[],
  diagnostics: MutableDiagnostics,
  text: string,
): void {
  if (isFrontendDocument('', text)) {
    diagnostics.frontendDocuments += 1
    segments.push({ kind: 'html', source: text })
    return
  }
  const normalized = normalizeMarkdown(text)
  diagnostics.unknownWrapperCount += normalized.removedCount
  normalized.removedTags.forEach(tag => { diagnostics.unknownWrapperTags.add(tag) })
  if (normalized.text === '') return
  // A fragment containing scripts or a style sheet is still a card frontend,
  // even when it is not a full <html> document. It must use the isolated
  // renderer; treating it as ordinary inline HTML would discard its script
  // and make the reference HUD appear as broken source text.
  if (isFrontendFragment(normalized.text) || /<(?:style|script)(?:\s|>)/iu.test(normalized.text)) {
    diagnostics.frontendDocuments += 1
    segments.push({ kind: 'html', source: normalized.text })
    return
  }
  if (hasDisplayHtmlOutsideCode(normalized.text)) {
    diagnostics.inlineHtml += 1
    segments.push({ kind: 'inline-html', source: normalized.text })
    return
  }
  const previous = segments.at(-1)
  if (previous?.kind === 'markdown') {
    segments[segments.length - 1] = { kind: 'markdown', text: previous.text + normalized.text }
    return
  }
  segments.push({ kind: 'markdown', text: normalized.text })
}

/** Compile display output into ordered native-Markdown and isolated-HTML segments. */
export function compileCharacterDisplay(value: string): CompiledCharacterDisplay {
  const lines = sourceLines(value)
  const segments: CharacterDisplaySegment[] = []
  const state: MutableDiagnostics = {
    frontendDocuments: 0,
    inlineHtml: 0,
    unknownWrapperCount: 0,
    unknownWrapperTags: new Set(),
  }
  let cursor = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    const opening = line.text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*?)[ \t]*(?:\r\n|\r|\n|$)$/u)
    if (opening === null) continue
    const marker = opening[1]
    if (marker === undefined) continue
    let closingIndex: number | undefined
    for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
      const closing = lines[candidate]?.text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*(?:\r\n|\r|\n|$)$/u)
      const closingMarker = closing?.[1]
      if (closingMarker !== undefined && closingMarker[0] === marker[0] && closingMarker.length >= marker.length) {
        closingIndex = candidate
        break
      }
    }
    if (closingIndex === undefined) break
    const closing = lines[closingIndex]
    if (closing === undefined) break
    const source = value.slice(line.end, closing.start)
    if (isFrontendDocument(opening[2] ?? '', source)) {
      appendMarkdown(segments, state, value.slice(cursor, line.start))
      segments.push({ kind: 'html', source })
      state.frontendDocuments += 1
      cursor = closing.end
    }
    index = closingIndex
  }
  appendMarkdown(segments, state, value.slice(cursor))
  const diagnostics: CardDisplayDiagnostic[] = [
    ...(state.frontendDocuments === 0 ? [] : [{ code: 'frontend-document' as const, count: state.frontendDocuments }]),
    ...(state.inlineHtml === 0 ? [] : [{ code: 'inline-html' as const, count: state.inlineHtml }]),
    ...(state.unknownWrapperCount === 0 ? [] : [{
      code: 'unknown-wrapper-removed' as const,
      count: state.unknownWrapperCount,
      tags: [...state.unknownWrapperTags].sort(),
    }]),
  ]
  return { segments, diagnostics }
}

/** Preserve the old block-centering intent using sanitizer-safe HTML. */
export function normalizeLegacyCardHtml(source: string): {
  readonly source: string
  readonly diagnostics: readonly CardDisplayDiagnostic[]
} {
  const count = [...source.matchAll(/<center(?:\s[^>]*)?>/giu)].length
  if (count === 0) return { source, diagnostics: [] }
  return {
    source: source
      .replace(/<center(\s[^>]*)?>/giu, '<div data-agent-rp-center$1>')
      .replace(/<\/center\s*>/giu, '</div>'),
    diagnostics: [{ code: 'legacy-center-normalized', count }],
  }
}

/** Split display output while retaining the historical array-only API. */
export function splitCharacterDisplay(value: string): CharacterDisplaySegment[] {
  return [...compileCharacterDisplay(value).segments]
}

/** Whether compiled output needs the isolated character frontend renderer. */
export function hasCharacterDisplayFrontend(segments: readonly CharacterDisplaySegment[]): boolean {
  return segments.some(segment => segment.kind !== 'markdown')
}
