// 插件管理（离线面）：取包 / 暂存 / 登记 / 退役。
// `chrono add` 的三来源（本地路径 / npm 包名 / 远程 git）在此收敛为「一个已暂存的包目录」，
// 再登记进 `state/plugins.json`；入世本身仍走既有 `runSeed` / 运行期 `plugin.ingest`，本模块不落账。
// 与宿主运行期解耦：宿主在跑时由 CLI 改走入站动词，本模块只负责文件层。

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isRecord } from './common/json.ts'
import { symlinkDirOrJunction, writeFileAtomic } from './common/platform/index.ts'
import { isSafeIdentityName } from './common/paths-safe.ts'
import { hostPaths } from './paths.ts'

/** `state/plugins.json` 的一项（与 `assembly/ingest.ts` 的 `PluginEntry` 同形）。 */
export interface ManagedEntry {
  name: string
  path?: string
  exclude?: boolean
}

export interface InstalledPlugin {
  name: string
  path: string | null
  identity: string | null
  hot: string
}

export type SourceKind = 'local-dir' | 'local-archive' | 'npm' | 'git'

export interface StageOptions {
  /** 覆盖暂存目录名 / 身份名；缺省取包内 `plugin.json.identity`。 */
  name?: string
  /** git 来源的可选 ref（branch / tag / commit）。 */
  ref?: string
}

export interface StagedPlugin {
  name: string
  identity: string
  /** 暂存目录（`<root>/plugins/<name>`）。 */
  path: string
  kind: SourceKind
  /** `plugin.json.hot`，缺省 `auto`。 */
  hot: string
}

