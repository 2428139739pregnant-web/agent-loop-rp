/** Stable project-side contract for the Tavern Helper-compatible runtime. */

export const TAVERN_HELPER_ADAPTER = Object.freeze({
  id: 'tavern-helper' as const,
  officialRepository: 'N0VI028/JS-Slash-Runner',
  officialManifest: 'https://raw.githubusercontent.com/N0VI028/JS-Slash-Runner/main/manifest.json',
  adapterVersion: 'agent-rp-tavern-helper-v1',
  runtimeVersion: '3.4.17',
  execution: 'isolated-iframe' as const,
  parallelizable: true,
  capabilities: Object.freeze([
    'TavernHelper script tree',
    'MVU variables and lifecycle events',
    'chat/worldbook/injection bridge',
    'same-origin height observation without inner scrolling',
  ]),
})
