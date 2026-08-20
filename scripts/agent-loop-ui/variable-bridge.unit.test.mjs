import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, 'index.html'), 'utf8')

function loadFrameRuntime() {
  const start = html.indexOf('    function buildCardFrameRuntime(')
  const end = html.indexOf('\n    function buildCardFrameDocument', start)
  assert.ok(start >= 0 && end > start, 'iframe runtime function must remain discoverable')
  const source = html.slice(start, end).trim()
  const safeCardScriptJson = value => JSON.stringify(value ?? null)
  return vm.runInNewContext(`(${source})`, { safeCardScriptJson })
}

function createFrame(characterContext = null, rpcValues = {}) {
  const listeners = new Map()
  const messages = []
  const parent = {
    postMessage(message) {
      messages.push(message)
      if (message.type !== 'agent-rp-card-rpc') return
      window.dispatchEvent({
        type: 'message',
        source: parent,
        data: {
          type: 'agent-rp-card-rpc-result',
          id: message.id,
          requestId: message.requestId,
          ok: true,
          value: Object.prototype.hasOwnProperty.call(rpcValues, message.method)
            ? rpcValues[message.method]
            : message.method === 'format-as-displayed-message'
            ? { html: '<p>formatted</p>', text: 'formatted' }
            : { ok: true },
        },
      })
    },
  }
  const window = {
    parent,
    frameElement: null,
    addEventListener(type, listener) {
      const current = listeners.get(type) || []
      current.push(listener)
      listeners.set(type, current)
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event)
    },
  }
  const context = vm.createContext({ window, console, setTimeout, clearTimeout })
  const buildCardFrameRuntime = loadFrameRuntime()
  vm.runInContext(buildCardFrameRuntime('frame-test', { stat_data: { chat: true } }, {}, {}, 'session-test', characterContext), context)
  return { window, parent, messages }
}

function messagesOf(frame, type) {
  return frame.messages.filter(message => message.type === type)
}

function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('variable option defaults and message scope stay distinct from chat', async () => {
  const frame = createFrame()
  frame.window.dispatchEvent({
    type: 'message',
    source: frame.parent,
    data: {
      type: 'agent-rp-card-helper-state',
      id: 'frame-test',
      scopes: {
        chat: { chat: true },
        message: { message: true },
        extension: { ext: { extension: true } },
      },
      scripts: { 'script-a': { script: true } },
    },
  })

  assert.deepEqual(plain(frame.window.getVariables()), { chat: true })
  assert.deepEqual(plain(frame.window.getVariables({ type: 'message' })), { message: true })
  assert.deepEqual(plain(frame.window.getVariables({ type: 'message', message_id: -2 })), { message: true })
  assert.notDeepEqual(plain(frame.window.getVariables({ type: 'message' })), plain(frame.window.getVariables()))
  assert.deepEqual(plain(frame.window.getVariables({ type: 'script', script_id: 'script-a' })), { script: true })
  assert.deepEqual(plain(frame.window.getVariables({ type: 'extension', extension_id: 'ext' })), { extension: true })

  const reads = messagesOf(frame, 'agent-rp-card-variable-read')
  assert.deepEqual(plain(reads.at(-1)?.option), { type: 'extension', extension_id: 'ext' })
  assert.deepEqual(plain(reads.find(message => message.option?.message_id === -2)?.option), { type: 'message', message_id: -2 })

  await frame.window.replaceVariables({ changed: true }, { type: 'message', message_id: -2 })
  const messageMutation = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(messageMutation?.payload.scope, 'message')
  assert.deepEqual(plain(messageMutation?.payload.option), { type: 'message', message_id: -2 })
  assert.equal(messageMutation?.payload.message_id, -2)
  assert.equal('chat' in (messageMutation?.payload || {}), false)
  assert.deepEqual(plain(frame.window.getVariables({ type: 'message', message_id: -2 })), { changed: true })
  assert.deepEqual(plain(frame.window.getVariables({ type: 'message', message_id: 'latest' })), { message: true })
})

