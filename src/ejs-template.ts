/** Isolated, deterministic rendering for the supported SillyTavern EJS subset. */

import variant from '@jitl/quickjs-singlefile-mjs-release-sync'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core'
import type {
  LorebookRegexEngine,
  LorebookRegexMatcher,
  LorebookRegexMatchResult,
} from './import/lorebook.ts'

const MAX_TEMPLATE_CHARS = 256 * 1024
const MAX_OUTPUT_CHARS = 256 * 1024
const MAX_RESOURCE_CHARS = 4 * 1024 * 1024
const MAX_RESOURCE_DEPTH = 4
const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024
const MAX_STACK_BYTES = 512 * 1024
const MAX_INTERRUPT_POLLS = 512
const MAX_PENDING_JOBS = 1_024
const MAX_RENDERER_EVALUATIONS = 256
const MAX_REGEX_PATTERN_CHARS = 16 * 1024
const MAX_REGEX_INPUT_CHARS = 512 * 1024
const MAX_REGEX_EVALUATIONS = 4_096
const MAX_REGEX_PATTERN_CHARS_PER_MATCHER = 2 * 1024 * 1024
const MAX_REGEX_INTERRUPT_POLLS = 64

let quickjsModule: Promise<QuickJSWASMModule> | undefined

/** One role-preserving visible Session message exposed to a template. */
export interface EjsTemplateMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** One Session-owned World Info book available to deterministic template reads. */
export interface EjsTemplateWorldInfoBook {
  readonly id: string
  readonly name?: string
  readonly entries: readonly {
    readonly sourceId: string
    readonly name?: string
    readonly comment?: string
    readonly content: string
  }[]
}

/** One JSON-only character-card snapshot available to deterministic reads. */
export interface EjsTemplateCharacterResource {
  readonly id: string
  readonly name?: string
  readonly data: JsonValue
}

/** One JSON-only preset prompt snapshot available to deterministic reads. */
export interface EjsTemplatePresetPromptResource {
  readonly id?: string
  readonly name: string
  readonly content: string
  readonly data?: JsonValue
}

/**
 * Per-generation prompt-template injection store.
 *
 * ST-Prompt-Template keeps these values in memory while the prompt is being
 * assembled: a World Info entry can call injectPrompt('key', content), and a
 * later preset/EJS block can read it with getPromptsInjected('key').  Keeping
 * the store outside QuickJS lets nested template renders share the same
 * values without exposing host objects to the sandbox.
 */
export interface EjsTemplatePromptInjectionStore {
  inject(key: string, prompt: string, order?: number, sticky?: number, uid?: string): void
  get(key: string, postprocess?: unknown): string
  has(key: string): boolean
}

interface StoredPromptInjection {
  readonly key: string
  readonly prompt: string
  readonly order: number
  readonly sticky: number
  readonly uid: string
  readonly sequence: number
}

const MAX_PROMPT_INJECTION_KEY_CHARS = 256
const MAX_PROMPT_INJECTION_CHARS = 256 * 1024
const MAX_PROMPT_INJECTIONS = 512

function injectionText(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '')
}

function applyPromptInjectionPostprocess(value: string, postprocess: unknown): string {
  if (!Array.isArray(postprocess)) return value
  let result = value
  for (const item of postprocess) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const search = record.search
    const replace = record.replace
    if (typeof search !== 'string' || typeof replace !== 'string' || search === '') continue
    result = result.replaceAll(search, replace)
  }
  return result
}

/** Create the bounded store shared by one prompt-generation/render pass. */
export function createEjsTemplatePromptInjectionStore(): EjsTemplatePromptInjectionStore {
  const entries: StoredPromptInjection[] = []
  let sequence = 0
  return {
    inject(key, prompt, order = 100, sticky = 0, uid = '') {
      const normalizedKey = injectionText(key).trim()
      if (normalizedKey === '' || normalizedKey.length > MAX_PROMPT_INJECTION_KEY_CHARS) return
      const normalizedPrompt = injectionText(prompt)
      if (normalizedPrompt.length > MAX_PROMPT_INJECTION_CHARS) return
      const normalizedOrder = Number.isFinite(order) ? Math.trunc(order) : 100
      const normalizedSticky = Number.isFinite(sticky) ? Math.max(0, Math.trunc(sticky)) : 0
      const normalizedUid = injectionText(uid)
      // The official uid form updates an existing injection. Calls without a
      // uid remain independent entries and are joined in order, matching the
      // extension's grouped injection behavior.
      if (normalizedUid !== '') {
        const existing = entries.findIndex(item => item.key === normalizedKey && item.uid === normalizedUid)
        if (existing >= 0) {
          entries[existing] = {
            key: normalizedKey,
            prompt: normalizedPrompt,
            order: normalizedOrder,
            sticky: normalizedSticky,
            uid: normalizedUid,
            sequence: entries[existing]!.sequence,
          }
          return
        }
      }
      if (entries.length >= MAX_PROMPT_INJECTIONS) return
      entries.push({
        key: normalizedKey,
        prompt: normalizedPrompt,
        order: normalizedOrder,
        sticky: normalizedSticky,
        uid: normalizedUid,
        sequence: sequence++,
      })
    },
    get(key, postprocess) {
      const normalizedKey = injectionText(key).trim()
      const combined = entries
        .filter(item => item.key === normalizedKey)
        .sort((left, right) => left.order - right.order || left.sequence - right.sequence)
        .map(item => item.prompt)
        .join('\n')
      return applyPromptInjectionPostprocess(combined, postprocess)
    },
    has(key) {
      const normalizedKey = injectionText(key).trim()
      return entries.some(item => item.key === normalizedKey)
    },
  }
}

