import assert from 'node:assert/strict'
import test from 'node:test'
import type { ImportedRegexScript } from './import/types.ts'
import {
  AI_OUTPUT_PLACEMENT,
  renderCharacterDisplay,
  renderCharacterPromptView,
  type RegexCharacter,
} from './frontend-regex.ts'
import { compileCharacterDisplay } from './card-display-compiler.ts'

function script(overrides: Partial<ImportedRegexScript> & Pick<ImportedRegexScript, 'findRegex'>): ImportedRegexScript {
  return {
    scriptName: 'test',
    replaceString: '',
    trimStrings: [],
    placement: [AI_OUTPUT_PLACEMENT],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    ...overrides,
  }
}

function card(regexScripts: readonly ImportedRegexScript[]): RegexCharacter {
  return {
    name: '莉娜',
    nickname: '晓',
    frontend: {
      regexScripts,
      tavernHelperScriptNames: [],
      tavernHelperScripts: [],
      tavernHelperVariables: {},
    },
  }
}

test('normal character regex is shared by display and prompt views', () => {
  const current = card([script({ findRegex: '原文', replaceString: '改写' })])
  assert.equal(renderCharacterDisplay('原文', current, AI_OUTPUT_PLACEMENT), '改写')
  assert.equal(renderCharacterPromptView('原文', current, AI_OUTPUT_PLACEMENT), '改写')
})

test('markdownOnly and promptOnly scripts stay on their own surface', () => {
  const display = card([script({ findRegex: 'STATUS', replaceString: '<b>状态</b>', markdownOnly: true })])
  assert.equal(renderCharacterDisplay('STATUS', display, AI_OUTPUT_PLACEMENT), '<b>状态</b>')
  assert.equal(renderCharacterPromptView('STATUS', display, AI_OUTPUT_PLACEMENT), 'STATUS')

  const prompt = card([script({ findRegex: 'STATUS', replaceString: 'PROMPT', promptOnly: true })])
  assert.equal(renderCharacterDisplay('STATUS', prompt, AI_OUTPUT_PLACEMENT), 'STATUS')
  assert.equal(renderCharacterPromptView('STATUS', prompt, AI_OUTPUT_PLACEMENT), 'PROMPT')

  const both = card([script({ findRegex: 'STATUS', replaceString: 'BOTH', markdownOnly: true, promptOnly: true })])
  assert.equal(renderCharacterDisplay('STATUS', both, AI_OUTPUT_PLACEMENT), 'BOTH')
  assert.equal(renderCharacterPromptView('STATUS', both, AI_OUTPUT_PLACEMENT), 'BOTH')
})

test('scripts respect placement, depth, macros and trimStrings', () => {
  const depthLimited = card([script({ findRegex: 'x', replaceString: 'y', minDepth: 1, maxDepth: 2 })])
  assert.equal(renderCharacterDisplay('x', depthLimited, AI_OUTPUT_PLACEMENT, 0), 'x')
  assert.equal(renderCharacterDisplay('x', depthLimited, AI_OUTPUT_PLACEMENT, 1), 'y')
  assert.equal(renderCharacterDisplay('x', depthLimited, AI_OUTPUT_PLACEMENT, 3), 'x')

  const userOnly = card([script({ findRegex: 'x', replaceString: 'y', placement: [1] })])
  assert.equal(renderCharacterDisplay('x', userOnly, AI_OUTPUT_PLACEMENT), 'x')

  const macros = card([script({
    findRegex: '{{char}}', replaceString: '{{user}}', substituteRegex: 1, trimStrings: ['o'],
  })])
  assert.equal(renderCharacterPromptView('晓', macros, AI_OUTPUT_PLACEMENT, undefined, '艾云浮'), '艾云浮')

  const captures = card([script({ findRegex: '(foo)', replaceString: '$1', trimStrings: ['o'] })])
  assert.equal(renderCharacterPromptView('foo', captures, AI_OUTPUT_PLACEMENT), 'f')
})

test('normal placeholder and markdownOnly expansion preserve card frontend HTML', () => {
  const current = card([
    script({
      scriptName: 'placeholder',
      findRegex: '^(?!<DGFZSM>)',
      replaceString: '<DGFZSM>\n',
      markdownOnly: true,
    }),
    script({
      scriptName: 'frontend',
      findRegex: '<DGFZSM>',
      replaceString: '```html\n<!doctype html><html><body><div id="hud">状态栏</div></body></html>\n```',
      markdownOnly: true,
    }),
  ])
  const display = renderCharacterDisplay('正文', current, AI_OUTPUT_PLACEMENT)
  assert.match(display, /<!doctype html>/iu)
  assert.equal(compileCharacterDisplay(display).segments.some(segment => segment.kind === 'html'), true)
  assert.equal(renderCharacterPromptView('正文', current, AI_OUTPUT_PLACEMENT), '正文')
})

test('prompt-only status placeholders are removed before the model sees them', () => {
  const current = card([script({
    scriptName: 'hide-status-from-prompt',
    findRegex: '<StatusPlaceHolderImpl/>',
    replaceString: '',
    markdownOnly: true,
    promptOnly: true,
  })])
  const value = '<StatusPlaceHolderImpl/>\n正文'
  assert.equal(renderCharacterDisplay(value, current, AI_OUTPUT_PLACEMENT), '\n正文')
  assert.equal(renderCharacterPromptView(value, current, AI_OUTPUT_PLACEMENT), '\n正文')
})