test('script and extension options preserve raw fields and use official defaults', async () => {
  const frame = createFrame()

  await frame.window.updateVariablesWith(value => ({ ...value, updated: true }), { type: 'script' })
  const scriptMutation = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(scriptMutation?.payload.scope, 'script')
  assert.equal(scriptMutation?.payload.option.script_id, 'frame-test')
  assert.equal(scriptMutation?.payload.scriptId, 'frame-test')

  await frame.window.insertVariables({ inserted: true }, { type: 'extension', extension_id: 'ext-a' })
  const extensionMutation = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.deepEqual(plain(extensionMutation?.payload.option), { type: 'extension', extension_id: 'ext-a' })
  assert.equal(extensionMutation?.payload.extension_id, 'ext-a')

  frame.window.deleteVariable('inserted', { type: 'extension', extension_id: 'ext-a' })
  const deleteMutation = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.deepEqual(plain(deleteMutation?.payload.option), { type: 'extension', extension_id: 'ext-a' })
  assert.throws(() => frame.window.getVariables({ type: 'extension' }), /extension_id/)
})

test('omitting option keeps the legacy chat default while preserving option on the bridge event', async () => {
  const frame = createFrame()
  await frame.window.replaceVariables({ chat: 'updated' })
  const event = messagesOf(frame, 'agent-rp-card-variable-replace').at(-1)
  assert.deepEqual(plain(event?.option), { type: 'chat' })
  assert.deepEqual(plain(frame.window.getVariables()), { stat_data: { chat: 'updated' } })
})

test('Tavern Helper injectPrompts and uninjectPrompts use the canonical mutation bridge', async () => {
  const frame = createFrame()
  frame.window.__agentRpCurrentScriptId = 'script-a'
  const handle = frame.window.injectPrompts([
    { id: 'prompt-a', position: 'in_chat', depth: 0, role: 'system', content: 'A', should_scan: true },
    { id: 'prompt-b', position: 'none', depth: 1, role: 'user', content: 'B' },
  ], { once: true })
  const inject = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(inject?.method, 'tavern-helper-mutation')
  assert.equal(inject?.payload.operation, 'inject-prompts')
  assert.equal(inject?.payload.scriptId, 'script-a')
  assert.equal(inject?.payload.once, true)
  assert.deepEqual(plain(inject?.payload.prompts), [
    { id: 'prompt-a', position: 'in_chat', depth: 0, role: 'system', content: 'A', should_scan: true },
    { id: 'prompt-b', position: 'none', depth: 1, role: 'user', content: 'B' },
  ])

  handle.uninject()
  const uninject = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(uninject?.method, 'tavern-helper-mutation')
  assert.equal(uninject?.payload.operation, 'uninject-prompts')
  assert.deepEqual(plain(uninject?.payload.ids), ['prompt-a', 'prompt-b'])
  assert.equal(typeof frame.window.TavernHelper.injectPrompts, 'function')
  assert.equal(typeof frame.window.TavernHelper.uninjectPrompts, 'function')
  assert.equal(frame.window.TavernHelper.getChatMessages, frame.window.getChatMessages)
  assert.equal(frame.window.TavernHelper.getWorldbook, frame.window.getWorldbook)
  assert.equal(typeof frame.window.TavernHelper.replaceWorldbook, 'function')
  assert.equal(typeof frame.window.TavernHelper.rebindCharWorldbooks, 'function')
})

test('Tavern Helper activewi records a generation-scoped host activation', async () => {
  const entry = {
    uid: 7,
    name: 'Magic entry',
    enabled: true,
    strategy: { type: 'selective', keys: ['magic'], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
    position: { type: 'after_character_definition', role: 'system', depth: 0, order: 1 },
    content: 'MAGIC',
    probability: 100,
    recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
    effect: { sticky: null, cooldown: null, delay: null },
  }
  const frame = createFrame(null, { 'get-worldbook-names': ['helper-book'], 'get-worldbook': [entry] })
  const entries = await frame.window.getWorldInfoData('helper-book')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'Magic entry')
  const activated = await frame.window.activewi('helper-book', 'Magic entry')
  assert.equal(activated.path, '酒馆助手/helper-book/7')
  const request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'activate-world-info')
  assert.deepEqual(plain(request?.payload), { path: '酒馆助手/helper-book/7', force: false })
  const matches = await frame.window.activateWorldInfoByKeywords('magic')
  assert.equal(matches.length, 1)
  assert.equal(messagesOf(frame, 'agent-rp-card-rpc').at(-1)?.method, 'activate-world-info')
})

