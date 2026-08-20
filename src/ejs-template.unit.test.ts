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
  }

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

test('EJS World Info helpers honor source filters and record same-generation activation', async () => {
  const engine = await EjsTemplateEngine.create()
  const activated = new Map<string, boolean>()
  const result = engine.render(
    `<% const all = await getEnabledWorldInfoEntries();
       const characterOnly = await getEnabledWorldInfoEntries(true, false, false, false);
       await activewi('global-book', 'Global entry');
       await activateWorldInfoByKeywords('magic'); %><%- JSON.stringify({
         all: all.map(entry => entry.comment),
         characterOnly: characterOnly.map(entry => entry.comment),
       }) %>`,
    {
      characterName: '莉娜',
      userName: '小明',
      messages: [],
      worldInfoBooks: [
        {
          id: 'character-book',
          name: 'character-book',
          sourceType: 'character',
          entries: [{ sourceId: '1', name: 'Character entry', data: { key: ['magic'], path: 'character-book/1' }, content: 'CHARACTER' }],
        },
        {
          id: 'global-book',
          name: 'global-book',
          sourceType: 'global',
          entries: [{ sourceId: '2', name: 'Global entry', data: { key: ['magic'], path: 'global-book/2' }, content: 'GLOBAL' }],
        },
      ],
      worldInfoActivation: {
        activate(path, force = false) {
          activated.set(path, (activated.get(path) ?? false) || force)
        },
      },
    },
  )
  assert.deepEqual(result, {
    ok: true,
    text: '{"all":["Character entry","Global entry"],"characterOnly":["Character entry"]}',
  })
  assert.deepEqual([...activated.entries()], [['global-book/2', false], ['character-book/1', false]])
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

test('EJS parseJSON accepts bounded JSON5 and jsonPatch stays immutable', async () => {
  const engine = await EjsTemplateEngine.create()
  const result = engine.render(
    `<% const original = { user: { name: '莉娜' }, items: [1, 2] }; const patched = jsonPatch(original, [
      { op: 'replace', path: '/user/name', value: '晓' },
      { op: 'add', path: '/items/-', value: 3 },
      { op: 'copy', from: '/user/name', path: '/alias' },
      { op: 'test', path: '/items/0', value: 1 },
    ]); const loose = parseJSON("{foo: 'bar', items: [1, 2,],}"); %><%- JSON.stringify({ original, patched, loose }) %>`,
    { characterName: '莉娜', userName: '小明', messages: [] },
  )
  assert.deepEqual(result, {
    ok: true,
    text: '{"original":{"user":{"name":"莉娜"},"items":[1,2]},"patched":{"user":{"name":"晓"},"items":[1,2,3],"alias":"晓"},"loose":{"foo":"bar","items":[1,2]}}',
  })
})

test('EJS matchChatMessages honors default assistant scope, ranges, ids, and all-pattern matching', async () => {
  const engine = await EjsTemplateEngine.create()
  const result = engine.render(
    '<%= matchChatMessages("needle one", { id: 2 }) %>|<%= matchChatMessages(["needle one", "other"], { start: -5, role: "assistant", and: true }) %>|<%= matchChatMessages("needle user", { role: "user", start: -3 }) %>|<%= matchChatMessages("needle user") %>',
    {
      characterName: '莉娜',
      userName: '小明',
      messages: [],
      transcript: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'needle one' },
        { role: 'user', content: 'needle user' },
        { role: 'assistant', content: 'needle one other' },
      ],
    },
  )
  assert.deepEqual(result, { ok: true, text: 'true|true|true|false' })
})

test('EJS selectActivatedEntries matches ST key and secondary-key logic without host state', async () => {
  const engine = await EjsTemplateEngine.create()
  const result = engine.render(
    `<% const entries = [
      { id: 'all', key: ['Magic'], keysecondary: ['Fire', 'Ice'], selective: true, selectiveLogic: 3 },
      { id: 'not-any', key: ['Magic'], keysecondary: ['Fire', 'Ice'], selective: true, selectiveLogic: 2 },
      { id: 'constant', constant: true, key: [] },
      { id: 'disabled', disable: true, key: ['Magic'] },
    ]; %><%- JSON.stringify(selectActivatedEntries(entries, 'magic fire ice').map(entry => entry.id)) %>|<%- JSON.stringify(selectActivatedEntries(entries, 'magic').map(entry => entry.id)) %>`,
    { characterName: '莉娜', userName: '小明', messages: [] },
  )
    assert.deepEqual(result, { ok: true, text: '["all","constant"]|["not-any","constant"]' })
})