/** Project normalized Session lorebooks into the read-only EJS resource index. */
export function createEjsWorldInfoBooks(books: readonly {
  readonly id: string
  readonly name?: string
  readonly lorebook: {
    readonly entries: readonly {
      readonly sourceId: string
      readonly name?: string
      readonly comment?: string
      readonly content: string
    }[]
  }
}[]): EjsTemplateWorldInfoBook[] {
  return books.map(book => ({
    id: book.id,
    ...(book.name === undefined ? {} : { name: book.name }),
    entries: book.lorebook.entries.map(entry => ({
      sourceId: entry.sourceId,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(entry.comment === undefined ? {} : { comment: entry.comment }),
      content: entry.content,
    })),
  }))
}

/** Resource identity of the template currently being rendered. */
export interface EjsTemplateTarget {
  readonly worldInfoBookId?: string
  /** ST-Prompt-Template phase; omitted targets are model-generation renders. */
  readonly runType?: EjsTemplateRunType
  /** ST-Prompt-Template context for one [GENERATE:REGEX:*] hit. */
  readonly matchedMessage?: string
  readonly matchedMessageIndex?: number
  readonly matchedMessageRole?: 'system' | 'user' | 'assistant' | 'tool'
}

/** Phases named by ST-Prompt-Template's model-side EJS environment. */
export type EjsTemplateRunType = 'generate' | 'preparation' | 'render' | 'render_permanent'

/** JSON-only values exposed to one template evaluation. */
export interface EjsTemplateContext {
  readonly characterName: string
  readonly userName: string
  readonly messages: readonly string[]
  readonly transcript?: readonly EjsTemplateMessage[]
  readonly variables?: Readonly<Record<string, JsonValue>>
  readonly variableScopes?: Readonly<Partial<Record<'global' | 'preset' | 'character' | 'chat' | 'message' | 'initial', Readonly<Record<string, JsonValue>>>>>
  readonly statData?: JsonValue
  readonly worldInfoBooks?: readonly EjsTemplateWorldInfoBook[]
  /** Optional active card JSON snapshot used when no named card list is supplied. */
  readonly characterData?: JsonValue
  /** Optional active/known character-card JSON snapshots. */
  readonly characterCards?: readonly EjsTemplateCharacterResource[]
  /** Optional preset prompt snapshots; contents are rendered in the same sandbox. */
  readonly presetPrompts?: readonly EjsTemplatePresetPromptResource[]
  /** Prompt Template's per-generation dependency-injection store. */
  readonly promptInjections?: EjsTemplatePromptInjectionStore
  /** Internal JSON-only locals used while formatting a character or preset resource. */
  readonly templateData?: Readonly<Record<string, JsonValue>>
}

/** Stable failure categories that never include private template source. */
export type EjsTemplateFailureKind =
  | 'source-limit'
  | 'syntax-error'
  | 'runtime-error'
  | 'execution-limit'
  | 'memory-limit'
  | 'output-limit'
  | 'resource-unsupported'
  | 'resource-limit'

/** Result of one isolated template evaluation. */
export type EjsTemplateResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly kind: EjsTemplateFailureKind }

interface TemplateSegment {
  readonly kind: 'text' | 'code' | 'escaped' | 'raw'
  readonly value: string
}

// This is the default format documented by ST-Prompt-Template. It is kept as
// data rather than executed by the host, so custom character formats remain
// inside the same QuickJS boundary as ordinary model-side templates.
const DEFAULT_CHARACTER_TEMPLATE = `<% if (name) { %>
<<%- name %>>
<% if (system_prompt) { %>
System: <%- system_prompt %>
<% } %>
name: <%- name %>
<% if (personality) { %>
personality: <%- personality %>
<% } %>
<% if (description) { %>
description: <%- description %>
<% } %>
<% if (message_example) { %>
example:
<%- message_example %>
<% } %>
<% if (depth_prompt) { %>
System: <%- depth_prompt %>
<% } %>
</<%- name %>>
<% } %>`

const TEMPLATE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
const TEMPLATE_RESERVED_LOCALS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield',
  'char', 'user', 'charName', 'userName', 'runType', 'messages', 'variables', 'variableScopes',
  'stat_data', 'getvar', 'getWorldInfo', 'getwi', 'getCharData', 'getchar', 'getChara',
  'getpreset', 'getPresetPrompt', 'getChatMessage', 'getChatMessages', 'print', 'YAML', '_',
  'injectPrompt', 'getPromptsInjected', 'hasPromptsInjected',
  '__input', '__output', '__append', '__escape', '__transcript', '__templateData',
])
const TEMPLATE_RESOURCE_LOCALS = [
  'name', 'system_prompt', 'personality', 'description', 'scenario', 'first_message',
  'message_example', 'creatorcomment', 'alternate_greetings', 'depth_prompt',
] as const
const TEMPLATE_RESOURCE_LOCAL_SET = new Set<string>(TEMPLATE_RESOURCE_LOCALS)