test('SillyTavern chat metadata uses the canonical persistent mutation bridge', () => {
  const frame = createFrame()
  const context = frame.window.SillyTavern.getContext()
  const merged = context.updateChatMetadata({ scene: '雨夜', turn: 1 })
  let request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.deepEqual(plain(merged), { scene: '雨夜', turn: 1 })
  assert.equal(request?.method, 'tavern-helper-mutation')
  assert.deepEqual(plain(request?.payload), {
    format: 0,
    operation: 'update-chat-metadata',
    values: { scene: '雨夜', turn: 1 },
    reset: false,
  })

  const reset = frame.window.SillyTavern.updateChatMetadata({ scene: '白天' }, true)
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.deepEqual(plain(reset), { scene: '白天' })
  assert.equal(request?.payload.reset, true)
  assert.deepEqual(plain(frame.window.SillyTavern.getContext().chatMetadata), { scene: '白天' })
})

test('SillyTavern setExtensionPrompt preserves the four official insertion positions', async () => {
  const frame = createFrame()
  const context = frame.window.SillyTavern.getContext()
  await context.setExtensionPrompt('story-after', 'after story', 0, 0, true, 1)
  let request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'tavern-helper-mutation')
  assert.deepEqual(plain(request?.payload.prompts), [{
    id: 'story-after', position: 'in_prompt', depth: 0, role: 'user', content: 'after story', should_scan: true,
  }])

  await frame.window.setExtensionPrompt('story-before', 'before story', 2, 3)
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.deepEqual(plain(request?.payload.prompts), [{
    id: 'story-before', position: 'before_prompt', depth: 3, role: 'system', content: 'before story', should_scan: false,
  }])
  await frame.window.setExtensionPrompt('scan-only', 'scan', -1, 0)
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.payload.prompts[0].position, 'none')
  assert.equal(typeof frame.window.setExtensionPrompt, 'function')
  assert.equal(typeof frame.window.TavernHelper.setExtensionPrompt, 'function')
})

test('Tavern Helper setChatMessage uses the public field-patch signature', async () => {
  const frame = createFrame()
  await frame.window.TavernHelper.setChatMessage(
    { message: '修改后的正文', data: { source: 'card' }, extra: { floor: 3 } },
    4,
    { refresh: 'none' },
  )
  const request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'set-chat-message')
  assert.deepEqual(plain(request?.payload), {
    messageId: 4,
    fields: { message: '修改后的正文', data: { source: 'card' }, extra: { floor: 3 }, message_id: 4 },
    options: { refresh: 'none' },
  })

  // Keep the pre-canonical local signature working for cards imported before
  // the public Tavern Helper bridge was aligned.
  await frame.window.setChatMessage(5, '旧签名正文')
  const legacy = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.deepEqual(plain(legacy?.payload.fields), { message: '旧签名正文', message_id: 5 })
})

test('iframe EjsTemplate evaluates core Prompt Template syntax in the sandbox', async () => {
  const frame = createFrame()
  const context = await frame.window.EjsTemplate.prepareContext({ name1: '用户', value: 3 })
  assert.equal(await frame.window.EjsTemplate.evalTemplate(
    '<% if (value > 2) { %><%= name1 %>: <%= "<ok>" %><% } %>',
    context,
  ), '用户: &lt;ok&gt;')
  assert.equal(await frame.window.EjsTemplate.evalTemplate('<% print("A", "B") %>', context), 'AB')
  const compiled = await frame.window.EjsTemplate.compileTemplate('<%= value + 1 %>')
  assert.equal(await compiled({ value: 4 }), '5')
  assert.match(await frame.window.EjsTemplate.getSyntaxErrorInfo('<% if ( %>'), /Unexpected token/)
})

