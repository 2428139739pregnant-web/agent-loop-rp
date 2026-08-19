import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRegexScripts, runRegexScript, type RegexScript } from './regex-scripts.ts'

const macros = { user: '小明', char: '莉娜' }

function script(overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id: 'regex-test',
    scriptName: 'test',
    findRegex: 'x',
    replaceString: 'y',
    trimStrings: [],
    placement: ['ai_output'],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('global regex honors ST min/max depth and runOnEdit gates', () => {
  const limited = script({ minDepth: 1, maxDepth: 2 })
  assert.equal(runRegexScript(limited, 'x', macros, { depth: 0 }), 'x')
  assert.equal(runRegexScript(limited, 'x', macros, { depth: 1 }), 'y')
  assert.equal(runRegexScript(limited, 'x', macros, { depth: 3 }), 'x')
  assert.equal(runRegexScript(limited, 'x', macros, { depth: 1, isEdit: true }), 'x')
  assert.equal(runRegexScript({ ...limited, runOnEdit: true }, 'x', macros, { depth: 1, isEdit: true }), 'y')
})

test('global regex applies promptOnly/markdownOnly on the matching surface', () => {
  const promptOnly = script({ promptOnly: true })
  const markdownOnly = script({ markdownOnly: true })
  assert.equal(applyRegexScripts([promptOnly], 'x', 'ai_output', macros, { surface: 'prompt' }), 'y')
  assert.equal(applyRegexScripts([promptOnly], 'x', 'ai_output', macros, { surface: 'display' }), 'x')
  assert.equal(applyRegexScripts([markdownOnly], 'x', 'ai_output', macros, { surface: 'prompt' }), 'x')
  assert.equal(applyRegexScripts([markdownOnly], 'x', 'ai_output', macros, { surface: 'display' }), 'y')
})

test('global regex supports raw and escaped find macros like ST', () => {
  const raw = script({ findRegex: '{{char}}', replaceString: 'ok', substituteRegex: 1 })
  const escaped = script({ findRegex: '{{char}}', replaceString: 'ok', substituteRegex: 2 })
  assert.equal(runRegexScript(raw, '莉娜', macros), 'ok')
  assert.equal(runRegexScript(escaped, '莉娜', macros), 'ok')
  assert.equal(runRegexScript(script({ findRegex: '{{char}}', replaceString: '{{user}}' }), '莉娜', macros), '莉娜')
})

test('global regex accepts modern flags and JavaScript replacement tokens', () => {
  assert.equal(runRegexScript(script({ findRegex: '/foo/d', replaceString: '$&|$1|$$|$`|$\'' }), 'foo', macros), 'foo||$||')
  assert.equal(runRegexScript(script({ findRegex: '(foo)', replaceString: '$1' }), 'foo', macros), 'foo')
})
