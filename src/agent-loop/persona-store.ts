/** 用户 Persona(用户人设)存储 —— 酒馆 personas 的对应物。
 *
 *  用户 persona = { name, description }:`name` 是 {{user}} 宏的替换源,
 *  `description` 在 response agent 的 system prompt 里以「用户人设」段注入
 *  (对应酒馆 persona_description_positions.IN_PROMPT 的默认行为)。
 *
 *  持久化布局(与 characters/、worldbooks/ 同款惯例):
 *    personas/<id>/meta.json   # { id, name, description, createdAt }
 *  id = safeFileName(name),同名重复导入覆盖(与角色库同范式)。
 */

import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 一条用户 persona。 */
export interface UserPersona {
  /** 稳定 id,等于目录名(= safeFileName(name))。 */
  readonly id: string
  /** 用户可见名字,{{user}} 宏替换源。 */
  readonly name: string
  /** 人设描述,注入 response system prompt;可为空串(只提供名字)。 */
  readonly description: string
  /** 首次创建时间 ISO。 */
  readonly createdAt: string
}

/** 把 persona 名安全化用作文件名:对齐 ui-server 的 safeFileName 规则。 */
export function safePersonaFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/\s+/gu, '_')
    .slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'unnamed_user'
}

/** 内存 persona 库 + 磁盘持久化。best-effort:单条损坏跳过并警告,不阻塞启动。 */
export class PersonaStore {
  private readonly personas = new Map<string, UserPersona>()

  constructor(private readonly rootDir: string) {}

  /** 启动时扫描 personas/ 重建内存库。 */
  async load(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.rootDir)
    } catch {
      return // 目录不存在 = 首次启动
    }
    for (const id of entries) {
      try {
        const raw = await readFile(join(this.rootDir, id, 'meta.json'), 'utf-8')
        const meta = JSON.parse(raw) as Partial<UserPersona>
        if (typeof meta.name !== 'string' || meta.name.length === 0) continue
        this.personas.set(id, {
          id,
          name: meta.name,
          description: typeof meta.description === 'string' ? meta.description : '',
          createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : new Date().toISOString(),
        })
      } catch (err) {
        process.stderr.write(`[persona-store] skip persona ${id}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }

  list(): UserPersona[] {
    return [...this.personas.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  get(id: string): UserPersona | undefined {
    return this.personas.get(id)
  }

  /** 新建或更新(按 id 覆盖,createdAt 保留旧的)。返回写盘后的记录。 */
  async save(name: string, description: string, existingId?: string): Promise<UserPersona> {
    const id = existingId ?? safePersonaFileName(name)
    const prev = this.personas.get(id)
    const record: UserPersona = {
      id,
      name,
      description,
      createdAt: prev?.createdAt ?? new Date().toISOString(),
    }
    const dir = join(this.rootDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'meta.json'), JSON.stringify(record, null, 2), 'utf-8')
    this.personas.set(id, record)
    return record
  }

  /** 删除一条 persona(目录一并移除)。不存在返回 false。 */
  async delete(id: string): Promise<boolean> {
    if (!this.personas.has(id)) return false
    this.personas.delete(id)
    await rm(join(this.rootDir, id), { recursive: true, force: true }).catch(() => undefined)
    return true
  }
}

/** {{user}} / {{char}} 宏替换(酒馆语义:替换发生在注入前)。
 *  未知宏保持原样,方便用户在提示词里发现拼写问题。 */
export function substituteUserCharMacros(
  text: string,
  userName: string | null,
  charName: string | null,
): string {
  let out = text
  if (userName !== null) out = out.replaceAll('{{user}}', userName)
  if (charName !== null) out = out.replaceAll('{{char}}', charName)
  return out
}