test('standalone triggerSlash forwards a safe subset and rejects dynamic commands', async () => {
  const frame = createFrame()
  assert.equal(await frame.window.triggerSlash('/pass literal value'), 'literal value')
  assert.equal(await frame.window.triggerSlash('/echo severity=success hello'), 'hello')
  await frame.window.triggerSlash('/wait 0')
  await assert.rejects(() => frame.window.triggerSlash('/pass {{user}}'), /macros/u)
  await assert.rejects(() => frame.window.triggerSlash('/unknown command'), /not available/u)
  await assert.rejects(() => frame.window.triggerSlash('/wait 60001'), /outside/u)
})

test('Tavern Helper chat tree APIs preserve message metadata and canonical RPC arguments', async () => {
  const frame = createFrame()
  await frame.window.setChatMessages([
    { message_id: 7, role: 'assistant', name: '角色', message: '正文', is_hidden: true, data: { source: 'card' }, extra: { floor: 1 }, swipes: ['正文', '替代'], swipes_info: [{ send_date: 1 }] },
  ], { refresh: false })
  let request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'set-chat-messages')
  assert.equal(request?.payload.options.refresh, false)
  assert.deepEqual(plain(request?.payload.messages), [{
    message_id: 7,
    name: '角色',
    role: 'assistant',
    message: '正文',
    is_hidden: true,
    data: { source: 'card' },
    extra: { floor: 1 },
    swipes: ['正文', '替代'],
    swipes_info: [{ send_date: 1 }],
  }])

  await frame.window.setChatMessages([{ message_id: 7, data: { source: 'updated' } }], { refresh: 'none' })
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.deepEqual(plain(request?.payload.messages), [{ message_id: 7, data: { source: 'updated' } }])
  assert.equal(request?.payload.options.refresh, 'none')

  await frame.window.createChatMessages([{ role: 'user', content: '插入' }], { insert_before: 1 })
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'create-chat-messages')
  assert.equal(request?.payload.options.insert_before, 1)
  assert.equal(request?.payload.messages[0].message, '插入')

  await frame.window.deleteChatMessages([7], { refresh: false })
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'delete-chat-messages')
  assert.deepEqual(plain(request?.payload.messageIds), [7])
  assert.equal(request?.payload.options.refresh, false)

  await frame.window.rotateChatMessages(0, 1, 2)
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'rotate-chat-messages')
  assert.deepEqual(plain({ begin: request?.payload.begin, middle: request?.payload.middle, end: request?.payload.end }), { begin: 0, middle: 1, end: 2 })
  assert.equal(typeof frame.window.TavernHelper.createChatMessages, 'function')
  assert.equal(typeof frame.window.SillyTavern.getContext().deleteChatMessages, 'function')
})