function templateLocalDeclarations(context: EjsTemplateContext): string {
  const data = context.templateData
  if (data === undefined) return ''
  const standard = TEMPLATE_RESOURCE_LOCALS
    .map(key => `const ${key} = __templateData[${JSON.stringify(key)}];`)
  const dynamic = Object.keys(data)
    .filter(key => TEMPLATE_IDENTIFIER.test(key)
      && !TEMPLATE_RESERVED_LOCALS.has(key)
      && !TEMPLATE_RESOURCE_LOCAL_SET.has(key))
    .map(key => `const ${key} = __templateData[${JSON.stringify(key)}];`)
  return [...standard, ...dynamic].join('\n    ')
}

function segments(template: string): TemplateSegment[] | undefined {
  const result: TemplateSegment[] = []
  const literalClosings = (value: string) => value.replaceAll('%%>', '%>')
  let cursor = 0
  let trimLeadingWhitespace = false
  while (cursor < template.length) {
    const opening = template.indexOf('<%', cursor)
    if (opening < 0) {
      const tail = literalClosings(trimLeadingWhitespace ? template.slice(cursor).replace(/^\s+/u, '') : template.slice(cursor))
      if (tail !== '') result.push({ kind: 'text', value: tail })
      return result
    }
    let text = template.slice(cursor, opening)
    if (trimLeadingWhitespace) text = text.replace(/^\s+/u, '')
    const marker = template[opening + 2]
    if (marker === '%') {
      if (text !== '') result.push({ kind: 'text', value: literalClosings(text) })
      result.push({ kind: 'text', value: '<%' })
      cursor = opening + 3
      trimLeadingWhitespace = false
      continue
    }
    const trimBefore = marker === '_'
    if (trimBefore) text = text.replace(/\s+$/u, '')
    if (text !== '') result.push({ kind: 'text', value: literalClosings(text) })

    const contentStart = opening + (marker === '=' || marker === '-' || marker === '#' || marker === '_' ? 3 : 2)
    const closing = template.indexOf('%>', contentStart)
    if (closing < 0) return undefined
    const closeMarker = template[closing - 1]
    const contentEnd = closeMarker === '-' || closeMarker === '_' ? closing - 1 : closing
    const value = template.slice(contentStart, contentEnd)
    if (marker !== '#') {
      result.push({
        kind: marker === '=' ? 'escaped' : marker === '-' ? 'raw' : 'code',
        value,
      })
    }
    cursor = closing + 2
    if (closeMarker === '_') {
      trimLeadingWhitespace = true
    } else {
      trimLeadingWhitespace = false
      if (closeMarker === '-') {
        if (template.startsWith('\r\n', cursor)) cursor += 2
        else if (template[cursor] === '\n' || template[cursor] === '\r') cursor += 1
      }
    }
  }
  return result
}

