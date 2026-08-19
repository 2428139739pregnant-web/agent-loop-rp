/**
 * Local extension registry and manual updater.
 *
 * The downloaded upstream bundles are stored for inspection and future
 * adapter upgrades.  They are never eval'ed by the Node server.  The active
 * compatibility layer is the audited adapter shipped with this project.
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { EXTENSION_DEFINITIONS, extensionDefinition } from './definitions.ts'
import type {
  ExtensionAdapterStatus,
  ExtensionDefinition,
  ExtensionId,
  ExtensionManifest,
  ExtensionStatus,
  ExtensionUpdateResult,
  ExtensionVersion,
} from './types.ts'

const REGISTRY_FILE = 'registry.json'
const MAX_ASSET_BYTES = 16 * 1024 * 1024

interface StoredExtension {
  installedVersion: string | null
  activeVersion: string | null
  installedAt: string | null
  lastCheckedAt: string | null
  availableVersion: string | null
  files: string[]
  error: string | null
  manifestSha256: string | null
  versions: ExtensionVersion[]
}

interface StoredRegistry {
  extensions: Partial<Record<ExtensionId, StoredExtension>>
}

interface DownloadedAsset {
  readonly path: string
  readonly content: Uint8Array
  readonly sha256: string
}

function emptyStored(): StoredExtension {
  return {
    installedVersion: null,
    activeVersion: null,
    installedAt: null,
    lastCheckedAt: null,
    availableVersion: null,
    files: [],
    error: null,
    manifestSha256: null,
    versions: [],
  }
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(value)
}

function parseManifest(value: string, definition: ExtensionDefinition): { manifest: ExtensionManifest; version: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${definition.displayName} manifest is not valid JSON`, { cause: error })
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${definition.displayName} manifest must be an object`)
  }
  const manifest = parsed as ExtensionManifest
  if (!validVersion(manifest.version)) {
    throw new Error(`${definition.displayName} manifest has no valid version`)
  }
  return { manifest, version: manifest.version }
}

function validateManifestReferences(manifest: ExtensionManifest, definition: ExtensionDefinition): void {
  for (const field of ['js', 'css'] as const) {
    const reference = manifest[field]
    if (reference !== undefined && (typeof reference !== 'string' || !definition.assets.includes(reference))) {
      throw new Error(`${definition.displayName} manifest ${field} is outside the asset allowlist`)
    }
  }
}

function hash(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

function safeAssetPath(definition: ExtensionDefinition, asset: string): string {
  if (!definition.assets.includes(asset) || asset.length === 0 || asset.startsWith('/')
    || asset.includes('\\') || asset.split('/').some(part => part === '..' || part === '')) {
    throw new Error(`asset is not allowlisted for ${definition.id}: ${asset}`)
  }
  return asset
}

function safeVersionDirectory(version: string): string {
  if (!validVersion(version)) throw new Error(`invalid extension version: ${version}`)
  return version
}

function compareVersions(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false
  const normalize = (value: string): number[] => value.split(/[.+-]/u).map(part => /^\d+$/u.test(part) ? Number(part) : 0)
  const a = normalize(left)
  const b = normalize(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0)
  }
  return false
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { accept: 'application/octet-stream' },
    // The source host is fixed by the definition; accepting a redirect would
    // turn the allowlist into an implicit arbitrary-host downloader.
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error(`remote asset exceeds ${MAX_ASSET_BYTES} bytes`)
  return bytes
}

function statusFor(definition: ExtensionDefinition, stored: StoredExtension): ExtensionStatus {
  const updateAvailable = compareVersions(stored.installedVersion, stored.availableVersion)
  const adapterStatus: ExtensionAdapterStatus = stored.error !== null
    ? 'error'
    : updateAvailable ? 'update-available'
      : stored.installedVersion === null ? 'bundled' : 'installed'
  return {
    id: definition.id,
    displayName: definition.displayName,
    repository: definition.repository,
    homePage: definition.homePage,
    adapterVersion: definition.adapterVersion,
    adapterStatus,
    installedVersion: stored.installedVersion,
    activeVersion: stored.activeVersion,
    availableVersion: stored.availableVersion,
    installedAt: stored.installedAt,
    lastCheckedAt: stored.lastCheckedAt,
    files: stored.files,
    versions: stored.versions,
    capabilities: definition.capabilities,
    error: stored.error,
  }
}

/** Persistent manager used by the server and the UI's manual update panel. */
export class ExtensionRegistry {
  private readonly root: string
  private readonly records = new Map<ExtensionId, StoredExtension>()
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly activeUpdates = new Map<ExtensionId, Promise<ExtensionUpdateResult>>()

