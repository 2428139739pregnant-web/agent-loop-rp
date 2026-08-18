import assert from 'node:assert/strict'
import test from 'node:test'
import { compileCharacterDisplay } from './card-display-compiler.ts'

test('recognizes fenced HTML even when the fence language is text', () => {
  const result = compileCharacterDisplay('前置\n```text\n<!doctype html><html><body><h2>HUD</h2></body></html>\n```\n后置')
  assert.deepEqual(result.segments.map(segment => segment.kind), ['markdown', 'html', 'markdown'])
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'frontend-document'), true)
})

test('keeps ordinary markdown separate and identifies inline HTML', () => {
  const markdown = compileCharacterDisplay('**正文**\n\n- 一\n- 二')
  assert.deepEqual(markdown.segments, [{ kind: 'markdown', text: '**正文**\n\n- 一\n- 二' }])

  const inline = compileCharacterDisplay('正文 <span class="badge">状态</span>')
  assert.equal(inline.segments[0]?.kind, 'inline-html')
  assert.equal(inline.diagnostics.some(diagnostic => diagnostic.code === 'inline-html'), true)
})

test('isolates an un-fenced card fragment before a fenced frontend document', () => {
  const result = compileCharacterDisplay([
    '<div class="card-shell"><h1>开场白</h1><p>正文</p></div>',
    '```html',
    '<!doctype html><html><body><div id="status">状态栏</div></body></html>',
    '```',
  ].join('\n'))
  assert.deepEqual(result.segments.map(segment => segment.kind), ['html', 'html'])
})

test('removes unknown display wrappers without touching fenced code', () => {
  const result = compileCharacterDisplay('<custom-wrapper>正文</custom-wrapper>\n\n```js\n<custom-wrapper>代码</custom-wrapper>\n```')
  assert.match(result.segments[0]?.kind === 'markdown' ? result.segments[0].text : '', /正文/u)
  assert.equal(result.diagnostics.some(diagnostic => diagnostic.code === 'unknown-wrapper-removed'), true)
  const last = result.segments.at(-1)
  assert.equal(last?.kind, 'markdown')
  if (last?.kind === 'markdown') assert.match(last.text, /custom-wrapper/u)
})