function compileTemplate(
  template: string,
  context: EjsTemplateContext,
  target: EjsTemplateTarget = {},
): string | undefined {
  const parsed = segments(template)
  if (parsed === undefined) return undefined
  const transcript = context.transcript ?? []
  const transcriptIsMessagePrefix = transcript.length <= context.messages.length
    && transcript.every((message, index) => message.content === context.messages[index])
  const input = JSON.stringify({
    char: context.characterName,
    user: context.userName,
    messages: transcriptIsMessagePrefix ? context.messages.slice(transcript.length) : context.messages,
    transcript,
    transcriptIsMessagePrefix,
    variables: context.variables ?? {},
    scopes: context.variableScopes ?? {},
    ...(context.statData === undefined ? {} : { stat_data: context.statData }),
    ...(context.templateData === undefined ? {} : { template_data: context.templateData }),
    ...(target.matchedMessage === undefined ? {} : { matched_message: target.matchedMessage }),
    ...(target.matchedMessageIndex === undefined ? {} : { matched_message_index: target.matchedMessageIndex }),
    ...(target.matchedMessageRole === undefined ? {} : { matched_message_role: target.matchedMessageRole }),
    run_type: target.runType ?? 'generate',
  })
  const statements = parsed.map(segment => {
    if (segment.kind === 'text') return `__append(${JSON.stringify(segment.value)});`
    if (segment.kind === 'escaped') return `__append(__escape((${segment.value})));`
    if (segment.kind === 'raw') return `__append((${segment.value}));`
    return segment.value
  }).join('\n')
  return `(async () => {
    'use strict';
    const __input = JSON.parse(${JSON.stringify(input)});
    let __output = '';
    const __append = value => {
      if (value === undefined || value === null) return;
      __output += String(value);
      if (__output.length > ${MAX_OUTPUT_CHARS}) throw new Error('__AGENT_RP_EJS_OUTPUT_LIMIT__');
    };
    const __escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;',
    })[character]);
    const __templateData = __input.template_data ?? Object.create(null);
    ${templateLocalDeclarations(context)}
    const __owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
    const char = __input.char;
    const user = __input.user;
    const charName = char;
    const userName = user;
    // ST-Prompt-Template exposes these variables while rendering each
    // [GENERATE:REGEX:*] match. They intentionally remain undefined for the
    // ordinary single-pass template path.
    const matched_message = __input.matched_message;
    const matched_message_index = __input.matched_message_index;
    const matched_message_role = __input.matched_message_role;
    const runType = __input.run_type;
    const __transcript = __input.transcript;
    const messages = __input.transcriptIsMessagePrefix
      ? [...__transcript.map(message => message.content), ...__input.messages]
      : __input.messages;
    const __normalizeMessageId = value => {
      const id = Number(value);
      if (!Number.isSafeInteger(id)) return -1;
      return id < 0 ? __transcript.length + id : id;
    };
    const __messageRole = value => value === 'system' || value === 'user' || value === 'assistant' ? value : undefined;
    const getChatMessage = (id, role = undefined) => {
      const index = __normalizeMessageId(id);
      const message = index < 0 || index >= __transcript.length ? undefined : __transcript[index];
      const selectedRole = __messageRole(role);
      if (message === undefined || (role !== undefined && selectedRole === undefined) || (selectedRole !== undefined && message.role !== selectedRole)) return '';
      return message.content;
    };
    const getChatMessages = (first, second = undefined, third = undefined) => {
      if (typeof second !== 'number') {
        const count = Number(first);
        const role = __messageRole(second);
        if (!Number.isSafeInteger(count) || count <= 0 || (second !== undefined && role === undefined)) return [];
        const selected = role === undefined ? __transcript : __transcript.filter(message => message.role === role);
        return selected.slice(Math.max(0, selected.length - count)).map(message => message.content);
      }
      const start = __normalizeMessageId(first);
      const end = __normalizeMessageId(second);
      const role = __messageRole(third);
      if (start < 0 || end < start || start >= __transcript.length || (third !== undefined && role === undefined)) return [];
      return __transcript.slice(start, Math.min(end + 1, __transcript.length))
        .filter(message => role === undefined || message.role === role)
        .map(message => message.content);
    };
    const __lastMessageByRole = role => {
      for (let index = __transcript.length - 1; index >= 0; index -= 1) {
        if (__transcript[index].role === role) return { id: index, content: __transcript[index].content };
      }
      return { id: -1, content: '' };
    };
    const __lastUser = __lastMessageByRole('user');
    const __lastCharacter = __lastMessageByRole('assistant');
    const lastMessageId = __transcript.length - 1;
    const lastUserMessageId = __lastUser.id;
    const lastCharMessageId = __lastCharacter.id;
    const lastUserMessage = __lastUser.content;
    const lastCharMessage = __lastCharacter.content;
    const lastMessage = lastMessageId < 0
      ? (messages.length === 0 ? '' : messages[messages.length - 1])
      : __transcript[lastMessageId].content;
    const variableScopes = __input.scopes;
    const stat_data = __input.stat_data;
    const __plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const __set = (record, key, value) => Object.defineProperty(record, key, {
      value, enumerable: true, configurable: true, writable: true,
    });
    const __merge = (target, source) => {
      if (!__plain(source)) return target;
      for (const key of Object.keys(source)) {
        const value = source[key];
        if (__plain(value)) {
          const current = __plain(target[key]) ? target[key] : Object.create(null);
          __set(target, key, __merge(current, value));
        } else {
          __set(target, key, Array.isArray(value) ? value.slice() : value);
        }
      }
      return target;
    };
    const __cloneDeep = (value, seen = new WeakMap()) => {
      if (value === null || typeof value !== 'object') return value;
      if (seen.has(value)) return seen.get(value);
      const target = Array.isArray(value) ? [] : Object.create(null);
      seen.set(value, target);
      for (const key of Object.keys(value)) __set(target, key, __cloneDeep(value[key], seen));
      return target;
    };
    const __path = value => (Array.isArray(value) ? value : String(value)
      .replace(/\\[([^\\]]+)\\]/g, '.$1').split('.'))
      .map(segment => String(segment).replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const __readPath = (record, path, fallback) => {
      let current = record;
      for (const segment of __path(path)) {
        if (current === null || typeof current !== 'object' || !__owns(current, segment)) return fallback;
        current = current[segment];
      }
      return current;
    };
    const __writePath = (record, path, value) => {
      const segments = __path(path);
      if (segments.length === 0) return record;
      let current = record;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        const next = segments[index + 1];
        const child = current[segment];
        if (child === null || typeof child !== 'object') {
          __set(current, segment, /^\\d+$/u.test(next) ? [] : Object.create(null));
        }
        current = current[segment];
      }
      __set(current, segments[segments.length - 1], value);
      return record;
    };
    const __deletePath = (record, path) => {
      const segments = __path(path);
      let current = record;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (current === null || typeof current !== 'object' || !__owns(current, segment)) return;
        current = current[segment];
      }
      if (current !== null && typeof current === 'object') delete current[segments.at(-1)];
    };
    const __flattenPaths = values => values.flatMap(value => Array.isArray(value) ? value : [value]);
    const _ = Object.freeze({
      get: (record, path, fallback = undefined) => __readPath(record, path, fallback),
      cloneDeep: value => __cloneDeep(value),
      mapValues: (record, iteratee) => {
        const result = Object.create(null);
        if (record === null || typeof record !== 'object') return result;
        for (const key of Object.keys(record)) __set(result, key, iteratee(record[key], key, record));
        return result;
      },
      isEmpty: value => {
        if (value === null || value === undefined) return true;
        if (typeof value === 'string' || Array.isArray(value)) return value.length === 0;
        if (value instanceof Map || value instanceof Set) return value.size === 0;
        return typeof value === 'object' ? Object.keys(value).length === 0 : true;
      },
      omit: (record, ...paths) => {
        const result = __cloneDeep(record);
        for (const path of __flattenPaths(paths)) __deletePath(result, path);
        return result;
      },
      pick: (record, ...paths) => {
        const result = Object.create(null);
        const missing = Object.create(null);
        for (const path of __flattenPaths(paths)) {
          const value = __readPath(record, path, missing);
          if (value !== missing) __writePath(result, path, __cloneDeep(value));
        }
        return result;
      },
      transform: (record, iteratee, accumulator = Array.isArray(record) ? [] : Object.create(null)) => {
        if (record === null || typeof record !== 'object') return accumulator;
        for (const key of Object.keys(record)) {
          if (iteratee(accumulator, record[key], Array.isArray(record) ? Number(key) : key, record) === false) break;
        }
        return accumulator;
      },
    });
    const __yamlScalar = value => {
      if (value === null) return 'null';
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return JSON.stringify(String(value));
    };
    const __yamlLines = (value, depth = 0) => {
      const indent = '  '.repeat(depth);
      if (value === null || typeof value !== 'object') return [indent + __yamlScalar(value)];
      const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
      if (entries.length === 0) return [indent + (Array.isArray(value) ? '[]' : '{}')];
      return entries.flatMap(([key, item]) => {
        const prefix = Array.isArray(value) ? '-' : JSON.stringify(String(key)) + ':';
        if (item === null || typeof item !== 'object') return [indent + prefix + ' ' + __yamlScalar(item)];
        return [indent + prefix, ...__yamlLines(item, depth + 1)];
      });
    };
    const YAML = Object.freeze({ stringify: value => value === undefined ? undefined : __yamlLines(value).join('\\n') + '\\n' });
    const variables = [
      variableScopes.global, variableScopes.preset, variableScopes.character,
      variableScopes.initial, variableScopes.chat, variableScopes.message, __input.variables,
    ].reduce((result, record) => __merge(result, record), Object.create(null));
    if (stat_data !== undefined) __set(variables, 'stat_data', stat_data);
    const __read = (record, name, fallback) => {
      if (name === null) return record;
      const key = String(name);
      if (__owns(record, key)) return record[key];
      let current = record;
      for (const segment of key.split('.')) {
        if (current === null || typeof current !== 'object' || !__owns(current, segment)) return fallback;
        current = current[segment];
      }
      return current;
    };
    const __scopeNames = new Set(['cache', 'global', 'preset', 'character', 'local', 'chat', 'message', 'initial']);
    const __fallback = value => __plain(value)
      ? (__owns(value, 'defaults') ? value.defaults : undefined)
      : typeof value === 'string' && __scopeNames.has(value) ? undefined : value;
    const __scope = value => {
      const option = __plain(value) ? value : {};
      const requested = typeof value === 'string' ? value
        : typeof option.scope === 'string' ? option.scope
          : typeof option.type === 'string' ? option.type : 'cache';
      if (requested === 'global') return variableScopes.global ?? {};
      if (requested === 'preset') return variableScopes.preset ?? {};
      if (requested === 'character') return variableScopes.character ?? {};
      if (requested === 'local' || requested === 'chat') return variableScopes.chat ?? {};
      if (requested === 'message') return variableScopes.message ?? {};
      if (requested === 'initial') return variableScopes.initial ?? {};
      return variables;
    };
    const getvar = (name, options = undefined) => __read(__scope(options), name, __fallback(options));
    const __scoped = scope => (name, options = undefined) => __read(scope, name, __fallback(options));
    const getchatvar = __scoped(variableScopes.chat ?? {});
    const getglobalvar = __scoped(variableScopes.global ?? {});
    const getlocalvar = getchatvar;
    const getpresetvar = __scoped(variableScopes.preset ?? {});
    const getcharactervar = __scoped(variableScopes.character ?? {});
    const getmessagevar = __scoped(variableScopes.message ?? {});
    const getVar = getvar;
    const getChatVar = getchatvar;
    const getGlobalVar = getglobalvar;
    const getLocalVar = getlocalvar;
    const getPresetVar = getpresetvar;
    const getCharacterVar = getcharactervar;
    const getMessageVar = getmessagevar;
    const getWorldInfo = async (...args) => globalThis.__agentRpGetWorldInfo(...args);
    const getwi = getWorldInfo;
    const __decodeCharacterData = raw => raw === '' ? null : JSON.parse(raw);
    const getCharData = async (name = char) =>
      __decodeCharacterData(await globalThis.__agentRpGetCharData(name));
    const __defaultCharacterTemplate = ${JSON.stringify(DEFAULT_CHARACTER_TEMPLATE)};
    const getchar = async (name = char, template = __defaultCharacterTemplate, data = {}) =>
      globalThis.__agentRpGetChar(name, template, data);
    const getChara = getchar;
    const getpreset = async (name, data = {}) => globalThis.__agentRpGetPreset(name, data);
    const getPresetPrompt = getpreset;
    const injectPrompt = (key, prompt, order = 100, sticky = 0, uid = '') =>
      globalThis.__agentRpInjectPrompt(key, prompt, order, sticky, uid);
    const getPromptsInjected = (key, postprocess = []) =>
      globalThis.__agentRpGetPromptsInjected(key, postprocess);
    const hasPromptsInjected = key => globalThis.__agentRpHasPromptsInjected(key);
    const print = (...values) => { for (const value of values) __append(value); };
    globalThis.Date = undefined;
    Math.random = () => { throw new Error('__AGENT_RP_EJS_NONDETERMINISTIC__'); };
    ${statements}
    return __output;
  })()`
}