test('getChatMessages is a synchronous local-cache projection with official filters and ranges', () => {
  const frame = createFrame()
  frame.window.dispatchEvent({
    type: 'message',
    source: frame.parent,
    data: {
      type: 'agent-rp-card-context',
      id: 'frame-test',
      context: {
        name1: '玩家',
        name2: '角色',
        chat: [
          { message_id: 0, name: '玩家', role: 'user', message: '开场', data: { floor: 0 }, extra: {}, swipes: ['开场', '另一开场'], swipe_id: 0 },
          { message_id: 1, name: '角色', role: 'assistant', message: '隐藏楼层', is_hidden: true, data: {}, extra: {} },
          { message_id: 2, name: '玩家', role: 'user', message: '最新', data: {}, extra: {}, swipes: ['最新', '重roll'], swipe_id: 1, swipes_data: [{ id: 0 }, { id: 1 }], swipes_info: [{ send_date: 1 }, { send_date: 2 }] },
        ],
      },
    },
  })

  const latest = frame.window.getChatMessages(-1)
  assert.ok(Array.isArray(latest))
  assert.equal(typeof latest.then, 'undefined')
  assert.deepEqual(plain(latest), [{
    message_id: 2, name: '玩家', role: 'user', is_hidden: false, message: '最新', data: {}, extra: {},
  }])
  assert.deepEqual(plain(frame.window.getChatMessages('0-{{lastMessageId}}', { role: 'user', hide_state: 'unhidden' })), [
    { message_id: 0, name: '玩家', role: 'user', is_hidden: false, message: '开场', data: { floor: 0 }, extra: {} },
    { message_id: 2, name: '玩家', role: 'user', is_hidden: false, message: '最新', data: {}, extra: {} },
  ])
  assert.equal(frame.window.getChatMessages('0-').length, 3)
  assert.deepEqual(plain(frame.window.getChatMessages('-2--1', { include_swipes: true })), [
    { message_id: 1, name: '角色', role: 'assistant', is_hidden: true, message: '隐藏楼层', data: {}, extra: {} },
    { message_id: 2, name: '玩家', role: 'user', is_hidden: false, message: '最新', data: {}, extra: {}, swipe_id: 1, swipes: ['最新', '重roll'], swipes_data: [{ id: 0 }, { id: 1 }], swipes_info: [{ send_date: 1 }, { send_date: 2 }] },
  ])
  assert.equal(frame.window.getChatMessages(1, { hide_state: 'hidden' })[0].message, '隐藏楼层')

  assert.equal(typeof frame.window.TavernHelper.Context.getChatMessages, 'function')
  assert.deepEqual(plain(frame.window.TavernHelper.Context.chat), [
    { message_id: 0, name: '玩家', role: 'user', is_hidden: false, message: '开场', data: { floor: 0 }, extra: {}, swipe_id: 0, swipes: ['开场', '另一开场'] },
    { message_id: 1, name: '角色', role: 'assistant', is_hidden: true, message: '隐藏楼层', data: {}, extra: {} },
    { message_id: 2, name: '玩家', role: 'user', is_hidden: false, message: '最新', data: {}, extra: {}, swipe_id: 1, swipes: ['最新', '重roll'], swipes_data: [{ id: 0 }, { id: 1 }], swipes_info: [{ send_date: 1 }, { send_date: 2 }] },
  ])
  assert.deepEqual(plain(frame.window.TavernHelper.Context.variables), { stat_data: { chat: true } })
  assert.equal(frame.window.TavernHelper.Context.getChatMessages, frame.window.getChatMessages)
})

test('setChatHidden forwards refresh options and createChatMessages preserves insert_before', async () => {
  const frame = createFrame()
  await frame.window.TavernHelper.setChatHidden(1, 3, true, { refresh: 'none' })
  let request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'set-chat-hidden')
  assert.deepEqual(plain(request?.payload), { start: 1, end: 3, hidden: true, options: { refresh: 'none' } })

  await frame.window.createChatMessages([{ role: 'assistant', message: '插入前' }], { insert_before: 2, insert_at: 9, refresh: 'affected' })
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'create-chat-messages')
  assert.deepEqual(plain(request?.payload.options), { insert_before: 2, insert_at: 9, refresh: 'affected' })
})

test('explicit chat-cache sync retains an RPC escape hatch without changing getChatMessages return type', async () => {
  const frame = createFrame()
  const sync = frame.window.TavernHelper.Context.syncChatMessages()
  const request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'get-chat-messages')
  assert.deepEqual(plain(request?.payload), {
    range: '0-{{lastMessageId}}',
    options: { role: 'all', hide_state: 'all', include_swipes: true },
  })
  assert.equal(typeof sync?.then, 'function')
  assert.deepEqual(plain(await sync), [])
})

