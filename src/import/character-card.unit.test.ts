import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCharacterCardJson } from './character-card.ts'

function cardWithScripts(scripts: readonly unknown[]): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '脚本树测试卡',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '你好',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      creator_notes: '',
      creator: 'unit-test',
      character_version: '1',
      tags: [],
      extensions: {
        tavern_helper: { scripts },
      },
    },
  })
}

function cardWithLorebook(entries: readonly unknown[], recursiveScanning = true): string {
  return JSON.stringify({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '世界书递归字段测试卡',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '你好',
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      creator_notes: '',
      creator: 'unit-test',
      character_version: '1',
      tags: [],
      extensions: {},
      character_book: {
        name: '递归测试书',
        recursive_scanning: recursiveScanning,
        entries,
      },
    },
  })
}

test('character import preserves the Tavern Helper tree and applies folder enablement to flat scripts', () => {
  const card = parseCharacterCardJson(cardWithScripts([
    {
      type: 'folder',
      id: 'disabled-folder',
      name: '禁用文件夹',
      enabled: false,
      scripts: [{
        type: 'script', id: 'child', name: '子脚本', enabled: true, content: 'child',
      }],
    },
    {
      type: 'folder',
      id: 'enabled-folder',
      name: '启用文件夹',
      enabled: true,
      scripts: [{
        type: 'script', id: 'enabled-child', name: '启用子脚本', enabled: true, content: 'enabled',
      }, {
        type: 'script', id: 'disabled-child', name: '禁用子脚本', enabled: false, content: 'disabled',
      }],
    },
  ]))

  const trees = card.frontend.tavernHelperScriptTrees ?? []
  assert.deepEqual(trees.map(tree => [tree.type, tree.id]), [
    ['folder', 'disabled-folder'],
    ['folder', 'enabled-folder'],
  ])
  assert.equal(card.frontend.tavernHelperScripts.find(script => script.id === 'child')?.enabled, false)
  assert.equal(card.frontend.tavernHelperScripts.find(script => script.id === 'enabled-child')?.enabled, true)
  assert.equal(card.frontend.tavernHelperScripts.find(script => script.id === 'disabled-child')?.enabled, false)
})

test('character import preserves ST recursion controls from extensions and legacy top-level fields', () => {
  const card = parseCharacterCardJson(cardWithLorebook([
    {
      id: 'extension-flags',
      name: '扩展字段',
      comment: '',
      keys: ['扩展'],
      secondary_keys: [],
      content: 'extension',
      enabled: true,
      selective: false,
      constant: false,
      case_sensitive: false,
      match_whole_words: false,
      position: 'after_char',
      insertion_order: 1,
      extensions: {
        exclude_recursion: true,
        prevent_recursion: true,
        delay_until_recursion: 2,
      },
    },
    {
      id: 'legacy-flags',
      name: '兼容字段',
      comment: '',
      keys: ['兼容'],
      secondary_keys: [],
      content: 'legacy',
      enabled: true,
      selective: false,
      constant: false,
      case_sensitive: false,
      match_whole_words: false,
      position: 'after_char',
      insertion_order: 2,
      extensions: {},
      exclude_recursion: true,
      prevent_recursion: false,
      delay_until_recursion: true,
    },
  ]))

  assert.equal(card.lorebook?.recursiveScanning, true)
  assert.deepEqual(card.lorebook?.entries.map(entry => ({
    excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion,
    delayUntilRecursion: entry.delayUntilRecursion,
  })), [
    { excludeRecursion: true, preventRecursion: true, delayUntilRecursion: 2 },
    { excludeRecursion: true, preventRecursion: false, delayUntilRecursion: true },
  ])
})