function failureKind(value: unknown): EjsTemplateFailureKind {
  if (typeof value !== 'object' || value === null) return 'runtime-error'
  const record = value as { readonly name?: unknown; readonly message?: unknown }
  const message = typeof record.message === 'string' ? record.message : ''
  if (message.includes('__AGENT_RP_EJS_OUTPUT_LIMIT__')) return 'output-limit'
  if (message.includes('__AGENT_RP_EJS_RESOURCE_UNSUPPORTED__')) return 'resource-unsupported'
  if (message.includes('__AGENT_RP_EJS_RESOURCE_LIMIT__')) return 'resource-limit'
  if (message.includes('interrupted')) return 'execution-limit'
  if (/out of memory|memory limit/iu.test(message)) return 'memory-limit'
  if (record.name === 'SyntaxError') return 'syntax-error'
  return 'runtime-error'
}

interface ParsedRegexPattern {
  readonly source: string
  readonly flags: string
}

function parsedRegexPattern(value: string, caseSensitive: boolean): ParsedRegexPattern | undefined {
  if (value === '') return undefined
  let source = value
  let flags = ''
  if (value[0] === '/') {
    let escaped = false
    let inClass = false
    let closing = -1
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index]!
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '[') inClass = true
      else if (character === ']') inClass = false
      else if (character === '/' && !inClass) closing = index
    }
    if (closing > 0) {
      source = value.slice(1, closing)
      flags = value.slice(closing + 1)
      if (!/^[a-z]*$/u.test(flags)) return undefined
    }
  }
  if (!caseSensitive && !flags.includes('i')) flags += 'i'
  return { source, flags }
}