test('displayed-message APIs use the safe host bridge', async () => {
  const frame = createFrame()
  frame.window.dispatchEvent({
    type: 'message',
    source: frame.parent,
    data: {
      type: 'agent-rp-card-context',
      id: 'frame-test',
      context: {
        chat: [{ message_id: 0, role: 'assistant', message: '原始正文' }],
      },
    },
  })

  const displayed = frame.window.retrieveDisplayedMessage(0)
  assert.equal(displayed.length, 1)
  assert.equal(displayed.text(), '原始正文')
  displayed.html('<strong>临时显示</strong>')
  let request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'displayed-message-mutation')
  assert.deepEqual(plain(request?.payload), {
    messageId: 0,
    operation: 'html',
    value: '<strong>临时显示</strong>',
  })

  const formatted = await frame.window.formatAsDisplayedMessage('{{char}}', { message_id: 0 })
  assert.equal(formatted, '<p>formatted</p>')
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'format-as-displayed-message')
  assert.deepEqual(plain(request?.payload), { text: '{{char}}', messageId: 0 })

  await frame.window.refreshOneMessage(0, displayed)
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'refresh-one-message')
  assert.deepEqual(plain(request?.payload), { messageId: 0, targetMessageId: 0 })
  assert.equal(typeof frame.window.TavernHelper.retrieveDisplayedMessage, 'function')
  assert.equal(typeof frame.window.TavernHelper.formatAsDisplayedMessage, 'function')
  assert.equal(typeof frame.window.TavernHelper.refreshOneMessage, 'function')
})

test('host lifecycle events cross the iframe bridge with SillyTavern names and arguments', () => {
  const frame = createFrame()
  const seen = []
  frame.window.eventOn('message_sent', (...args) => seen.push(['sent', ...args]))
  frame.window.eventOnce('generation_started', (...args) => seen.push(['started', ...args]))

  frame.window.dispatchEvent({
    type: 'message',
    source: frame.parent,
    data: {
      type: 'agent-rp-card-host-event',
      id: 'frame-test',
      eventName: 'message_sent',
      args: [3],
    },
  })
  frame.window.dispatchEvent({
    type: 'message',
    source: frame.parent,
    data: {
      type: 'agent-rp-card-host-event',
      id: 'frame-test',
      eventName: 'generation_started',
      args: ['normal', { automatic_trigger: false }, false],
    },
  })

  assert.deepEqual(seen, [
    ['sent', 3],
    ['started', 'normal', { automatic_trigger: false }, false],
  ])
  assert.equal(frame.window.tavern_events.CHAT_CHANGED, 'chat_id_changed')
  assert.equal(frame.window.tavern_events.GENERATION_AFTER_COMMANDS, 'GENERATION_AFTER_COMMANDS')
})

test('event lifecycle waits for async listeners and exposes ST ordering controls', async () => {
  const frame = createFrame()
  const seen = []
  frame.window.eventMakeLast('ordered', () => seen.push('last'))
  frame.window.eventMakeFirst('ordered', async () => {
    seen.push('first-start')
    await Promise.resolve()
    seen.push('first-end')
  })
  frame.window.eventOnce('ordered', () => seen.push('once'))

  frame.window.dispatchEvent({
    type: 'message',
    source: frame.parent,
    data: {
      type: 'agent-rp-card-host-event',
      id: 'frame-test',
      eventName: 'ordered',
      eventRequestId: 'request-1',
      args: [],
    },
  })
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(seen, ['first-start', 'first-end', 'last', 'once'])
  assert.deepEqual(plain(messagesOf(frame, 'agent-rp-card-host-event-done').at(-1)), {
    type: 'agent-rp-card-host-event-done',
    id: 'frame-test',
    eventRequestId: 'request-1',
    ok: true,
  })

  const removed = () => seen.push('removed')
  const stop = frame.window.eventOn('ordered', removed)
  frame.window.eventRemoveListener('ordered', removed)
  stop.stop()
  await frame.window.eventEmit('ordered')
  assert.equal(seen.includes('removed'), false)
  frame.window.eventClearEvent('ordered')
  assert.equal(frame.window.tavern_events.WORLDINFO_SCAN_DONE, 'worldinfo_scan_done')
  assert.equal(frame.window.iframe_events.GENERATION_STARTED, 'js_generation_started')
})

