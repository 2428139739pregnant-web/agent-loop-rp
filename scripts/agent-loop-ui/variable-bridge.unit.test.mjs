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

function createFrame() {
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
          value: { ok: true },
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
  vm.runInContext(buildCardFrameRuntime('frame-test', { stat_data: { chat: true } }, {}, {}), context)
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