function regexFailure(value: unknown): 'invalid' | 'execution-limit' | 'resource-limit' {
  if (typeof value !== 'object' || value === null) return 'invalid'
  const record = value as { readonly name?: unknown; readonly message?: unknown }
  const message = typeof record.message === 'string' ? record.message : ''
  if (message.includes('interrupted')) return 'execution-limit'
  if (/out of memory|memory limit/iu.test(message)) return 'resource-limit'
  return 'invalid'
}

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, JsonValue>>
}

function mergeTemplateData(
  base: JsonValue,
  extra: unknown,
  fallbackName?: string,
): Readonly<Record<string, JsonValue>> {
  const baseRecord = jsonRecord(base)
  const result: Record<string, JsonValue> = baseRecord === undefined
    ? { value: base }
    : { ...baseRecord }
  if (fallbackName !== undefined && result.name === undefined) result.name = fallbackName
  const extraRecord = jsonRecord(extra)
  if (extraRecord !== undefined) Object.assign(result, extraRecord)
  return result
}

function resourceSelector(value: unknown): string | number | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function matchesResource(selector: string | number | undefined, id: string | undefined, name: string | undefined): boolean {
  if (selector === undefined) return true
  const text = String(selector)
  return id === text || name === text
}

function createQuickJsRegexMatcher(quickjs: QuickJSWASMModule): LorebookRegexMatcher {
  const runtime = quickjs.newRuntime()
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES)
  runtime.setMaxStackSize(MAX_STACK_BYTES)
  let polls = 0
  runtime.setInterruptHandler(() => ++polls > MAX_REGEX_INTERRUPT_POLLS)
  const vm = runtime.newContext()
  const compiled = vm.evalCode('(pattern, flags, text) => new RegExp(pattern, flags).test(text)', 'agent-rp:world-info-regex')
  let matchFunction: QuickJSHandle | undefined
  if (compiled.error !== undefined) compiled.error.dispose()
  else matchFunction = compiled.value
  let disposed = false
  let evaluations = 0
  let patternChars = 0

  return {
    match(keys, text, caseSensitive): LorebookRegexMatchResult {
      if (disposed || matchFunction === undefined || text.length > MAX_REGEX_INPUT_CHARS) {
        return { ok: false, kind: 'resource-limit' }
      }
      if (evaluations + keys.length > MAX_REGEX_EVALUATIONS) return { ok: false, kind: 'resource-limit' }
      const matchedKeys: string[] = []
      for (const key of keys) {
        const parsed = parsedRegexPattern(key, caseSensitive)
        if (parsed === undefined || parsed.source.length > MAX_REGEX_PATTERN_CHARS) {
          return { ok: false, kind: 'invalid' }
        }
        patternChars += parsed.source.length
        evaluations += 1
        if (patternChars > MAX_REGEX_PATTERN_CHARS_PER_MATCHER) return { ok: false, kind: 'resource-limit' }
        let patternHandle: QuickJSHandle | undefined
        let flagsHandle: QuickJSHandle | undefined
        let textHandle: QuickJSHandle | undefined
        try {
          patternHandle = vm.newString(parsed.source)
          flagsHandle = vm.newString(parsed.flags)
          textHandle = vm.newString(text)
          polls = 0
          const result = vm.callFunction(matchFunction, vm.undefined, patternHandle, flagsHandle, textHandle)
          const errorHandle = result.error
          if (errorHandle !== undefined) {
            const error = vm.dump(errorHandle)
            errorHandle.dispose()
            return { ok: false, kind: regexFailure(error) }
          }
          const valueHandle = result.value
          if (valueHandle === undefined) return { ok: false, kind: 'invalid' }
          const matched = vm.dump(valueHandle)
          valueHandle.dispose()
          if (typeof matched !== 'boolean') return { ok: false, kind: 'invalid' }
          if (matched) matchedKeys.push(key)
        } catch (error: unknown) {
          return { ok: false, kind: regexFailure(error) }
        } finally {
          patternHandle?.dispose()
          flagsHandle?.dispose()
          textHandle?.dispose()
        }
      }
      return { ok: true, matchedKeys }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      matchFunction?.dispose()
      vm.dispose()
      runtime.dispose()
    },
  }
}

