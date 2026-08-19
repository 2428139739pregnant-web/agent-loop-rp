import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EjsTemplateEngine } from './ejs-template.ts'

test('EJS getwi reads the active card/imported worldbook projection', async () => {
  const engine = await EjsTemplateEngine.create()
  const result = engine.render(
    '<%= await getwi("魔法") %>|<%= await getwi("external", "外部条目") %>',
    {
      characterName: '莉娜',
      userName: '小明',
      messages: [],
      transcript: [],
      worldInfoBooks: [
        {
          id: 'character:莉娜',
          name: '莉娜',
          entries: [{ sourceId: '1', name: '魔法', content: '火焰在掌心燃起' }],
        },
        {
          id: 'worldbook:external',
          name: 'external',
          entries: [{ sourceId: '2', name: '外部条目', content: '来自外部世界书' }],
        },
      ],
    },
  )
  assert.deepEqual(result, { ok: true, text: '火焰在掌心燃起|来自外部世界书' })

  const sameBook = engine.render('<%= await getwi("魔法") %>', {
    characterName: '莉娜',
    userName: '小明',
    messages: [],
    worldInfoBooks: [{
      id: 'character:莉娜',
      name: '莉娜',
      entries: [{ sourceId: '1', name: '魔法', content: '火焰在掌心燃起' }],
    }],
  }, { worldInfoBookId: 'character:莉娜/1' })
  assert.deepEqual(sameBook, { ok: true, text: '火焰在掌心燃起' })
})

test('EJS exposes Prompt Template initial variables as a separate scope', async () => {
  const engine = await EjsTemplateEngine.create()
  const result = engine.render(
    '<%= variables.affinity %>|<%= getvar("affinity", "initial") %>',
    {
      characterName: '莉娜',
      userName: '小明',
      messages: [],
      variableScopes: { initial: { affinity: 42 } },
    },
  )
  assert.deepEqual(result, { ok: true, text: '42|42' })
})
