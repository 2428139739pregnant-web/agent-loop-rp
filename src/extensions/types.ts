/** Shared contracts for SillyTavern-compatible extension adapters. */

export type ExtensionId = 'tavern-helper' | 'prompt-template'

export type ExtensionAdapterStatus = 'bundled' | 'installed' | 'update-available' | 'error'

export interface ExtensionVersion {
  readonly version: string
  readonly installedAt: string
  readonly files: readonly string[]
  readonly fileSha256: Readonly<Record<string, string>>
  readonly manifestSha256: string
}

export interface ExtensionDefinition {
  readonly id: ExtensionId
  readonly displayName: string
  readonly repository: string
  readonly homePage: string
  readonly manifestUrl: string
  /** Only these files may be downloaded by the manual updater. */
  readonly assets: readonly string[]
  /** Compatibility is implemented locally; downloaded files are reference assets. */
  readonly adapterVersion: string
  readonly capabilities: readonly string[]
}

export interface ExtensionManifest {
  readonly display_name?: string
  readonly version?: string
  readonly js?: string
  readonly css?: string
  readonly homePage?: string
  readonly [key: string]: unknown
}

export interface ExtensionStatus {
  readonly id: ExtensionId
  readonly displayName: string
  readonly repository: string
  readonly homePage: string
  readonly adapterVersion: string
  readonly adapterStatus: ExtensionAdapterStatus
  readonly installedVersion: string | null
  /** The version selected for the local compatibility lane. */
  readonly activeVersion: string | null
  readonly availableVersion: string | null
  readonly installedAt: string | null
  readonly lastCheckedAt: string | null
  readonly files: readonly string[]
  readonly versions: readonly ExtensionVersion[]
  readonly capabilities: readonly string[]
  readonly error: string | null
}

export interface ExtensionUpdateResult {
  readonly status: ExtensionStatus
  readonly downloadedFiles: readonly string[]
  readonly activatedVersion: string
}
