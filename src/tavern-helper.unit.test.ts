import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ImportedCharacterFrontend } from './import/types.ts'
import {
  applyTavernHelperMutation,
  applyTavernInjectedInChatPrompts,
  consumeTavernInjectedPromptsAfterGeneration,
  getScriptTrees,
  injectPrompts,
  initializeTavernHelperState,
  parseTavernHelperMutationRequest,
  replaceScriptTrees,
  selectTavernInjectedPrompts,
  selectTavernInjectedPromptsAsync,
  tavernInjectedPromptContent,
  tavernInjectedInChatPrompts,
  tavernInjectedScanText,
  uninjectPrompts,
  updateTavernInjectedPromptFilters,
  type TavernInjectedPromptInput,
  updateScriptTreesWith,
  type TavernScriptTree,
} from './tavern-helper.ts'

function scriptTree(id: string, enabled = true): TavernScriptTree {
  return {
    type: 'script',
    enabled,
    name: id,
    id,
    content: `// ${id}`,
    info: '',
    button: { enabled: true, buttons: [] },
    data: { value: id },
    export_with: { data: true, button: true },
  }
}

function folder(id: string, enabled: boolean, scripts: readonly TavernScriptTree[]): TavernScriptTree {
  return {
    type: 'folder',
    enabled,
    name: id,
    id,
    icon: 'fa-solid fa-folder',
    color: '',
    scripts,
  }
}

function frontend(trees: readonly TavernScriptTree[]): ImportedCharacterFrontend {
  const activeScripts = (nodes: readonly TavernScriptTree[], parentEnabled = true): TavernScriptTree[] => nodes.flatMap(tree => {
    const enabled = parentEnabled && tree.enabled
    if (tree.type === 'folder') return activeScripts(tree.scripts, enabled)
    return [{ ...tree, enabled }]
  })
  const scripts = activeScripts(trees)
    .filter((tree): tree is Extract<TavernScriptTree, { type: 'script' }> => tree.type === 'script')
    .map(tree => ({
      id: tree.id,
      name: tree.name,
      content: tree.content,
      info: tree.info,
      enabled: tree.enabled,
      buttonEnabled: tree.button.enabled,
      buttons: tree.button.buttons,
      data: tree.data,
    }))
  return {
    regexScripts: [],
    tavernHelperScriptNames: scripts.filter(script => script.enabled).map(script => script.name),
    tavernHelperScripts: scripts,
    tavernHelperScriptTrees: trees,
    tavernHelperVariables: {},
  }
}

function injection(id: string, overrides: Partial<TavernInjectedPromptInput> = {}): TavernInjectedPromptInput {
  return {
    id,
    position: 'in_chat',
    depth: 0,
    role: 'system',
    content: id,
    shouldScan: false,
    order: 100,
    ...overrides,
  }
}

test('disabled parent folders prevent child scripts from entering the active state', () => {
  const trees = [folder('disabled-folder', false, [scriptTree('child')])] as const
  const state = initializeTavernHelperState(frontend(trees), 'character')

  assert.deepEqual(state.scripts, {})
  assert.equal(getScriptTrees(state, { type: 'character' })[0]?.type, 'folder')
  assert.equal((getScriptTrees(state, { type: 'character' })[0] as Extract<TavernScriptTree, { type: 'folder' }>).enabled, false)
})

test('replacing a script tree keeps disabled descendants visible but inactive', () => {
  const state = initializeTavernHelperState(frontend([scriptTree('old')]), 'character')
  const replaced = replaceScriptTrees(state, [folder('disabled-folder', false, [scriptTree('child')])], { type: 'character' })

  assert.deepEqual(replaced.scripts, {})
  const trees = getScriptTrees(replaced, { type: 'character' })
  assert.equal(trees.length, 1)
  assert.equal(trees[0]?.type, 'folder')
  assert.equal((trees[0] as Extract<TavernScriptTree, { type: 'folder' }>).scripts[0]?.id, 'child')
})

test('updateScriptTreesWith supports synchronous and asynchronous updates', async () => {
  const state = initializeTavernHelperState(frontend([scriptTree('one')]), 'character')
  const sync = updateScriptTreesWith(state, trees => [...trees, scriptTree('two')], { type: 'character' })
  assert.ok(!(sync instanceof Promise))
  assert.deepEqual(getScriptTrees(sync, { type: 'character' }).map(tree => tree.id), ['one', 'two'])

  const asyncState = await updateScriptTreesWith(sync, async trees => [...trees, scriptTree('three')], { type: 'character' })
  assert.deepEqual(getScriptTrees(asyncState, { type: 'character' }).map(tree => tree.id), ['one', 'two', 'three'])
})

test('extension variables are isolated by the official extension_id option', () => {
  const state = initializeTavernHelperState(frontend([]), 'character')
  const request = parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    scope: 'extension',
    extension_id: 'prompt-template',
    variables: { enabled: true },
  }))
  const updated = applyTavernHelperMutation(state, request)

  assert.deepEqual(updated.scopes.extension, { 'prompt-template': { enabled: true } })
  assert.throws(() => parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    scope: 'extension',
    variables: {},
  })), /extension_id/)
})

