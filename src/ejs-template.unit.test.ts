import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEjsTemplatePromptInjectionStore, EjsTemplateEngine } from './ejs-template.ts'

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

test('EJS character and preset getters read only JSON snapshots', async () => {
  const engine = await EjsTemplateEngine.create()
  const context = {
    characterName: '莉娜',
    userName: '小明',
    messages: [],
    variables: { affinity: 7 },
    characterData: {
      name: '莉娜',
      description: '掌握火焰的旅者',
      personality: '谨慎',
    },
    characterCards: [{
      id: 'other-card',
      name: '另一张卡',
      data: { name: '另一张卡', description: '备用角色' },
    }],
    presetPrompts: [{
      id: 'main-preset',
      name: '主提示词',
      content: '<%= name %>|<%= mood %>|<%= getvar("affinity") %>',
    }],
  } as const

  assert.deepEqual(
    engine.render('<%- JSON.stringify(await getCharData()) %>', context),
    { ok: true, text: '{"name":"莉娜","description":"掌握火焰的旅者","personality":"谨慎"}' },
  )
  const character = engine.render('<%- await getchar() %>', context)
  assert.equal(character.ok, true)
  if (character.ok) {
    assert.match(character.text, /<莉娜>/u)
    assert.match(character.text, /description: 掌握火焰的旅者/u)
  }
  assert.deepEqual(
    engine.render(
      "<% const format = '<' + '%' + '= name ' + '%' + '>:' + '<' + '%' + '= description ' + '%' + '>'; %><%- await getchar('other-card', format) %>",
      context,
    ),
    { ok: true, text: '另一张卡:备用角色' },
  )
  assert.deepEqual(
    engine.render('<%- await getpreset("主提示词", { mood: "calm" }) %>', context),
    { ok: true, text: '主提示词|calm|7' },
  )
  assert.deepEqual(
    engine.render('<%- await getPresetPrompt("主提示词", { mood: "quiet" }) %>', context),
    { ok: true, text: '主提示词|quiet|7' },
  )
})

test('EJS resource getters return stable empty results without resource snapshots', async () => {
  const engine = await EjsTemplateEngine.create()
  const result = engine.render(
    '<%- JSON.stringify(await getCharData()) %>|<%- await getchar() %>|<%- await getpreset("missing") %>',
    { characterName: '莉娜', userName: '小明', messages: [] },
  )
  assert.deepEqual(result, { ok: true, text: 'null||' })
})

test('EJS runType follows the explicit render target and defaults to generate', async () => {
  const engine = await EjsTemplateEngine.create()
  const context = { characterName: '莉娜', userName: '小明', messages: [] }
  assert.deepEqual(engine.render('<%= runType %>', context), { ok: true, text: 'generate' })
  assert.deepEqual(
    engine.render('<%= runType %>', context, { runType: 'render' }),
    { ok: true, text: 'render' },
  )
  assert.deepEqual(
    engine.render('<%= runType %>', context, { runType: 'preparation' }),
    { ok: true, text: 'preparation' },
  )
})

test('EJS Prompt Template injection is shared across renders in one generation', async () => {
  const engine = await EjsTemplateEngine.create()
  const promptInjections = createEjsTemplatePromptInjectionStore()
  const renderer = engine.createRenderer({
    characterName: '莉娜',
    userName: '小明',
    messages: [],
    promptInjections,
  })

  assert.deepEqual(
    renderer('<% injectPrompt("CoT", "第二条", 20); injectPrompt("CoT", "第一条", 10); %>'),
    { ok: true, text: '' },
  )
  assert.deepEqual(
    renderer('<%= hasPromptsInjected("CoT") %>|<%- getPromptsInjected("CoT") %>'),
    { ok: true, text: 'true|第一条\n第二条' },
  )
  assert.deepEqual(
    renderer('<%- getPromptsInjected("CoT", [{search:"第一条", replace:"替换"}]) %>'),
    { ok: true, text: '替换\n第二条' },
  )
})

test('EJS Prompt Template injection uid replaces the same entry', async () => {
  const engine = await EjsTemplateEngine.create()
  const promptInjections = createEjsTemplatePromptInjectionStore()
  const result = engine.render(
    '<% injectPrompt("status", "old", 1, 0, "stable"); injectPrompt("status", "new", 1, 0, "stable"); %><%= getPromptsInjected("status") %>',
    { characterName: '莉娜', userName: '小明', messages: [], promptInjections },
  )
  assert.deepEqual(result, { ok: true, text: 'new' })
})
