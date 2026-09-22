import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  planDependencyRestore,
  restoreDependencies,
  buildRestoreCommand,
  runCommand,
} from '../deps.ts'
import { launchService } from '../service-launcher.ts'
import { ServiceStartError } from '../supervision.ts'
import { readPluginDecl } from '../decl.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Hash } from '../../../kernel/index.ts'

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2))
}

describe('依赖恢复 planDependencyRestore', () => {
  let cwd: string

  beforeEach(() => {
    cwd = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(cwd))

  it('无任何清单 → []（toy 包不触发恢复）', () => {
    expect(planDependencyRestore(cwd)).toEqual([])
  })

  it('package.json 无依赖且无锁文件 → []', () => {
    writeJson(cwd, 'package.json', { name: 'toy', version: '0.0.0', private: true })
    expect(planDependencyRestore(cwd)).toEqual([])
  })

  it('package.json 有 dependencies → npm install（无锁文件）', () => {
    writeJson(cwd, 'package.json', { name: 'toy', dependencies: { left: '^1.0.0' } })
    expect(planDependencyRestore(cwd)).toEqual([
      { cmd: 'npm', args: ['install', '--no-audit', '--no-fund'] },
    ])
  })

  it('仅锁文件（无 package.json 依赖）→ npm ci', () => {
    writeJson(cwd, 'package.json', { name: 'toy', version: '0.0.0' })
    writeFileSync(join(cwd, 'package-lock.json'), '{}')
    expect(planDependencyRestore(cwd)).toEqual([
      { cmd: 'npm', args: ['ci', '--no-audit', '--no-fund'] },
    ])
  })

  it('有依赖 + npm 锁文件 → npm ci', () => {
    writeJson(cwd, 'package.json', { name: 'toy', devDependencies: { vitest: '^2.0.0' } })
    writeFileSync(join(cwd, 'npm-shrinkwrap.json'), '{}')
    expect(planDependencyRestore(cwd)).toEqual([
      { cmd: 'npm', args: ['ci', '--no-audit', '--no-fund'] },
    ])
  })

  it('非 npm 锁文件（yarn / pnpm / bun）→ 回落 npm install', () => {
    for (const lock of ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock']) {
      writeJson(cwd, 'package.json', { name: 'toy', devDependencies: { vitest: '^2.0.0' } })
      writeFileSync(join(cwd, lock), '')
      expect(planDependencyRestore(cwd)).toEqual([
        { cmd: 'npm', args: ['install', '--no-audit', '--no-fund'] },
      ])
    }
  })

  it('Cargo.toml → cargo build --release', () => {
    writeFileSync(join(cwd, 'Cargo.toml'), '[package]\nname = "toy"\n')
    expect(planDependencyRestore(cwd)).toEqual([{ cmd: 'cargo', args: ['build', '--release'] }])
  })

  it('binding.gyp → npm rebuild', () => {
    writeFileSync(join(cwd, 'binding.gyp'), '{}')
    expect(planDependencyRestore(cwd)).toEqual([{ cmd: 'npm', args: ['rebuild'] }])
  })

  it('顺序 Node → Rust → 原生', () => {
    writeJson(cwd, 'package.json', { name: 'toy', dependencies: { left: '^1.0.0' } })
    writeFileSync(join(cwd, 'Cargo.toml'), '[package]\nname = "toy"\n')
    writeFileSync(join(cwd, 'binding.gyp'), '{}')
    expect(planDependencyRestore(cwd).map((step) => step.cmd)).toEqual(['npm', 'cargo', 'npm'])
    expect(planDependencyRestore(cwd)[1].args).toEqual(['build', '--release'])
  })

  it('有 node_modules 但无恢复标记 → 仍产 Node 步（半恢复要重跑）', () => {
    writeJson(cwd, 'package.json', { name: 'toy', dependencies: { left: '^1.0.0' } })
    mkdirSync(join(cwd, 'node_modules'), { recursive: true })
    expect(planDependencyRestore(cwd)).toEqual([
      { cmd: 'npm', args: ['install', '--no-audit', '--no-fund'] },
    ])
  })

  it('有恢复完成标记 → []（跳过全部步骤）', () => {
    writeJson(cwd, 'package.json', { name: 'toy', dependencies: { left: '^1.0.0' } })
    mkdirSync(join(cwd, 'node_modules'), { recursive: true })
    writeFileSync(join(cwd, '.chrono-deps-ok'), '')
    expect(planDependencyRestore(cwd)).toEqual([])
  })
})

describe('依赖恢复 restoreDependencies', () => {
  let root: string
  let cwd: string
  let depsDir: string

  beforeEach(() => {
    root = createTempRoot()
    cwd = join(root, 'pkg')
    depsDir = join(root, 'state', 'deps')
    mkdirSync(cwd, { recursive: true })
  })

  afterEach(() => cleanupTempRoot(root))

  it('按步执行并注入缓存环境（npm / cargo）', async () => {
    writeJson(cwd, 'package.json', { name: 'toy', dependencies: { left: '^1.0.0' } })
    writeFileSync(join(cwd, 'Cargo.toml'), '[package]\nname = "toy"\n')
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = []
    await restoreDependencies(cwd, depsDir, async (cmd, args, env, runCwd) => {
      calls.push({ cmd, args, env, cwd: runCwd })
    })
    expect(calls.map((call) => call.cmd)).toEqual(['npm', 'cargo'])
    expect(calls[0].args).toEqual(['install', '--no-audit', '--no-fund'])
    expect(calls[0].cwd).toBe(cwd)
    expect(calls[0].env['npm_config_cache']).toBe(join(depsDir, 'npm'))
    expect(calls[0].env['npm_config_allow_remote']).toBe('all')
    expect(calls[1].env['CARGO_TARGET_DIR']).toBe(join(depsDir, 'cargo-target'))
    // 全部步骤成功 → 恢复完成标记落盘
    expect(existsSync(join(cwd, '.chrono-deps-ok'))).toBe(true)
  })

  it('无步骤时不调用 run，也不写标记', async () => {
    let called = false
    await restoreDependencies(cwd, depsDir, async () => {
      called = true
    })
    expect(called).toBe(false)
    expect(existsSync(join(cwd, '.chrono-deps-ok'))).toBe(false)
  })

  it('某步失败 → 抛 ServiceStartError(deps_failed) 且不写标记（下次重试）', async () => {
    writeJson(cwd, 'package.json', { name: 'toy', dependencies: { left: '^1.0.0' } })
    await expect(
      restoreDependencies(cwd, depsDir, async () => {
        throw new Error('npm exploded')
      }),
    ).rejects.toMatchObject({ name: 'ServiceStartError', reason: 'deps_failed' })
    expect(existsSync(join(cwd, '.chrono-deps-ok'))).toBe(false)
  })
})

describe('依赖恢复命令构建与缺省执行器', () => {
  let cwd: string

  beforeEach(() => {
    cwd = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(cwd))

  it('buildRestoreCommand：包装器前置；命令路径含空格加引号', () => {
    expect(buildRestoreCommand('npm', ['install', '--no-fund'])).toBe('npm install --no-fund')
    expect(buildRestoreCommand('npm', ['ci'], 'sandbox --')).toBe('sandbox -- npm ci')
    expect(buildRestoreCommand('C:\\Program Files\\node\\node.exe', ['-v'])).toBe(
      '"C:\\Program Files\\node\\node.exe" -v',
    )
  })

  it('缺省执行器借 shell 执行（win32 上 .cmd 包装脚本不再 EINVAL）', async () => {
    // 用当前 node 可执行文件做冒烟：shell:true 下应能正常退出 0
    await expect(
      runCommand(process.execPath, ['--version'], process.env, cwd),
    ).resolves.toBeUndefined()
  })

  it('缺省执行器：非零退出 → reject', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'process.exit(3)'], process.env, cwd),
    ).rejects.toThrow()
  })
})

describe('依赖恢复接入 launchService', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('restore 抛错 → 启动失败且不 spawn 服务', async () => {
    const pkgRoot = writeTempPackage(root, {
      identity: 'toy-deps',
      implements: ['toy.deps'],
      start: 'node execute/main.js',
    })
    const report = runSeed(root, [{ name: 'toy-deps', path: pkgRoot }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const read = readPluginDecl(world, 'toy-deps', hostPaths(root).blobsDir)
    expect(read).not.toBeNull()

    let restoreCalled = false
    const rejection = launchService(
      {
        world,
        materializedDir: hostPaths(root).materializedDir,
        blobsDir: hostPaths(root).blobsDir,
        handshakeTimeoutMs: 1_000,
        restore: async () => {
          restoreCalled = true
          throw new Error('deps exploded')
        },
        onExtraDropped: () => {},
        onChannelClosed: () => {},
        onExit: () => {},
      },
      'toy-deps',
      world.ids['toy-deps'].active as Hash,
      read!.decl,
    )
    await expect(rejection).rejects.toBeInstanceOf(ServiceStartError)
    await expect(rejection).rejects.toMatchObject({ reason: 'deps_failed' })
    expect(restoreCalled).toBe(true)
  })
})
