import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EXTENSION_DEFINITIONS, extensionDefinition } from './extensions/definitions.ts'
import { PROMPT_TEMPLATE_ADAPTER } from './extensions/prompt-template-adapter.ts'
import { ExtensionRegistry } from './extensions/registry.ts'
import { TAVERN_HELPER_ADAPTER } from './extensions/tavern-helper-adapter.ts'

test('extension definitions keep the manual updater allowlist fixed', () => {
  assert.deepEqual(
    EXTENSION_DEFINITIONS.map(({ id, repository, manifestUrl, assets }) => ({
      id,
      repository,
      manifestUrl,
      assets: [...assets],
    })),
    [
      {
        id: 'tavern-helper',
        repository: 'N0VI028/JS-Slash-Runner',
        manifestUrl: 'https://raw.githubusercontent.com/N0VI028/JS-Slash-Runner/main/manifest.json',
        assets: ['manifest.json', 'dist/index.js', 'dist/index.css'],
      },
      {
        id: 'prompt-template',
        repository: 'zonde306/ST-Prompt-Template',
        manifestUrl: 'https://raw.githubusercontent.com/zonde306/ST-Prompt-Template/main/manifest.json',
        assets: ['manifest.json', 'dist/index.js'],
      },
    ],
  )

  assert.equal(EXTENSION_DEFINITIONS.length, 2)
  assert.throws(() => extensionDefinition('unknown' as never), /unknown extension: unknown/u)

  for (const definition of EXTENSION_DEFINITIONS) {
    for (const asset of definition.assets) {
      assert.ok(asset.length > 0)
      assert.equal(asset.startsWith('/'), false)
      assert.equal(asset.includes('\\'), false)
      assert.equal(asset.split('/').includes('..'), false)
    }
  }
})

test('a first-load registry exposes both bundled adapters with empty install state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-rp-extensions-'))
  t.after(async () => rm(root, { recursive: true, force: true }))

  const registry = new ExtensionRegistry(root)
  await registry.load()
  const statuses = registry.list()

  assert.deepEqual(statuses.map(status => status.id), ['tavern-helper', 'prompt-template'])
  for (const status of statuses) {
    assert.equal(status.adapterStatus, 'bundled')
    assert.equal(status.installedVersion, null)
    assert.equal(status.availableVersion, null)
    assert.equal(status.installedAt, null)
    assert.equal(status.lastCheckedAt, null)
    assert.deepEqual(status.files, [])
    assert.equal(status.error, null)
  }
})

test('Tavern Helper adapter advertises its compatibility capabilities', () => {
  assert.equal(TAVERN_HELPER_ADAPTER.id, 'tavern-helper')
  assert.equal(TAVERN_HELPER_ADAPTER.execution, 'isolated-iframe')
  assert.equal(TAVERN_HELPER_ADAPTER.parallelizable, true)
  assert.deepEqual([...TAVERN_HELPER_ADAPTER.capabilities], [
    'TavernHelper script tree',
    'MVU variables and lifecycle events',
    'chat/worldbook/injection bridge',
    'same-origin height observation without inner scrolling',
  ])
  assert.equal(Object.isFrozen(TAVERN_HELPER_ADAPTER), true)
  assert.equal(Object.isFrozen(TAVERN_HELPER_ADAPTER.capabilities), true)
})

test('Prompt Template adapter advertises its compatibility capabilities', () => {
  assert.equal(PROMPT_TEMPLATE_ADAPTER.id, 'prompt-template')
  assert.equal(PROMPT_TEMPLATE_ADAPTER.execution, 'isolated-quickjs')
  assert.equal(PROMPT_TEMPLATE_ADAPTER.parallelizable, true)
  assert.deepEqual([...PROMPT_TEMPLATE_ADAPTER.capabilities], [
    'EJS prompt rendering',
    '[GENERATE:*] and [RENDER:*] directives',
    '@INJECT positional/target/regex placement',
    '[InitialVariables] declaration',
  ])
  assert.equal(Object.isFrozen(PROMPT_TEMPLATE_ADAPTER), true)
  assert.equal(Object.isFrozen(PROMPT_TEMPLATE_ADAPTER.capabilities), true)
})

test('registry stores immutable verified versions and rolls back without executing bundles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-rp-extensions-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const originalFetch = globalThis.fetch
  let upstreamVersion = '1.0.0'
  globalThis.fetch = async (input) => {
    const url = String(input)
    const version = upstreamVersion
    const body = url.endsWith('/manifest.json')
      ? JSON.stringify({ version, js: 'dist/index.js' })
      : url.endsWith('/dist/index.js') ? `bundle-${version}` : ''
    return new Response(body, { status: 200 })
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const registry = new ExtensionRegistry(root)
  await registry.load()
  const first = await registry.update('prompt-template')
  assert.equal(first.activatedVersion, '1.0.0')
  assert.equal(first.status.activeVersion, '1.0.0')
  assert.equal(first.status.versions.length, 1)

  upstreamVersion = '2.0.0'
  await registry.update('prompt-template')
  const updated = registry.list().find(status => status.id === 'prompt-template')
  assert.ok(updated)
  assert.equal(updated.activeVersion, '2.0.0')
  assert.deepEqual(updated.versions.map(version => version.version), ['1.0.0', '2.0.0'])

  const rolledBack = await registry.rollback('prompt-template')
  assert.equal(rolledBack.activeVersion, '1.0.0')
  assert.equal(rolledBack.installedVersion, '1.0.0')
  assert.match(await readFile(join(root, 'prompt-template', 'versions', '2.0.0', 'dist', 'index.js'), 'utf8'), /bundle-2\.0\.0/u)

  await writeFile(join(root, 'prompt-template', 'versions', '1.0.0', 'dist', 'index.js'), 'tampered')
  await assert.rejects(() => registry.activate('prompt-template', '1.0.0'), /hash mismatch/u)
  assert.equal(registry.list().find(status => status.id === 'prompt-template')?.activeVersion, '1.0.0')
})

test('registry records bundles but keeps the audited adapter as the execution default', () => {
  const source = TAVERN_HELPER_ADAPTER.execution + PROMPT_TEMPLATE_ADAPTER.execution
  assert.match(source, /isolated-iframeisolated-quickjs/u)
  assert.equal('eval' in TAVERN_HELPER_ADAPTER, false)
  assert.equal('eval' in PROMPT_TEMPLATE_ADAPTER, false)
})