test('chat metadata follows SillyTavern updateChatMetadata merge and reset semantics', () => {
  const state = initializeTavernHelperState(frontend([]), 'character')
  assert.deepEqual(state.chatMetadata, {})

  const merge = parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'update-chat-metadata',
    values: { scene: '雨夜', turn: 1 },
  }))
  const merged = applyTavernHelperMutation({ ...state, chatMetadata: { keep: true } }, merge)
  assert.deepEqual(merged.chatMetadata, { keep: true, scene: '雨夜', turn: 1 })

  const reset = parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'update-chat-metadata',
    values: { scene: '白天' },
    reset: true,
  }))
  const resetState = applyTavernHelperMutation(merged, reset)
  assert.deepEqual(resetState.chatMetadata, { scene: '白天' })
  assert.throws(() => parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'update-chat-metadata',
    values: {},
    reset: 'yes',
  })), /reset must be a boolean/)
})

test('chat mutations preserve canonical refresh modes through parsing', () => {
  const cases = [
    ['update-chat-metadata', { values: {} }, 'none'],
    ['set-chat-messages', { messages: [{ message_id: 0, message: 'updated' }] }, 'affected'],
    ['create-chat-messages', { messages: [{ role: 'assistant', message: 'inserted' }] }, 'all'],
    ['delete-chat-messages', { messageIds: [0] }, 'none'],
    ['rotate-chat-messages', { begin: 0, middle: 1, end: 2 }, 'affected'],
    ['set-chat-hidden', { start: 0, end: 1, hidden: true }, 'all'],
  ] as const

  for (const [operation, fields, refresh] of cases) {
    const parsed = parseTavernHelperMutationRequest(JSON.stringify({
      format: 0,
      operation,
      ...fields,
      refresh,
    }))
    assert.ok('operation' in parsed)
    assert.equal(parsed.operation, operation)
    assert.equal(parsed.refresh, refresh)
  }

  const legacyBoolean = parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'delete-chat-messages',
    messageIds: [0],
    options: { refresh: true },
  }))
  assert.ok('operation' in legacyBoolean)
  assert.equal('refresh' in legacyBoolean ? legacyBoolean.refresh : undefined, 'affected')

  const directValueWins = parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'delete-chat-messages',
    messageIds: [0],
    refresh: 'none',
    options: { refresh: 'all' },
  }))
  assert.ok('operation' in directValueWins)
  assert.equal('refresh' in directValueWins ? directValueWins.refresh : undefined, 'none')

  const withoutRefresh = parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'delete-chat-messages',
    messageIds: [0],
  }))
  assert.ok('operation' in withoutRefresh)
  assert.equal('refresh' in withoutRefresh ? withoutRefresh.refresh : undefined, 'affected')

  assert.throws(() => parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'delete-chat-messages',
    messageIds: [0],
    refresh: 'sometimes',
  })), /refresh must be none, affected, or all/)
})

test('extension prompt anchors preserve ST before/in/none positions', () => {
  const state = initializeTavernHelperState(frontend([scriptTree('script-a')]), 'character')
  const request = parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'inject-prompts',
    scriptId: 'script-a',
    prompts: [
      { id: 'before', position: 'before_prompt', depth: 0, role: 'system', content: 'BEFORE' },
      { id: 'inside', position: 'in_prompt', depth: 0, role: 'system', content: 'IN' },
      { id: 'none', position: 'none', depth: 0, role: 'system', content: 'SCAN', should_scan: true },
    ],
  }))
  const updated = applyTavernHelperMutation(state, request)

  assert.equal(tavernInjectedPromptContent(updated, 'before_prompt'), 'BEFORE')
  assert.equal(tavernInjectedPromptContent(updated, 'in_prompt'), 'IN')
  assert.deepEqual(tavernInjectedInChatPrompts(updated), [])
  assert.deepEqual(tavernInjectedScanText(updated), ['SCAN'])
})

test('injectPrompts supports the official fields and call-level once option', () => {
  const state = initializeTavernHelperState(frontend([scriptTree('script')]), 'character')
  const request = parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'inject-prompts',
    scriptId: 'script',
    once: true,
    prompts: [{
      id: 'official-fields',
      position: 'none',
      depth: 3,
      role: 'assistant',
      content: 'scan me',
      should_scan: true,
      order: 7,
      filter: false,
    }],
  }))
  const updated = applyTavernHelperMutation(state, request)
  assert.deepEqual(updated.injectedPrompts, [{
    id: 'official-fields',
    scriptId: 'script',
    position: 'none',
    depth: 3,
    role: 'assistant',
    content: 'scan me',
    shouldScan: true,
    once: true,
    order: 7,
    filter: false,
  }])
})

