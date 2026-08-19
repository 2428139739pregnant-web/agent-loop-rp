/** User-facing controls for the final response stage.
 *
 * SillyTavern presets express these controls as optional system prompts. The
 * harness keeps them as typed runtime settings so the UI can change them
 * without rewriting a character card or a prompt preset.
 */

/** IDs are stable storage keys; the visible name and prompt are editable. */
export type ResponsePerspective = string
export type ResponseLengthPreset = 'card' | 'short' | 'medium' | 'long' | 'custom'

export interface ResponsePerspectiveOption {
  readonly id: string
  readonly name: string
  /** The exact instruction appended to the response-agent system prompt. */
  readonly instruction: string
}

export interface ResponseGenerationSettings {
  readonly perspective: ResponsePerspective
  readonly perspectives: readonly ResponsePerspectiveOption[]
  readonly lengthPreset: ResponseLengthPreset
  /** Inclusive target range in Chinese characters; ignored when preset=card. */
  readonly minChars: number
  readonly maxChars: number
}

export const RESPONSE_LENGTH_RANGES: Readonly<Record<Exclude<ResponseLengthPreset, 'card' | 'custom'>, { minChars: number; maxChars: number }>> = {
  short: { minChars: 200, maxChars: 500 },
  medium: { minChars: 500, maxChars: 900 },
  long: { minChars: 1000, maxChars: 1800 },
}

export const DEFAULT_RESPONSE_PERSPECTIVES: readonly ResponsePerspectiveOption[] = [
  {
    id: 'card',
    name: '跟随角色卡',
    instruction: '',
  },
  {
    id: 'first',
    name: '第一人称',
    instruction: '采用第一人称；用户扮演的角色使用“我”自称，只写该角色可知的感受与所见。',
  },
  {
    id: 'second',
    name: '第二人称',
    instruction: '采用第二人称沉浸视角，使用“你”指代用户扮演的角色，通过其感官营造在场感。',
  },
  {
    id: 'third',
    name: '第三人称有限',
    instruction: '采用第三人称有限视角，以用户角色的名字为主、他/她为辅；只写用户角色亲眼所见、亲耳所闻和亲身所感。',
  },
  {
    id: 'group',
    name: '第三人称群像',
    instruction: '采用第三人称群像视角；允许在相关角色之间自然切换，但保持叙事清晰，不替用户角色做未授权的关键决定。',
  },
]

export const DEFAULT_RESPONSE_SETTINGS: ResponseGenerationSettings = {
  perspective: 'card',
  perspectives: DEFAULT_RESPONSE_PERSPECTIVES,
  lengthPreset: 'card',
  minChars: RESPONSE_LENGTH_RANGES.medium.minChars,
  maxChars: RESPONSE_LENGTH_RANGES.medium.maxChars,
}

const LENGTH_PRESETS: readonly ResponseLengthPreset[] = ['card', 'short', 'medium', 'long', 'custom']
const RESPONSE_OPTION_ID = /^[a-z][a-z0-9_-]{0,63}$/u

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : fallback
}

function cleanPerspectiveOptions(value: unknown, fallback: readonly ResponsePerspectiveOption[]): ResponsePerspectiveOption[] {
  const candidates = Array.isArray(value) ? value : fallback
  const options: ResponsePerspectiveOption[] = []
  const ids = new Set<string>()
  for (const item of candidates) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const source = item as Record<string, unknown>
    const id = typeof source.id === 'string' ? source.id.trim().toLowerCase() : ''
    if (!RESPONSE_OPTION_ID.test(id) || ids.has(id)) continue
    const fallbackOption = fallback.find((option) => option.id === id)
    const rawName = typeof source.name === 'string' ? source.name.trim() : ''
    const rawInstruction = typeof source.instruction === 'string' ? source.instruction.trim() : ''
    options.push({
      id,
      name: (rawName || fallbackOption?.name || id).slice(0, 80),
      instruction: (rawInstruction || fallbackOption?.instruction || '').slice(0, 20_000),
    })
    ids.add(id)
  }
  // Keep a harmless escape hatch even if a hand-edited file removes every
  // option. The user can still add/remove all other options in the UI.
  if (!ids.has('card')) {
    const card = fallback.find((option) => option.id === 'card') ?? DEFAULT_RESPONSE_PERSPECTIVES[0]!
    options.unshift(card)
  }
  return options
}

/** Normalize persisted/API data and keep old or hand-edited files harmless. */
export function normalizeResponseSettings(
  value: unknown,
  fallback: ResponseGenerationSettings = DEFAULT_RESPONSE_SETTINGS,
): ResponseGenerationSettings {
  const source = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const fallbackPerspectives = cleanPerspectiveOptions(fallback.perspectives, DEFAULT_RESPONSE_PERSPECTIVES)
  const perspectives = cleanPerspectiveOptions(source.perspectives, fallbackPerspectives)
  const requestedPerspective = typeof source.perspective === 'string'
    ? source.perspective.trim().toLowerCase()
    : ''
  const fallbackPerspective = perspectives.some((option) => option.id === fallback.perspective)
    ? fallback.perspective
    : 'card'
  const perspective = perspectives.some((option) => option.id === requestedPerspective)
    ? requestedPerspective
    : fallbackPerspective
  const lengthPreset = LENGTH_PRESETS.includes(source.lengthPreset as ResponseLengthPreset)
    ? source.lengthPreset as ResponseLengthPreset
    : fallback.lengthPreset
  const minChars = boundedInteger(source.minChars, fallback.minChars, 20, 20_000)
  const rawMaxChars = boundedInteger(source.maxChars, fallback.maxChars, 20, 20_000)
  const maxChars = Math.max(minChars, rawMaxChars)
  return { perspective, perspectives, lengthPreset, minChars, maxChars }
}

/** Build the compact instruction equivalent to ST's enabled POV/length blocks. */
export function buildResponseSettingsInstruction(settings: ResponseGenerationSettings): string {
  const selected = settings.perspectives.find((option) => option.id === settings.perspective)
    ?? settings.perspectives.find((option) => option.id === 'card')
    ?? DEFAULT_RESPONSE_PERSPECTIVES[0]!
  const perspective = selected.instruction
    ? `人称视角（${selected.name}）：\n${selected.instruction}`
    : '人称视角：跟随角色卡和当前文风，不额外强制人称。'
  const length = settings.lengthPreset === 'card'
    ? '正文长度：跟随角色卡和当前文风，不额外强制字数。'
    : `正文长度：控制在 ${settings.minChars}-${settings.maxChars} 字左右（中文字符和标点计入；不把思维链、状态栏、HTML/CSS 或机器标记计入正文长度）。`
  return `${perspective}\n${length}`
}

/** Provider-side safety cap; the prompt remains the source of the soft range. */
export function responseMaxTokens(settings: ResponseGenerationSettings): number | undefined {
  if (settings.lengthPreset === 'card') return undefined
  // Chinese prose is commonly close to one token per character, while HTML,
  // punctuation and markdown can cost more. Leave a small formatting margin.
  return Math.min(12_000, Math.max(256, Math.ceil(settings.maxChars * 22 / 10)))
}