test('event registration follows Tavern Helper dedupe, reorder and await semantics', async () => {
  const frame = createFrame()
  const deduped = []
  const handler = () => deduped.push('handler')
  frame.window.eventOn('dedupe', handler)
  frame.window.eventOn('dedupe', handler)
  await frame.window.eventEmitAndWait('dedupe')
  assert.deepEqual(deduped, ['handler'])

  const order = []
  const first = () => order.push('first')
  const second = () => order.push('second')
  frame.window.eventOn('reorder', first)
  frame.window.eventOn('reorder', second)
  frame.window.eventMakeFirst('reorder', second)
  await frame.window.TavernHelper.eventEmitAndWait('reorder')
  assert.deepEqual(order, ['second', 'first'])

  order.length = 0
  frame.window.eventMakeLast('reorder', second)
  await frame.window.SillyTavern.eventSource.emitAndWait('reorder')
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(frame.window.TavernHelper.eventEmitAndWait, frame.window.eventEmitAndWait)

  const once = []
  const onceHandler = () => once.push('once')
  frame.window.eventOnce('once', onceHandler)
  frame.window.eventOnce('once', onceHandler)
  await frame.window.eventEmitAndWait('once')
  await frame.window.eventEmitAndWait('once')
  assert.deepEqual(once, ['once'])
})

test('SillyTavern context projection updates chat, character and extension prompts', () => {
  const frame = createFrame()
  frame.window.dispatchEvent({
    type: 'message',
    source: frame.parent,
    data: {
      type: 'agent-rp-card-context',
      id: 'frame-test',
      context: {
        chat: [{ message_id: 0, name: '用户', is_user: true, is_system: false, mes: '你好' }],
        characters: [{ name: '角色', description: '设定' }],
        name1: '用户',
        name2: '角色',
        chatId: 'session-1',
        extensionPrompts: { injected: { value: '提示词', position: 1, depth: 0, scan: true, role: 0 } },
      },
    },
  })

  const context = frame.window.SillyTavern.getContext()
  assert.equal(context.chatId, 'session-1')
  assert.deepEqual(plain(context.chat), [{ message_id: 0, name: '用户', is_user: true, is_system: false, mes: '你好' }])
  assert.deepEqual(plain(context.characters), [{ name: '角色', description: '设定' }])
  assert.equal(context.name1, '用户')
  assert.equal(context.name2, '角色')
  assert.equal(context.extensionPrompts.injected.value, '提示词')
  assert.equal(frame.window.SillyTavern.chat[0].mes, '你好')
})

test('card frontend receives RawCharacter and Prompt Template character helpers before postMessage sync', async () => {
  const rawCharacter = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '莉娜',
      description: '掌握火焰的旅者',
      personality: '谨慎',
      extensions: { hud: { theme: 'violet' } },
      character_book: { entries: { '1': { content: '火焰' } } },
    },
  }
  const frame = createFrame({
    rawCharacter,
    characterData: rawCharacter.data,
    character: { ...rawCharacter.data, data: rawCharacter.data },
    characters: [{ ...rawCharacter.data, data: rawCharacter.data }],
    characterId: 0,
    name1: '玩家',
    name2: '莉娜',
  })

  assert.deepEqual(plain(frame.window.RawCharacter), rawCharacter)
  assert.equal(frame.window.SillyTavern.getContext().character.data.extensions.hud.theme, 'violet')
  assert.equal(frame.window.SillyTavern.getContext().character.data.character_book.entries['1'].content, '火焰')
  assert.equal((await frame.window.getCharData()).extensions.hud.theme, 'violet')
  assert.match(await frame.window.getchar('莉娜', '<%= name %>|<%= description %>'), /莉娜\|掌握火焰的旅者/u)
})

test('iframe exposes the official Tavern Helper builtin prompt default order', () => {
  const frame = createFrame()
  const expected = [
    'world_info_before', 'persona_description', 'char_description',
    'char_personality', 'scenario', 'world_info_after', 'dialogue_examples',
    'chat_history', 'user_input',
  ]

  assert.deepEqual(plain(frame.window.builtin_prompt_default_order), expected)
  assert.deepEqual(plain(frame.window.placeholder_prompt_default_order), expected)
  assert.deepEqual(plain(frame.window.TavernHelper.builtin_prompt_default_order), expected)
  assert.deepEqual(plain(frame.window.TavernHelper.placeholder_prompt_default_order), expected)
  assert.deepEqual(plain(frame.window.SillyTavern.builtin_prompt_default_order), expected)
  assert.deepEqual(plain(frame.window.SillyTavern.placeholder_prompt_default_order), expected)
})