test('inject and uninject preserve unrelated prompts and replace duplicate ids', () => {
  const state = initializeTavernHelperState(frontend([scriptTree('one'), scriptTree('two')]), 'character')
  const first = injectPrompts(state, 'one', [injection('shared'), injection('keep')])
  const replaced = injectPrompts(first, 'two', [injection('shared', { content: 'new', order: 2 })])

  assert.deepEqual(replaced.injectedPrompts?.map(prompt => [prompt.id, prompt.scriptId, prompt.content]), [
    ['keep', 'one', 'keep'],
    ['shared', 'two', 'new'],
  ])
  const removed = uninjectPrompts(replaced, ['shared'])
  assert.deepEqual(removed.injectedPrompts?.map(prompt => prompt.id), ['keep'])
  assert.equal(uninjectPrompts(removed, ['missing']), removed)
})

test('generation filter snapshots update only the owning injected prompt', () => {
  const state = initializeTavernHelperState(frontend([scriptTree('one'), scriptTree('two')]), 'character')
  const injected = injectPrompts(state, 'one', [
    injection('visible'),
    injection('other-owner'),
  ])
  const withOwner = injectPrompts(injected, 'two', [injection('same-id', { content: 'two' })])
  const updated = updateTavernInjectedPromptFilters(withOwner, [
    { scriptId: 'one', promptId: 'visible', enabled: false },
    { scriptId: 'two', promptId: 'same-id', enabled: true },
  ])
  assert.equal(updated.injectedPrompts?.find(prompt => prompt.id === 'visible')?.filter, false)
  assert.equal(updated.injectedPrompts?.find(prompt => prompt.id === 'same-id')?.filter, true)
  assert.equal(updated.injectedPrompts?.find(prompt => prompt.id === 'other-owner')?.filter, undefined)

  const request = parseTavernHelperMutationRequest(JSON.stringify({
    format: 0,
    operation: 'update-injection-filters',
    filters: [{ scriptId: 'one', promptId: 'visible', enabled: true }],
  }))
  const parsedUpdated = applyTavernHelperMutation(updated, request)
  assert.equal(parsedUpdated.injectedPrompts?.find(prompt => prompt.id === 'visible')?.filter, true)
})

test('generation selection filters, sorts, scans none prompts, and consumes only selected once prompts', async () => {
  const state = initializeTavernHelperState(frontend([scriptTree('script')]), 'character')
  const injected = injectPrompts(state, 'script', [
    injection('persistent', { order: 20, content: 'persistent' }),
    injection('once', { order: 10, once: true, content: 'once', shouldScan: true }),
    injection('none', { order: 5, position: 'none', once: true, content: 'none', shouldScan: true }),
    injection('blocked', { filter: false, content: 'blocked', shouldScan: true }),
  ])

  const selected = selectTavernInjectedPrompts(injected, { filter: prompt => prompt.id !== 'none' })
  assert.deepEqual(selected.prompts.map(prompt => prompt.id), ['once', 'persistent'])
  assert.deepEqual(selected.oncePrompts.map(prompt => prompt.id), ['once'])
  assert.deepEqual(tavernInjectedInChatPrompts(injected).map(prompt => prompt.order), [10, 20])
  assert.deepEqual(tavernInjectedScanText(injected), ['none', 'once'])

  const asyncSelected = await selectTavernInjectedPromptsAsync(injected, {
    filter: async prompt => prompt.id !== 'persistent',
  })
  assert.deepEqual(asyncSelected.prompts.map(prompt => prompt.id), ['none', 'once'])
  assert.deepEqual(asyncSelected.oncePrompts.map(prompt => prompt.id), ['none', 'once'])

  const consumed = consumeTavernInjectedPromptsAfterGeneration(injected, selected)
  assert.deepEqual(consumed?.injectedPrompts?.map(prompt => prompt.id), ['persistent', 'none', 'blocked'])
})

test('in_chat prompts use ST depth and role ordering while none prompts stay scan-only', () => {
  const state = initializeTavernHelperState(frontend([scriptTree('script')]), 'character')
  const injected = injectPrompts(state, 'script', [
    injection('depth-0-user', { role: 'user', depth: 0, order: 20, content: 'U0' }),
    injection('depth-0-system', { role: 'system', depth: 0, order: 10, content: 'S0' }),
    injection('depth-1-assistant', { role: 'assistant', depth: 1, order: 30, content: 'A1' }),
    injection('scan-only', { position: 'none', depth: 0, shouldScan: true, content: 'SCAN' }),
  ])
  const messages = applyTavernInjectedInChatPrompts([
    { role: 'system', content: 'base system' },
    { role: 'user', content: 'latest user' },
  ], injected)
  assert.deepEqual(messages.map(message => `${message.role}:${message.content}`), [
    'system:base system',
    'assistant:A1',
    'user:latest user',
    'system:S0',
    'user:U0',
  ])
  assert.ok(messages.every(message => !message.content.includes('SCAN')))
})

test('once consumption does not delete a newer replacement with the same id', () => {
  const state = initializeTavernHelperState(frontend([scriptTree('script')]), 'character')
  const original = injectPrompts(state, 'script', [injection('same', { once: true, content: 'old' })])
  const selection = selectTavernInjectedPrompts(original)
  const replacement = injectPrompts(original, 'script', [injection('same', { once: true, content: 'new' })])

  const after = consumeTavernInjectedPromptsAfterGeneration(replacement, selection)
  assert.equal(after?.injectedPrompts?.[0]?.content, 'new')
})
