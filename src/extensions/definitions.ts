import type { ExtensionDefinition, ExtensionId } from './types.ts'

/**
 * Official upstream manifests.  The updater deliberately uses an allowlist;
 * the UI cannot turn this into an arbitrary remote-code downloader.
 */
export const EXTENSION_DEFINITIONS: readonly ExtensionDefinition[] = [
  {
    id: 'tavern-helper',
    displayName: '酒馆助手',
    repository: 'N0VI028/JS-Slash-Runner',
    homePage: 'https://github.com/N0VI028/JS-Slash-Runner',
    manifestUrl: 'https://raw.githubusercontent.com/N0VI028/JS-Slash-Runner/main/manifest.json',
    assets: ['manifest.json', 'dist/index.js', 'dist/index.css'],
    adapterVersion: 'agent-rp-tavern-helper-v1',
    capabilities: [
      'iframe-card-frontend',
      'TavernHelper-script-tree',
      'MVU-variable-events',
      'chat-and-worldbook-bridge',
    ],
  },
  {
    id: 'prompt-template',
    displayName: '提示词模板',
    repository: 'zonde306/ST-Prompt-Template',
    homePage: 'https://github.com/zonde306/ST-Prompt-Template',
    manifestUrl: 'https://raw.githubusercontent.com/zonde306/ST-Prompt-Template/main/manifest.json',
    assets: ['manifest.json', 'dist/index.js'],
    adapterVersion: 'agent-rp-prompt-template-v1',
    capabilities: [
      'ejs-prompt-rendering',
      'generate-and-render-injection',
      'inject-positioning',
      'initial-variables-declaration',
    ],
  },
]

const DEFINITIONS = new Map<ExtensionId, ExtensionDefinition>(
  EXTENSION_DEFINITIONS.map(definition => [definition.id, definition]),
)

export function extensionDefinition(id: ExtensionId): ExtensionDefinition {
  const definition = DEFINITIONS.get(id)
  if (definition === undefined) throw new Error(`unknown extension: ${id}`)
  return definition
}