function readJsonFile(abs: string): unknown {
  try {
    return JSON.parse(readFileSync(abs, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** 包根 `package.json.chrono.plugin` 指到的契约文件；缺省 `plugin.json`。 */
export function chronoPluginFile(pkgRoot: string): string {
  const pkg = readJsonFile(join(pkgRoot, 'package.json'))
  if (isRecord(pkg) && isRecord(pkg['chrono'])) {
    const plugin = pkg['chrono']['plugin']
    if (typeof plugin === 'string' && plugin.length > 0) return plugin
  }
  return 'plugin.json'
}

/** 读包身份与 hot；包根无有效契约文件返回 null。 */
function readIdentityAndHot(pkgRoot: string): { identity: string; hot: string } | null {
  const rel = chronoPluginFile(pkgRoot)
  const decl = readJsonFile(join(pkgRoot, rel))
  if (!isRecord(decl)) return null
  const identity = decl['identity']
  if (typeof identity !== 'string' || !isSafeIdentityName(identity)) return null
  const hot = decl['hot']
  return { identity, hot: hot === 'manual' || hot === 'off' ? hot : 'auto' }
}

/** 分类来源：本地目录 / 本地归档 / npm 包名 / 远程 git。 */
export function classifySource(source: string, cwd: string): SourceKind {
  const local = isAbsolute(source) ? source : resolve(cwd, source)
  if (existsSync(local)) {
    return statSync(local).isDirectory() ? 'local-dir' : 'local-archive'
  }
  if (
    source.startsWith('git+') ||
    source.startsWith('git@') ||
    /^[a-z+]+:\/\//i.test(source) ||
    source.endsWith('.git')
  ) {
    return 'git'
  }
  return 'npm'
}

/** 运行外部命令（npm / git / tar），失败返回 stderr 摘要而非抛出。 */
function runCommand(cmd: string, args: string[], cwd: string): { ok: boolean; detail: string } {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status === 0) return { ok: true, detail: '' }
  const detail = `${(result.stderr ?? '').trim() || (result.stdout ?? '').trim() || `exit ${result.status ?? 'null'}`}`
  return { ok: false, detail }
}

/** 在目录（或其一层的唯一子目录）里找包根：含契约文件者。 */
function findPackageRoot(dir: string): string | null {
  if (existsSync(join(dir, 'plugin.json'))) return dir
  if (existsSync(join(dir, 'package.json'))) {
    const pkg = readJsonFile(join(dir, 'package.json'))
    if (isRecord(pkg)) {
      const rel =
        isRecord(pkg['chrono']) && typeof pkg['chrono']['plugin'] === 'string'
          ? pkg['chrono']['plugin']
          : 'plugin.json'
      if (existsSync(join(dir, rel))) return dir
    }
  }
  let only: string | null = null
  for (const entry of readDirNames(dir)) {
    const abs = join(dir, entry)
    if (!statSync(abs).isDirectory()) return null
    if (only !== null) return null
    only = abs
  }
  if (only === null) return null
  return findPackageRoot(only)
}

function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 取来源包到一个临时目录，返回其中的包根；失败抛 `add_failed:<detail>`。 */
function fetchToTemp(
  root: string,
  source: string,
  cwd: string,
  kind: SourceKind,
  options: StageOptions,
): string {
  const tmp = join(hostPaths(root).stateDir, '.staging', randomUUID())
  mkdirSync(tmp, { recursive: true })
  if (kind === 'local-archive') {
    const archive = isAbsolute(source) ? source : resolve(cwd, source)
    const extracted = join(tmp, 'extract')
    mkdirSync(extracted, { recursive: true })
    const untar = runCommand('tar', ['-xzf', archive, '-C', extracted], cwd)
    if (!untar.ok) throw new Error(`add_failed:${untar.detail}`)
    const pkgRoot = findPackageRoot(extracted)
    if (pkgRoot === null) throw new Error('add_failed:no_plugin_json')
    return pkgRoot
  }
  if (kind === 'npm') {
    const packed = runCommand('npm', ['pack', source, '--pack-destination', tmp], cwd)
    if (!packed.ok) throw new Error(`add_failed:${packed.detail}`)
    const tgz = readDirNames(tmp).find((name) => name.endsWith('.tgz'))
    if (tgz === undefined) throw new Error('add_failed:npm_pack_empty')
    const extracted = join(tmp, 'extract')
    mkdirSync(extracted, { recursive: true })
    const untar = runCommand(
      'tar',
      ['-xzf', join(tmp, tgz), '-C', extracted, '--strip-components=1'],
      cwd,
    )
    if (!untar.ok) throw new Error(`add_failed:${untar.detail}`)
    const pkgRoot = findPackageRoot(extracted)
    if (pkgRoot === null) throw new Error('add_failed:no_plugin_json')
    return pkgRoot
  }
  // git
  const cloneDir = join(tmp, 'repo')
  const args = ['clone', '--depth', '1']
  if (options.ref !== undefined && options.ref.length > 0) args.push('--branch', options.ref)
  args.push(source, cloneDir)
  const clone = runCommand('git', args, cwd)
  if (!clone.ok) throw new Error(`add_failed:${clone.detail}`)
  const pkgRoot = findPackageRoot(cloneDir)
  if (pkgRoot === null) throw new Error('add_failed:no_plugin_json')
  return pkgRoot
}

/**
 * 取包 → 暂存到 `<root>/plugins/<name>` → 返回身份与 hot。
 * 本地目录以链接落点（边写边热更）；归档 / npm / git 以复制落点。
 * 目标已存在且指向同一源 → 视为已暂存（幂等）；否则抛 `already_exists`。
 */
export function stagePlugin(
  root: string,
  source: string,
  cwd: string,
  options: StageOptions = {},
): StagedPlugin {
  const kind = classifySource(source, cwd)
  const pluginsDir = join(root, 'plugins')
  mkdirSync(pluginsDir, { recursive: true })

  if (kind === 'local-dir') {
    const srcDir = isAbsolute(source) ? source : resolve(cwd, source)
    const id = readIdentityAndHot(srcDir)
    if (id === null) throw new Error('add_failed:no_plugin_json')
    const name = options.name ?? id.identity
    assertSafeName(name)
    const dest = join(pluginsDir, name)
    if (existsSync(dest)) {
      if (isLinkTo(dest, srcDir))
        return { name, identity: id.identity, path: dest, kind, hot: id.hot }
      throw new Error(`already_exists:${name}`)
    }
    symlinkDirOrJunction(dest, srcDir)
    return { name, identity: id.identity, path: dest, kind, hot: id.hot }
  }

  const fetchedRoot = fetchToTemp(root, source, cwd, kind, options)
  const id = readIdentityAndHot(fetchedRoot)
  if (id === null) throw new Error('add_failed:no_plugin_json')
  const name = options.name ?? id.identity
  assertSafeName(name)
  const dest = join(pluginsDir, name)
  if (existsSync(dest)) throw new Error(`already_exists:${name}`)
  mkdirSync(dirname(dest), { recursive: true })
  try {
    renameSync(fetchedRoot, dest)
  } catch {
    // 跨卷回退：复制再删（renameSync EXDEV）
    rmSync(dest, { recursive: true, force: true })
    cpSyncFallback(fetchedRoot, dest)
  }
  return { name, identity: id.identity, path: dest, kind, hot: id.hot }
}

function cpSyncFallback(from: string, to: string): void {
  cpSync(from, to, { recursive: true })
}

function assertSafeName(name: string): void {
  if (!isSafeIdentityName(name)) throw new Error(`bad_name:${name}`)
}

function isLinkTo(target: string, source: string): boolean {
  try {
    if (!lstatSync(target).isSymbolicLink()) return false
    return realpathSync(target) === realpathSync(source)
  } catch {
    return false
  }
}

/** 读 `state/plugins.json` 原始清单（缺文件即空）。 */
export function readManagedManifest(root: string): ManagedEntry[] {
  const file = hostPaths(root).pluginsFile
  if (!existsSync(file)) return []
  const parsed = readJsonFile(file)
  if (!Array.isArray(parsed)) throw new Error('bad_plugins_manifest')
  const out: ManagedEntry[] = []
  for (const item of parsed) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || item['name'].length === 0) {
      throw new Error('bad_plugins_manifest')
    }
    const entry: ManagedEntry = { name: item['name'] }
    if (item['path'] !== undefined) {
      if (typeof item['path'] !== 'string') throw new Error('bad_plugins_manifest')
      entry.path = item['path']
    }
    if (item['exclude'] !== undefined) {
      if (typeof item['exclude'] !== 'boolean') throw new Error('bad_plugins_manifest')
      entry.exclude = item['exclude']
    }
    out.push(entry)
  }
  return out
}

function writeManagedManifest(root: string, entries: ManagedEntry[]): void {
  writeFileAtomic(hostPaths(root).pluginsFile, `${JSON.stringify(entries, null, 2)}\n`)
}

/** 登记（或覆盖）一个托管项；同 name 覆盖。 */
export function registerPlugin(root: string, entry: ManagedEntry): void {
  const entries = readManagedManifest(root).filter((item) => item.name !== entry.name)
  entries.push(entry)
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  writeManagedManifest(root, entries)
}

/** 撤销登记一个托管项。 */
export function unregisterPlugin(root: string, name: string): void {
  const entries = readManagedManifest(root).filter((item) => item.name !== name)
  writeManagedManifest(root, entries)
}

/** 列出托管项：读清单并解析各自包根的身份与 hot。 */
export function listPlugins(root: string): InstalledPlugin[] {
  let entries: ManagedEntry[]
  try {
    entries = readManagedManifest(root)
  } catch {
    entries = []
  }
  const out: InstalledPlugin[] = []
  for (const entry of entries) {
    if (entry.exclude === true) continue
    const dir =
      entry.path === undefined ? join(root, 'plugins', entry.name) : resolve(root, entry.path)
    const pkgRoot = existsSync(dir) ? dir : null
    const id = pkgRoot === null ? null : readIdentityAndHot(pkgRoot)
    out.push({
      name: entry.name,
      path: pkgRoot,
      identity: id?.identity ?? null,
      hot: id?.hot ?? 'auto',
    })
  }
  return out
}

export interface RemoveReport {
  ok: boolean
  name: string
  archivedTo: string | null
  reasons: string[]
}

/**
 * 撤下托管插件：把暂存目录挪进 `state/removed/<name>/`（不直接删除，可人工回收），
 * 撤销登记。世界层退役由调用方走 `plugin.remove`（宿主在跑）或离线 `retire`。
 */
export function removePlugin(root: string, name: string): RemoveReport {
  const staged = join(root, 'plugins', name)
  let archivedTo: string | null = null
  if (existsSync(staged)) {
    const archiveRoot = join(hostPaths(root).stateDir, 'removed')
    mkdirSync(archiveRoot, { recursive: true })
    const dest = join(archiveRoot, name)
    rmSync(dest, { recursive: true, force: true })
    try {
      if (lstatSync(staged).isSymbolicLink()) {
        // 链接：只记指向，不搬目标
        const target = realpathSync(staged)
        unlinkSync(staged)
        writeFileSync(join(archiveRoot, `${name}.link.txt`), `${target}\n`)
        archivedTo = target
      } else {
        renameSync(staged, dest)
        archivedTo = dest
      }
    } catch (err) {
      return {
        ok: false,
        name,
        archivedTo: null,
        reasons: [err instanceof Error ? err.message : String(err)],
      }
    }
  }
  unregisterPlugin(root, name)
  return { ok: true, name, archivedTo, reasons: [] }
}