  constructor(rootDir: string) {
    this.root = resolve(rootDir)
    for (const definition of EXTENSION_DEFINITIONS) this.records.set(definition.id, emptyStored())
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(join(this.root, REGISTRY_FILE), 'utf8')) as StoredRegistry
      for (const definition of EXTENSION_DEFINITIONS) {
        const raw = parsed.extensions?.[definition.id]
        if (raw === undefined || typeof raw !== 'object' || raw === null) continue
        const fallback = emptyStored()
        const installedVersion = validVersion(raw.installedVersion) ? raw.installedVersion : null
        this.records.set(definition.id, {
          installedVersion,
          // Registry files created before immutable version directories did
          // not have activeVersion. Preserve their visible installed state;
          // only newly downloaded packages become rollback candidates.
          activeVersion: validVersion(raw.activeVersion) ? raw.activeVersion : installedVersion,
          installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : null,
          lastCheckedAt: typeof raw.lastCheckedAt === 'string' ? raw.lastCheckedAt : null,
          availableVersion: validVersion(raw.availableVersion) ? raw.availableVersion : null,
          files: Array.isArray(raw.files) ? raw.files.filter((item): item is string => typeof item === 'string') : fallback.files,
          error: typeof raw.error === 'string' ? raw.error : null,
          manifestSha256: typeof raw.manifestSha256 === 'string' ? raw.manifestSha256 : null,
          versions: Array.isArray(raw.versions) ? raw.versions.filter(isStoredVersion) : [],
        })
      }
    } catch {
      // First boot or a damaged optional registry: the audited bundled adapter
      // remains usable and the next manual update recreates the file.
    }
  }

  /** Verify every recorded file before exposing a package as active. */
  private async verifyVersion(definition: ExtensionDefinition, version: ExtensionVersion): Promise<void> {
    const versionDir = join(this.root, definition.id, 'versions', safeVersionDirectory(version.version))
    for (const asset of definition.assets) {
      const expected = version.fileSha256[asset]
      if (expected === undefined) throw new Error(`stored package is missing hash for ${asset}`)
      const actual = hash(await readFile(join(versionDir, safeAssetPath(definition, asset))))
      if (actual !== expected) throw new Error(`stored package hash mismatch for ${asset}`)
    }
  }

  list(): readonly ExtensionStatus[] {
    return EXTENSION_DEFINITIONS.map(definition => statusFor(definition, this.records.get(definition.id) ?? emptyStored()))
  }

  private async save(): Promise<void> {
    const payload: StoredRegistry = {
      extensions: Object.fromEntries([...this.records.entries()].map(([id, record]) => [id, record])),
    }
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(this.root, { recursive: true })
      await writeFile(join(this.root, REGISTRY_FILE), JSON.stringify(payload, null, 2), 'utf8')
    })
    await this.writeQueue
  }

  async check(id?: ExtensionId): Promise<readonly ExtensionStatus[]> {
    const definitions = id === undefined
      ? EXTENSION_DEFINITIONS
      : [extensionDefinition(id)]
    const checked = await Promise.all(definitions.map(async definition => {
      const current = this.records.get(definition.id) ?? emptyStored()
      try {
        const bytes = await fetchBytes(definition.manifestUrl)
        const { manifest, version } = parseManifest(new TextDecoder().decode(bytes), definition)
        validateManifestReferences(manifest, definition)
        this.records.set(definition.id, {
          ...current,
          availableVersion: version,
          lastCheckedAt: new Date().toISOString(),
          error: null,
        })
      } catch (error) {
        this.records.set(definition.id, {
          ...current,
          lastCheckedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return definition.id
    }))
    await this.save()
    const selected = new Set(checked)
    return this.list().filter(status => selected.has(status.id))
  }

  async update(id: ExtensionId): Promise<ExtensionUpdateResult> {
    const existing = this.activeUpdates.get(id)
    if (existing !== undefined) return existing
    const task = this.updateInternal(id)
    this.activeUpdates.set(id, task)
    try {
      return await task
    } finally {
      if (this.activeUpdates.get(id) === task) this.activeUpdates.delete(id)
    }
  }

  private async updateInternal(id: ExtensionId): Promise<ExtensionUpdateResult> {
    const definition = extensionDefinition(id)
    const current = this.records.get(id) ?? emptyStored()
    const tempDir = join(this.root, `.tmp-${id}-${Date.now()}`)
    try {
      // Manifest and bundle assets are independent downloads; this is the
      // extension updater's own parallel lane and never touches the LLM lane.
      const assets = await Promise.all(definition.assets.map(async asset => {
        const safe = safeAssetPath(definition, asset)
        const url = new URL(safe, definition.manifestUrl).toString()
        const content = await fetchBytes(url)
        return { path: safe, content, sha256: hash(content) } satisfies DownloadedAsset
      }))
      const manifestAsset = assets.find(asset => asset.path === 'manifest.json')
      if (manifestAsset === undefined) throw new Error('upstream manifest was not downloaded')
      const { manifest, version } = parseManifest(new TextDecoder().decode(manifestAsset.content), definition)
      validateManifestReferences(manifest, definition)
      await mkdir(tempDir, { recursive: true })
      for (const asset of assets) {
        const target = join(tempDir, asset.path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, asset.content)
      }
      const versionDir = join(this.root, id, 'versions', safeVersionDirectory(version))
      await mkdir(dirname(versionDir), { recursive: true })
      // Never replace an existing version: rename() can replace a directory
      // on some platforms, which would destroy the bytes behind an activation.
      let versionAlreadyExists = false
      try {
        await lstat(versionDir)
        versionAlreadyExists = true
      } catch {
        // The version is either absent or incomplete; verification below will
        // reject an incomplete package instead of activating it.
      }
      if (!versionAlreadyExists) await rename(tempDir, versionDir)
      else await rm(tempDir, { recursive: true, force: true })
      const fileSha256 = Object.fromEntries(assets.map(asset => [asset.path, asset.sha256]))
      const versionRecord: ExtensionVersion = {
        version,
        installedAt: new Date().toISOString(),
        files: assets.map(asset => asset.path),
        fileSha256,
        manifestSha256: manifestAsset.sha256,
      }
      await this.verifyVersion(definition, versionRecord)
      const versions = current.versions.filter(item => item.version !== version)
      versions.push(versionRecord)
      this.records.set(id, {
        installedVersion: version,
        activeVersion: version,
        installedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        availableVersion: version,
        files: assets.map(asset => asset.path),
        error: null,
        manifestSha256: manifestAsset.sha256,
        versions,
      })
      await this.save()
      return {
        status: statusFor(definition, this.records.get(id) ?? current),
        downloadedFiles: assets.map(asset => asset.path),
        activatedVersion: version,
      }
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      this.records.set(id, {
        ...current,
        error: error instanceof Error ? error.message : String(error),
      })
      await this.save()
      throw error
    }
  }

  /** Activate a previously downloaded and integrity-checked package. */
  async activate(id: ExtensionId, version: string): Promise<ExtensionStatus> {
    const definition = extensionDefinition(id)
    const current = this.records.get(id) ?? emptyStored()
    const record = current.versions.find(item => item.version === version)
    if (record === undefined) throw new Error(`extension version is not installed: ${version}`)
    await this.verifyVersion(definition, record)
    this.records.set(id, {
      ...current,
      installedVersion: record.version,
      activeVersion: record.version,
      files: [...record.files],
      manifestSha256: record.manifestSha256,
      error: null,
    })
    await this.save()
    return statusFor(definition, this.records.get(id) ?? current)
  }

  /** Activate the newest other verified package, leaving the package on disk. */
  async rollback(id: ExtensionId): Promise<ExtensionStatus> {
    const current = this.records.get(id) ?? emptyStored()
    const candidate = [...current.versions]
      .filter(item => item.version !== current.activeVersion)
      .sort((a, b) => b.installedAt.localeCompare(a.installedAt))[0]
    if (candidate === undefined) throw new Error(`no previous version is installed for ${id}`)
    return this.activate(id, candidate.version)
  }
}

function isStoredVersion(value: unknown): value is ExtensionVersion {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<ExtensionVersion>
  return validVersion(item.version)
    && typeof item.installedAt === 'string'
    && Array.isArray(item.files) && item.files.every(file => typeof file === 'string')
    && typeof item.fileSha256 === 'object' && item.fileSha256 !== null
    && Object.values(item.fileSha256).every(hashValue => typeof hashValue === 'string' && /^[a-f0-9]{64}$/u.test(hashValue))
    && typeof item.manifestSha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.manifestSha256)
}
