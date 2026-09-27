import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

const NPM_CI = { cmd: 'npm', args: ['ci', '--no-audit', '--no-fund'] }
const CARGO_RELEASE = { cmd: 'cargo', args: ['build', '--release'] }

describe('依赖恢复 planDependencyRestore', () => {
  let cwd: string

  beforeEach(() => {
    cwd = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(cwd))

  it('build: [] → []（显式无需构建）', () => {
    expect(planDependencyRestore(cwd, [])).toEqual([])
  })

  it('声明的步骤原样产出，且不共享声明引用', () => {
    const build = [NPM_CI, CARGO_RELEASE]
    const steps = planDependencyRestore(cwd, build)
    expect(steps).toEqual(build)
    expect(steps).not.toBe(build)
    expect(steps[0]).not.toBe(build[0])
  })

  it('宿主不探测语言痕迹：有依赖声明 / 锁文件 / Cargo.toml，声明为空仍一步不跑', () => {
    writeJson(cwd, 'package.json', { name: 'toy', dependencies: { left: '^1.0.0' } })
    writeFileSync(join(cwd, 'package-lock.json'), '{}')
    writeFileSync(join(cwd, 'Cargo.toml'), '[package]\nname = "toy"\n')
    expect(planDependencyRestore(cwd, [])).toEqual([])
  })

  it('有 node_modules 但无恢复标记 → 仍按声明产出（半恢复要重跑）', () => {
    mkdirSync(join(cwd, 'node_modules'), { recursive: true })
    expect(planDependencyRestore(cwd, [NPM_CI])).toEqual([NPM_CI])
  })

  it('有恢复标记 → 声明的步骤也跳过（本目录已恢复）', () => {
    writeFileSync(join(cwd, '.chrono-deps-ok'), '')
    expect(planDependencyRestore(cwd, [CARGO_RELEASE])).toEqual([])
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

  it('按声明执行并注入缓存环境（npm / cargo）', async () => {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = []
    await restoreDependencies(
      cwd,
      depsDir,
      [NPM_CI, CARGO_RELEASE],
      async (cmd, args, env, runCwd) => {
        calls.push({ cmd, args, env, cwd: runCwd })
      },
    )
    expect(calls.map((call) => call.cmd)).toEqual(['npm', 'cargo'])
    expect(calls[0].args).toEqual(['ci', '--no-audit', '--no-fund'])
    expect(calls[0].cwd).toBe(cwd)
    expect(calls[0].env['npm_config_cache']).toBe(join(depsDir, 'npm'))
    expect(calls[0].env['npm_config_allow_remote']).toBe('all')
    expect(calls[1].env['CARGO_TARGET_DIR']).toBe(join(depsDir, 'cargo-target'))
    // 全部步骤成功 → 恢复完成标记落盘
    expect(existsSync(join(cwd, '.chrono-deps-ok'))).toBe(true)
  })

  it('无步骤时不调用 run，也不写标记', async () => {
    let called = false
    await restoreDependencies(cwd, depsDir, [], async () => {
      called = true
    })
    expect(called).toBe(false)
    expect(existsSync(join(cwd, '.chrono-deps-ok'))).toBe(false)
  })

  it('声明的步骤按序执行（不再看清单文件）', async () => {
    const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = []
    await restoreDependencies(cwd, depsDir, [CARGO_RELEASE], async (cmd, args, env) => {
      calls.push({ cmd, args, env })
    })
    expect(calls.map((call) => call.cmd)).toEqual(['cargo'])
    expect(calls[0].args).toEqual(['build', '--release'])
    expect(calls[0].env['CARGO_TARGET_DIR']).toBe(join(depsDir, 'cargo-target'))
    expect(existsSync(join(cwd, '.chrono-deps-ok'))).toBe(true)
  })

  it('build 步骤与 start 走同一包装器（沙箱不破口）', async () => {
    const log = join(cwd, 'wrap.log')
    const script = join(cwd, 'wrap.js')
    writeFileSync(
      script,
      "require('node:fs').writeFileSync(process.env.WRAP_LOG, process.argv.slice(2).join(' '))\n",
    )
    process.env['WRAP_LOG'] = log
    const wrapper = `"${process.execPath}" "${script}"`
    try {
      await restoreDependencies(cwd, depsDir, [CARGO_RELEASE], undefined, wrapper)
    } finally {
      delete process.env['WRAP_LOG']
    }
    expect(readFileSync(log, 'utf8')).toBe('cargo build --release')
  })

  it('某步失败 → 抛 ServiceStartError(deps_failed) 且不写标记（下次重试）', async () => {
    await expect(
      restoreDependencies(cwd, depsDir, [NPM_CI], async () => {
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