test('EJS variable mutations are render-local and support set/inc/dec/del/ins/patch', async () => {
  const engine = await EjsTemplateEngine.create()
  const context = {
    characterName: '莉娜',
    userName: '小明',
    messages: [],
    variableScopes: {
      global: { score: 1 },
      message: { count: 2, items: ['a'], profile: { name: '莉娜' } },
    },
  }
  const result = engine.render(
    `<% setvar('count', 3); incvar('count', 2); decvar('count', 1); insvar('items', 'b'); insvar('items', 'x', 1); delvar('items', 0); patchVariables('profile', [{ op: 'add', path: '/level', value: 2 }]); setGlobalVar('score', 5); %><%- JSON.stringify({ count: getvar('count', { scope: 'message' }), items: getvar('items', { scope: 'message' }), profile: getvar('profile', { scope: 'message' }), score: getvar('score', { scope: 'global' }) }) %>`,
    context,
  )
  assert.deepEqual(result, {
    ok: true,
    text: '{"count":4,"items":["x","b"],"profile":{"name":"莉娜","level":2},"score":5}',
  })
  assert.deepEqual(
    engine.render('<%= getvar("count", { scope: "message" }) %>|<%= getvar("score", { scope: "global" }) %>', context),
    { ok: true, text: '2|1' },
  )
})

test('EJS pure JSON helpers tolerate common LLM JSON and keep jsonPatch immutable', async () => {
  const engine = await EjsTemplateEngine.create()
  const result = engine.render(
    `<% const fence = String.fromCharCode(96).repeat(3); const parsed = parseJSON(fence + "json\\n{foo: 'bar', list: [1, 2,],}\\n" + fence);
       const original = { profile: { score: 1 }, list: ['a'] };
       const patched = jsonPatch(original, [
         { op: 'replace', path: '/profile/score', value: 2 },
         { op: 'add', path: '/list/-', value: 'b' },
       ]); %><%- JSON.stringify(parsed) %>|<%- JSON.stringify(original) %>|<%- JSON.stringify(patched) %>`,
    { characterName: '莉娜', userName: '小明', messages: [] },
  )
  assert.deepEqual(result, {
    ok: true,
    text: '{"foo":"bar","list":[1,2]}|{"profile":{"score":1},"list":["a"]}|{"profile":{"score":2},"list":["a","b"]}',
  })
})

test('EJS matchChatMessages follows ST range, role, and same-message AND semantics', async () => {
  const engine = await EjsTemplateEngine.create()
  const result = engine.render(
    '<%= matchChatMessages("assistant-hit") %>|<%= matchChatMessages(["assistant-hit", "second"], { and: true }) %>|<%= matchChatMessages(["assistant-hit", "second"], { and: true, role: "assistant" }) %>|<%= matchChatMessages("user-hit", { start: 0, end: 2, role: "user" }) %>',
    {
      characterName: '莉娜',
      userName: '小明',
      messages: [],
      transcript: [
        { role: 'user', content: 'user-hit' },
        { role: 'assistant', content: 'assistant-hit second' },
        { role: 'assistant', content: 'other' },
      ],
    },
  )
  assert.deepEqual(result, { ok: true, text: 'true|true|true|true' })
})

test('EJS selectActivatedEntries uses ST constant, primary, secondary, and disabled fields', async () => {
  const engine = await EjsTemplateEngine.create()
  const result = engine.render(
    `<% const entries = [
      { uid: 1, comment: 'primary', key: ['魔法'], constant: false, disable: false },
      { uid: 2, comment: 'secondary-any', key: ['魔法'], keysecondary: ['火'], selective: true, selectiveLogic: 0, constant: false, disable: false },
      { uid: 3, comment: 'secondary-miss', key: ['魔法'], keysecondary: ['冰'], selective: true, selectiveLogic: 0, constant: false, disable: false },
      { uid: 4, comment: 'constant', key: [], constant: true, disable: false },
      { uid: 5, comment: 'disabled', key: ['魔法'], constant: false, disable: true },
    ]; %><%- JSON.stringify(selectActivatedEntries(entries, '魔法 火').map(entry => entry.comment)) %>|<%- JSON.stringify(selectActivatedEntries(entries, '魔法', { disabled: true }).map(entry => entry.comment)) %>`,
    { characterName: '莉娜', userName: '小明', messages: [] },
  )
  assert.deepEqual(result, { ok: true, text: '["primary","secondary-any","constant"]|["disabled"]' })
})

test('EJS variable helpers are render-local and support update, insert, delete, and patch', async () => {
  const engine = await EjsTemplateEngine.create()
  const context = {
    characterName: '莉娜',
    userName: '小明',
    messages: [],
    variables: { state: { score: 1, list: ['a', 'b'] } },
  }
  const updated = engine.render(
    `<% setvar('state.score', 2); incvar('state.score', 3); decvar('state.score', 1);
       insvar('state.list', 'c'); delvar('state.list', 0);
       patchVariables('state', [{ op: 'add', path: '/ready', value: true }]); %><%- JSON.stringify(variables) %>|<%= getvar('state.score') %>`,
    context,
  )
  assert.deepEqual(updated, {
    ok: true,
    text: '{"state":{"score":4,"list":["b","c"],"ready":true}}|4',
  })
  assert.deepEqual(
    engine.render('<%- JSON.stringify(variables) %>|<%= getvar("state.score") %>', context),
    { ok: true, text: '{"state":{"score":1,"list":["a","b"]}}|1' },
  )
})
