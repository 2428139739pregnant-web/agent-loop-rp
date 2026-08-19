import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ImportedCharacterFrontend } from './import/types.ts'
import {
  applyTavernHelperMutation,
  consumeTavernInjectedPromptsAfterGeneration,
  getScriptTrees,
  injectPrompts,
  initializeTavernHelperState,
  parseTavernHelperMutationRequest,
  replaceScriptTrees,
  selectTavernInjectedPrompts,
  selectTavernInjectedPromptsAsync,
  tavernInjectedInChatPrompts,
  tavernInjectedScanText,
  uninjectPrompts,
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

test('once consumption does not delete a newer replacement with the same id', () => {
  const state = initializeTavernHelperState(frontend([scriptTree('script')]), 'character')
  const original = injectPrompts(state, 'script', [injection('same', { once: true, content: 'old' })])
  const selection = selectTavernInjectedPrompts(original)
  const replacement = injectPrompts(original, 'script', [injection('same', { once: true, content: 'new' })])

  const after = consumeTavernInjectedPromptsAfterGeneration(replacement, selection)
  assert.equal(after?.injectedPrompts?.[0]?.content, 'new')
})
