#!/usr/bin/env node
/**
 * 5-agent loop demo. Runs end-to-end with `MockProvider` so it needs no
 * real API key — every LLM call returns a deterministic fixture.
 *
 * Usage (from project root):
 *   node --experimental-strip-types scripts/agent-loop-demo.mjs
 *
 * To run with the real DeepSeek provider:
 *   DEEPSEEK_API_KEY=sk-... node --experimental-strip-types scripts/agent-loop-demo.mjs --real
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  runLoop,
  MockProvider,
  DeepSeekProvider,
  MemorySessionStore,
  FilePromptLoader,
  loadWorldbookFromDir,
  loadCharacterCardFromJson,
  triggerSummarize,
  intentAgent,
  worldbookMatchAgent,
  contextProcessAgent,
  responseAgent,
  readConfig,
} from '../src/agent-loop/index.ts'

const useReal = process.argv.includes('--real')

// --- Worldbook: load from fixtures ------------------------------
const here = dirname(fileURLToPath(import.meta.url))
const wbDir = resolve(here, '..', 'src', 'agent-loop', '_fixtures', 'worldbook')
const worldbook = await loadWorldbookFromDir(wbDir)

// --- Character: build a minimal V2 spec JSON and preprocess ----
// See `src/import/character-card.ts` for the full V2/V3 contract.
const charJson = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '莉娜',
    description: '二十岁的火系法师,立志复仇,性格直接。',
    personality: '直接、果断、有时冲动,不喜欢拐弯抹角。',
    scenario: '一个被冰系法师摧毁家园的年轻火系法师,正在学习更强的火系法术。',
    first_mes: '莉娜抬起头,火光在她眼底跳动。',
    mes_example: '',
    system_prompt: '保持角色扮演,不要跳出角色。',
    post_history_instructions: '每次回复结尾用 【火】 标记。',
    alternate_greetings: [],
    tags: ['火系', '法师', '复仇'],
    creator: 'dsh-agent-rp-demo',
    creator_notes: '',
    character_version: '1.0',
    extensions: {},
  },
})
const character = loadCharacterCardFromJson(charJson)

// --- Provider: real DeepSeek when --real, else Mock -------------
let provider
let model
if (useReal) {
  const cfg = readConfig()
  if (cfg.apiKey === undefined) {
    console.error('DEEPSEEK_API_KEY is required when --real is set')
    process.exit(1)
  }
  provider = new DeepSeekProvider(cfg.apiKey, cfg.baseUrl)
  model = cfg.model
  console.log(`[demo] Using DeepSeekProvider @ ${cfg.baseUrl} model=${model}`)
} else {
  provider = new MockProvider()
  model = 'mock-model'
  console.log('[demo] Using MockProvider (deterministic fixtures). Pass --real to hit DeepSeek.')
}

// --- Session store + session id --------------------------------
const session = new MemorySessionStore()
const sessionId = 'demo-session-1'

// --- Run two turns so 2.2 has history to segment ---------------
const routes1 = []
const systems1 = []
const origChat = provider.chat.bind(provider)
provider.chat = async (...args) => {
  const r = await origChat(...args)
  routes1.push(MockProvider.lastRoute)
  systems1.push(MockProvider.lastSystem.slice(0, 60).replaceAll('\n', ' '))
  return r
}

const turn1 = await runLoop(
  '你好,莉娜。我想问问火系法术的事。',
  {
    provider,
    model,
    prompts: new FilePromptLoader(),
    session,
    worldbook,
    sessionId,
    character,
    summarize: (ctx, input) => { triggerSummarize(input, ctx) },
  },
  { intent: intentAgent, worldbook: worldbookMatchAgent, context: contextProcessAgent, response: responseAgent },
)

const routes2 = []
const systems2 = []
provider.chat = async (...args) => {
  const r = await origChat(...args)
  routes2.push(MockProvider.lastRoute)
  systems2.push(MockProvider.lastSystem.slice(0, 60).replaceAll('\n', ' '))
  return r
}

const turn2 = await runLoop(
  '嗯,我想知道过度施法的代价是什么?',
  {
    provider,
    model,
    prompts: new FilePromptLoader(),
    session,
    worldbook,
    sessionId,
    character,
    summarize: (ctx, input) => { triggerSummarize(input, ctx) },
  },
  { intent: intentAgent, worldbook: worldbookMatchAgent, context: contextProcessAgent, response: responseAgent },
)

// --- Pretty print ------------------------------------------------
console.log('\n=== Agent Loop Demo ===\n')
console.log('User turn 1: 你好,莉娜。我想问问火系法术的事。')
console.log('Agent chain (mock routes):', routes1.join(' → '))
for (const [i, sys] of systems1.entries()) {
  console.log(`  [${i}] ${routes1[i]}: ${sys}...`)
}
console.log('---')
console.log('Reply 1:')
console.log(turn1.reply)
console.log('---')
console.log(`sessionId=${turn1.sessionId}  turn=${turn1.turn}  usedWorldbook=${turn1.usedWorldbook}  usedContextSegmentation=${turn1.usedContextSegmentation}\n`)

console.log('User turn 2: 嗯,我想知道过度施法的代价是什么?')
console.log('Agent chain (mock routes):', routes2.join(' → '))
for (const [i, sys] of systems2.entries()) {
  console.log(`  [${i}] ${routes2[i]}: ${sys}...`)
}
console.log('---')
console.log('Reply 2:')
console.log(turn2.reply)
console.log('---')
console.log(`sessionId=${turn2.sessionId}  turn=${turn2.turn}  usedWorldbook=${turn2.usedWorldbook}  usedContextSegmentation=${turn2.usedContextSegmentation}\n`)

console.log('Session history:')
for (const [i, m] of session.getHistory(sessionId).entries()) {
  console.log(`  [${i}] ${m.role}: ${m.content.slice(0, 60)}${m.content.length > 60 ? '...' : ''}`)
}

console.log('\n=== 完整流程跑通 ===')