test('Tavern Helper generateRaw uses the isolated host RPC without changing chat', async () => {
  const frame = createFrame()
  await frame.window.generateRaw({ ordered_prompts: [{ role: 'user', content: '辅助问题' }] })
  const request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'generate-raw')
  assert.deepEqual(plain(request?.payload), {
    ordered_prompts: [{ role: 'user', content: '辅助问题' }],
    generation_id: 'frame-test-generation-1',
  })
  assert.equal(frame.window.getChatMessages('0-').length, 0)
  assert.equal(frame.window.TavernHelper.generateRaw, frame.window.generateRaw)
  assert.equal(frame.window.SillyTavern.generateRaw, frame.window.generateRaw)
})

test('Tavern Helper generate supplies the official default placeholder order', async () => {
  const frame = createFrame()
  await frame.window.generate({ user_input: '普通生成' })
  const request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'generate-raw')
  assert.deepEqual(plain(request?.payload), {
    user_input: '普通生成',
    ordered_prompts: [
      'world_info_before', 'persona_description', 'char_description',
      'char_personality', 'scenario', 'world_info_after', 'dialogue_examples',
      'chat_history', 'user_input',
    ],
    generation_id: 'frame-test-generation-1',
  })
  assert.notEqual(frame.window.TavernHelper.generate, frame.window.generateRaw)
  assert.equal(frame.window.TavernHelper.generate, frame.window.generate)
})

test('Tavern Helper model discovery and generation stop use the host bridge', async () => {
  const frame = createFrame()
  assert.deepEqual(plain(await frame.window.getModelList({ apiurl: 'https://example.com/v1', key: 'secret' })), [])
  let request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'get-model-list')
  assert.deepEqual(plain(request?.payload), {
    custom_api: { apiurl: 'https://example.com/v1', key: 'secret' },
  })
  assert.deepEqual(plain(frame.window.getProxyPresetNames()), [])

  const pending = frame.window.generateRaw({ user_input: '需要停止' })
  assert.equal(frame.window.stopGenerationById('frame-test-generation-1'), true)
  request = messagesOf(frame, 'agent-rp-card-rpc').at(-1)
  assert.equal(request?.method, 'stop-generation')
  assert.deepEqual(plain(request?.payload), { generation_id: 'frame-test-generation-1' })
  await assert.rejects(pending, /generation stopped/u)
})

test('function-valued injection filters are evaluated at generation preparation', async () => {
  const frame = createFrame()
  frame.window.__agentRpCurrentScriptId = 'script-filter'
  let allowed = false
  let seenPrompt = null
  frame.window.injectPrompts([{
    id: 'filter-prompt',
    position: 'in_chat',
    depth: 0,
    role: 'system',
    content: 'FILTERED',
    filter: async prompt => { seenPrompt = prompt; return allowed },
  }])

  frame.window.dispatchEvent({
    type: 'message',
    source: frame.parent,
    data: { type: 'agent-rp-card-prepare-generation', id: 'frame-test' },
  })
  await new Promise(resolve => setImmediate(resolve))
  let result = messagesOf(frame, 'agent-rp-card-injection-filter-result').at(-1)
  assert.deepEqual(plain(result?.filters), [{ scriptId: 'script-filter', promptId: 'filter-prompt', enabled: false }])
  assert.deepEqual(plain(seenPrompt), {
    id: 'filter-prompt', position: 'in_chat', depth: 0, role: 'system', content: 'FILTERED',
  })

  allowed = true
  frame.window.dispatchEvent({
    type: 'message',
    source: frame.parent,
    data: { type: 'agent-rp-card-prepare-generation', id: 'frame-test' },
  })
  await new Promise(resolve => setImmediate(resolve))
  result = messagesOf(frame, 'agent-rp-card-injection-filter-result').at(-1)
  assert.deepEqual(plain(result?.filters), [{ scriptId: 'script-filter', promptId: 'filter-prompt', enabled: true }])
})