/** QuickJS-backed evaluator; every render gets a fresh runtime and context. */
export class EjsTemplateEngine implements LorebookRegexEngine {
  private constructor(private readonly quickjs: QuickJSWASMModule) {}

  /** Load the embedded QuickJS WebAssembly module once during plugin startup. */
  static async create(): Promise<EjsTemplateEngine> {
    quickjsModule ??= newQuickJSWASMModuleFromVariant(variant)
    return new EjsTemplateEngine(await quickjsModule)
  }

  /** Render one template without exposing Host globals, modules, files, or network APIs. */
  render(template: string, context: EjsTemplateContext, target: EjsTemplateTarget = {}): EjsTemplateResult {
    return this.renderWithDepth(template, context, target, 0)
  }

  private renderWithDepth(
    template: string,
    context: EjsTemplateContext,
    target: EjsTemplateTarget,
    resourceDepth: number,
  ): EjsTemplateResult {
    if (template.length > MAX_TEMPLATE_CHARS) return { ok: false, kind: 'source-limit' }
    const code = compileTemplate(template, context, target)
    if (code === undefined) return { ok: false, kind: 'syntax-error' }
    const runtime = this.quickjs.newRuntime()
    runtime.setMemoryLimit(MEMORY_LIMIT_BYTES)
    runtime.setMaxStackSize(MAX_STACK_BYTES)
    let polls = 0
    runtime.setInterruptHandler(() => ++polls > MAX_INTERRUPT_POLLS)
    const vm = runtime.newContext()
    try {
      let resourceReads = 0
      let resourceChars = 0
      const chargeResource = (chars: number) => {
        resourceReads += 1
        if (resourceReads > 128) throw new Error('__AGENT_RP_EJS_RESOURCE_LIMIT__')
        resourceChars += chars
        if (resourceChars > MAX_RESOURCE_CHARS) throw new Error('__AGENT_RP_EJS_RESOURCE_LIMIT__')
      }
      const characterResources = context.characterCards ?? []
      const currentCharacter: EjsTemplateCharacterResource | undefined = context.characterData === undefined
        ? undefined
        : { id: context.characterName, name: context.characterName, data: context.characterData }
      const selectCharacter = (value: unknown): EjsTemplateCharacterResource | undefined => {
        const selector = resourceSelector(value)
        const listed = characterResources.find(resource => matchesResource(selector, resource.id, resource.name))
        if (listed !== undefined) return listed
        if (currentCharacter !== undefined && matchesResource(selector, currentCharacter.id, currentCharacter.name)) {
          return currentCharacter
        }
        return undefined
      }
      const selectPreset = (value: unknown): EjsTemplatePresetPromptResource | undefined => {
        const selector = resourceSelector(value)
        return (context.presetPrompts ?? []).find(resource =>
          matchesResource(selector, resource.id, resource.name))
      }
      const lookup = vm.newFunction('__agentRpGetWorldInfo', (...handles) => {
        const args = handles.map(handle => vm.dump(handle) as unknown)
        const books = context.worldInfoBooks ?? []
        const explicitEntry = typeof args[1] === 'string' || typeof args[1] === 'number'
        const targetBook = target.worldInfoBookId
        const matchesBook = (book: EjsTemplateWorldInfoBook, value: unknown) => {
          if (value === undefined) return false
          const text = String(value)
          return book.id === text || book.name === text
            || text.startsWith(`${book.id}/`) || (book.name !== undefined && text.startsWith(`${book.name}/`))
        }
        const targetBooks = targetBook === undefined ? books : books.filter(book => matchesBook(book, targetBook))
        // A plugin candidate may identify the current entry by its full path
        // rather than by the normalized book id. In that case preserve the
        // extension's useful same-book fallback instead of returning empty.
        const currentBooks = targetBooks.length > 0 ? targetBooks : books
        const selectedBooks = explicitEntry
          ? books.filter(book => matchesBook(book, args[0]))
          : currentBooks
        const query = explicitEntry ? args[1] : args[0]
        const entry = (typeof query === 'string' || typeof query === 'number')
          ? selectedBooks.flatMap(book => book.entries).find(item =>
              item.sourceId === String(query) || item.name === query || item.comment === query)
          : undefined
        const text = entry?.content ?? ''
        if (/<%[=_-]?[\s\S]*?%>/imu.test(text)) throw new Error('__AGENT_RP_EJS_RESOURCE_UNSUPPORTED__')
        chargeResource(text.length)
        return vm.newString(text)
      })
      vm.setProp(vm.global, '__agentRpGetWorldInfo', lookup)
      lookup.dispose()
      const getCharacterData = vm.newFunction('__agentRpGetCharData', (...handles) => {
        const args = handles.map(handle => vm.dump(handle) as unknown)
        const selected = selectCharacter(args[0])
        if (selected === undefined) return vm.newString('')
        const serialized = JSON.stringify(selected.data)
        chargeResource(serialized.length)
        return vm.newString(serialized)
      })
      vm.setProp(vm.global, '__agentRpGetCharData', getCharacterData)
      getCharacterData.dispose()
      const getCharacter = vm.newFunction('__agentRpGetChar', (...handles) => {
        const args = handles.map(handle => vm.dump(handle) as unknown)
        const selected = selectCharacter(args[0])
        if (selected === undefined || resourceDepth >= MAX_RESOURCE_DEPTH) {
          if (resourceDepth >= MAX_RESOURCE_DEPTH) throw new Error('__AGENT_RP_EJS_RESOURCE_LIMIT__')
          return vm.newString('')
        }
        const template = typeof args[1] === 'string' ? args[1] : DEFAULT_CHARACTER_TEMPLATE
        const nested = this.renderWithDepth(
          template,
          {
            ...context,
            templateData: mergeTemplateData(selected.data, args[2], selected.name ?? selected.id),
          },
          target,
          resourceDepth + 1,
        )
        const text = nested.ok ? nested.text : ''
        chargeResource(text.length)
        return vm.newString(text)
      })
      vm.setProp(vm.global, '__agentRpGetChar', getCharacter)
      getCharacter.dispose()
      const getPreset = vm.newFunction('__agentRpGetPreset', (...handles) => {
        const args = handles.map(handle => vm.dump(handle) as unknown)
        const selected = selectPreset(args[0])
        if (selected === undefined || resourceDepth >= MAX_RESOURCE_DEPTH) {
          if (resourceDepth >= MAX_RESOURCE_DEPTH) throw new Error('__AGENT_RP_EJS_RESOURCE_LIMIT__')
          return vm.newString('')
        }
        const nested = this.renderWithDepth(
          selected.content,
          {
            ...context,
            templateData: mergeTemplateData(selected.data ?? {}, args[1], selected.name),
          },
          target,
          resourceDepth + 1,
        )
        const text = nested.ok ? nested.text : ''
        chargeResource(text.length)
        return vm.newString(text)
      })
      vm.setProp(vm.global, '__agentRpGetPreset', getPreset)
      getPreset.dispose()
      const injectPrompt = vm.newFunction('__agentRpInjectPrompt', (...handles) => {
        const args = handles.map(handle => vm.dump(handle) as unknown)
        context.promptInjections?.inject(
          injectionText(args[0]),
          injectionText(args[1]),
          typeof args[2] === 'number' ? args[2] : 100,
          typeof args[3] === 'number' ? args[3] : 0,
          injectionText(args[4]),
        )
        return vm.undefined
      })
      vm.setProp(vm.global, '__agentRpInjectPrompt', injectPrompt)
      injectPrompt.dispose()
      const getPromptsInjected = vm.newFunction('__agentRpGetPromptsInjected', (...handles) => {
        const args = handles.map(handle => vm.dump(handle) as unknown)
        return vm.newString(context.promptInjections?.get(injectionText(args[0]), args[1]) ?? '')
      })
      vm.setProp(vm.global, '__agentRpGetPromptsInjected', getPromptsInjected)
      getPromptsInjected.dispose()
      const hasPromptsInjected = vm.newFunction('__agentRpHasPromptsInjected', (...handles) => {
        const args = handles.map(handle => vm.dump(handle) as unknown)
        return context.promptInjections?.has(injectionText(args[0])) === true ? vm.true : vm.false
      })
      vm.setProp(vm.global, '__agentRpHasPromptsInjected', hasPromptsInjected)
      hasPromptsInjected.dispose()
      const result = vm.evalCode(code, 'agent-rp:ejs')
      const errorHandle = result.error
      if (errorHandle !== undefined) {
        const error = vm.dump(errorHandle)
        errorHandle.dispose()
        return { ok: false, kind: failureKind(error) }
      }
      const promiseHandle = result.value
      if (promiseHandle === undefined) return { ok: false, kind: 'runtime-error' }
      const jobs = runtime.executePendingJobs(MAX_PENDING_JOBS)
      const jobError = jobs.error
      if (jobError !== undefined) {
        const error = jobError.context.dump(jobError)
        jobError.dispose()
        jobs.dispose()
        promiseHandle.dispose()
        return { ok: false, kind: failureKind(error) }
      }
      jobs.dispose()
      const settled = vm.getPromiseState(promiseHandle)
      promiseHandle.dispose()
      if (settled.type === 'pending') return { ok: false, kind: 'execution-limit' }
      if (settled.type === 'rejected') {
        const error = vm.dump(settled.error)
        settled.error.dispose()
        return { ok: false, kind: failureKind(error) }
      }
      const value = vm.dump(settled.value)
      settled.value.dispose()
      return typeof value === 'string'
        ? { ok: true, text: value }
        : { ok: false, kind: 'runtime-error' }
    } catch (error) {
      return { ok: false, kind: failureKind(error) }
    } finally {
      vm.dispose()
      runtime.dispose()
    }
  }

  /** Bind one immutable context and cap the number of templates evaluated for one prompt or projection pass. */
  createRenderer(context: EjsTemplateContext): (template: string, target?: EjsTemplateTarget) => EjsTemplateResult {
    let evaluations = 0
    return (template, target) => {
      if (evaluations >= MAX_RENDERER_EVALUATIONS) return { ok: false, kind: 'execution-limit' }
      evaluations += 1
      return this.render(template, context, target)
    }
  }

  /** Create one bounded matcher that never executes untrusted regex in the Host JavaScript engine. */
  createRegexMatcher(): LorebookRegexMatcher {
    return createQuickJsRegexMatcher(this.quickjs)
  }
}
