// 生态 profile 在宿主启动链路的贯通：组合根一次解析并注入，
// 起服务准备阶段用其 SDK 布局、依赖恢复用其 npm / cargo 环境变量；未配置覆盖时走内建默认（零行为变化）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import { startAssembly } from '../assembly/index.ts'
import type { AssemblyRuntimeHandle } from '../assembly/index.ts'
import { prepareService } from '../assembly/service-launcher.ts'
import type { ServiceLauncherDeps } from '../assembly/service-launcher.ts'
import { DEFAULT_ECOSYSTEM } from '../assembly/ecosystem.ts'
import { readPluginDecl } from '../assembly/decl.ts'
import type { PluginDecl } from '../assembly/decl.ts'
import { runSeed } from '../offline.ts'
import { loadAnchor } from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { createRoundRouter } from '../effect/route.ts'
import { createHostCapability } from '../host-capability.ts'
import { AuditIndex } from '../audit.ts'
import { EndpointTable } from '../endpoint-table.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { FIXTURE_CHANNEL_MAIN, writeTempPackage } from './test-helpers-ext.ts'
import { H } from '../../kernel/index.ts'
import type { LifeLogEntry } from './test-helpers-ext.ts'
import type { EcosystemProfile } from '../assembly/ecosystem.ts'
import type { EndpointRow } from '../endpoint-table.ts'
import type { Def, Gen, Hash, Identity, Json, World } from '../../kernel/index.ts'

/** 依赖恢复的构建脚本：把 npm / cargo 环境变量写回物化目录，供测试断言宿主注入的值。 */
const BUILD_SCRIPT = `const fs = require('node:fs')
fs.writeFileSync(
  'env.json',
  JSON.stringify({
    npm: process.env.ECO_NPM_CACHE ?? null,
    cargo: process.env.ECO_CARGO_DIR ?? null,
  }),
)
`

describe('生态 profile 启动贯通', () => {
  let root: string
  let runtime: AssemblyRuntimeHandle | undefined

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(async () => {
    await runtime?.stop()
    runtime = undefined
    await cleanupTempRoot(root)
  })

  function seed(identity: string, spec: Parameters<typeof writeTempPackage>[1]): Hash {
    const pkg = writeTempPackage(root, spec)
    expect(runSeed(root, [{ name: identity, path: pkg }]).ok).toBe(true)
    const active = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world.ids[identity]
      .active
    expect(active).not.toBeNull()
    return active as Hash
  }

  function world(): World {
    return loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
  }

  it('chrono.config.json 的 ecosystem 形态非法 → 启动 fail-closed（bad_ecosystem）', async () => {
    writeFileSync(
      join(root, 'chrono.config.json'),
      JSON.stringify({ ecosystem: { unknown: true } }),
    )
    await expect(startHost({ root })).rejects.toThrow('bad_ecosystem')
  })

  it('起服务准备阶段按注入的生态布局供给 SDK', async () => {
    const identity = 'eco-sdk'
    const gen = seed(identity, { identity, start: 'node execute/main.js' })
    const current = world()
    const read = readPluginDecl(current, identity, hostPaths(root).blobsDir)
    expect(read).not.toBeNull()

    // 自定义 SDK 安装目录（含 rust crate），验证布局字段被采纳
    const sdkDir = join(root, 'sdk-alt')
    mkdirSync(join(sdkDir, 'rust'), { recursive: true })
    writeFileSync(join(sdkDir, 'package.json'), '{}')
    writeFileSync(join(sdkDir, 'rust', 'Cargo.toml'), '[package]\nname = "sdk-alt"\n')

    const ecosystem: EcosystemProfile = {
      ...DEFAULT_ECOSYSTEM,
      sdkPackageName: 'sdk-alt',
      sdkNodeModulesDir: 'nm',
    }
    const deps: ServiceLauncherDeps = {
      world: current,
      materializedDir: hostPaths(root).materializedDir,
      blobsDir: hostPaths(root).blobsDir,
      handshakeTimeoutMs: 3000,
      sdkDir,
      ecosystem,
      onExtraDropped: () => {},
      onChannelClosed: () => {},
      onExit: () => {},
    }
    const prepared = await prepareService(deps, identity, gen, read!.decl as PluginDecl)
    const target = join(prepared.cwd, 'nm', 'sdk-alt')
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(realpathSync(target)).toBe(realpathSync(sdkDir))
  })

  it('依赖恢复用注入生态的 npm / cargo 环境变量（默认 profile 未介入）', async () => {
    const identity = 'eco-deps'
    const gen = seed(identity, {
      identity,
      start: 'node execute/main.js',
      build: [{ cmd: 'node', args: ['build.cjs'] }],
      files: { 'build.cjs': BUILD_SCRIPT, 'execute/main.js': 'process.exit(0)\n' },
    })
    const depsDir = join(root, 'deps')
    runtime = await startAssembly({
      root,
      world: world(),
      log: () => {},
      depsDir,
      handshakeTimeoutMs: 500,
      startConcurrency: 1,
      ecosystem: {
        ...DEFAULT_ECOSYSTEM,
        npmCacheEnvVar: 'ECO_NPM_CACHE',
        npmCacheDirName: 'eco-npm',
        cargoTargetEnvVar: 'ECO_CARGO_DIR',
        cargoTargetDirName: 'eco-cargo',
      },
    })

    const written = JSON.parse(
      readFileSync(join(hostPaths(root).materializedDir, gen, 'env.json'), 'utf8'),
    ) as { npm: string | null; cargo: string | null }
    expect(written.npm).toBe(join(depsDir, 'eco-npm'))
    expect(written.cargo).toBe(join(depsDir, 'eco-cargo'))
  })

  it('未配置覆盖时 runtime 暴露内建默认 profile（零行为变化）', async () => {
    runtime = await startAssembly({ root, world: { defs: {}, ids: {} }, log: () => {} })
    expect(runtime.ecosystem).toEqual(DEFAULT_ECOSYSTEM)
  })

  it('startAssembly 声明解析采纳注入 profile：受限入口扩展名下按坏声明收口', async () => {
    const identity = 'eco-decl'
    seed(identity, {
      identity,
      implements: ['eco.decl'],
      methods: { 'eco.decl': ['echo'] },
      start: 'execute/main.mjs',
      transport: 'inproc',
      files: { 'execute/main.mjs': FIXTURE_CHANNEL_MAIN },
    })
    const records: LifeLogEntry[] = []
    runtime = await startAssembly({
      root,
      world: world(),
      log: (record) => records.push(record as LifeLogEntry),
      // 受限 profile：mjs 入口被拒 → 运行期声明解析应读到坏声明（默认 profile 会放行并起服务）
      ecosystem: { ...DEFAULT_ECOSYSTEM, entryExtensions: ['js'] },
      handshakeTimeoutMs: 500,
      startConcurrency: 1,
    })
    expect(
      records.some(
        (record) =>
          record.kind === 'service' &&
          record.event === 'start_failed' &&
          record.impl === identity &&
          record.reason === 'bad_plugin_decl',
      ),
    ).toBe(true)
    expect(runtime.loaded().some((entry) => entry.id === identity)).toBe(false)
  })
})

describe('生态 profile 构造期注入路由与宿主保留面', () => {
  /** 自能力身份：`inproc` 入口用自定义扩展名，仅自定义 profile 能解析出该声明。 */
  const CUSTOM_DECL: Json = {
    identity: 'solo',
    implements: ['toy.echo'],
    methods: { 'toy.echo': ['echo'] },
    start: 'execute/main.custom',
    transport: 'inproc',
    build: [],
    protocol: '1',
    restart: {},
    health: {},
    state: 'recomputable',
    members: [],
    commands: [],
  }

  const CUSTOM_PROFILE: EcosystemProfile = { ...DEFAULT_ECOSYSTEM, entryExtensions: ['custom'] }

  function customEntryWorld(): { world: World; payload: Hash } {
    const pluginJson = JSON.stringify(CUSTOM_DECL)
    const blob = H({ body: pluginJson })
    const treeBody: Json = { entries: [{ name: 'plugin.json', mode: 'file', hash: blob }] }
    const tree = H({ body: treeBody })
    const commitBody: Json = { tree }
    const payload = H({ body: commitBody })
    const defs: Record<Hash, Def> = {
      [blob]: { body: pluginJson },
      [tree]: { body: treeBody },
      [payload]: { body: commitBody },
    }
    const gen: Gen = {
      seq: 0,
      payload,
      sig: 's'.repeat(64),
      adopted: { at: 1, by: 'seed', write: payload },
    }
    const identity: Identity = {
      id: 'solo',
      schema: 's'.repeat(64),
      gens: [gen],
      active: payload,
      born: { at: 1, by: 'seed' },
    }
    return { world: { defs, ids: { solo: identity } }, payload }
  }

  function rowOf(gen: Hash): EndpointRow {
    return {
      impl: 'solo',
      gen,
      cap: 'toy.echo',
      method: 'echo',
      transport: 'inproc',
      pid: 1,
      link: { call: async () => ({ ok: true, value: null }) } as unknown as EndpointRow['link'],
    }
  }

  it('路由器声明解析采纳注入 profile：默认 profile 解析不出 → 不可路由，自定义扩展名放行', () => {
    const { world, payload } = customEntryWorld()
    const endpoints = new EndpointTable()
    endpoints.add(rowOf(payload))
    // 默认 profile 不认 .custom 入口：声明读不出（fail-closed）→ 自能力路径 unresolved_cap
    expect(createRoundRouter({ endpoints }).resolve(world, 'solo', 'toy.echo', 'echo')).toEqual({
      ok: false,
      error: 'unresolved_cap',
    })
    // 注入 profile 后同一声明可解析，路由命中端点行
    const outcome = createRoundRouter({ endpoints, ecosystem: CUSTOM_PROFILE }).resolve(
      world,
      'solo',
      'toy.echo',
      'echo',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.row.impl).toBe('solo')
  })

  it('宿主保留面 identities / source.read 声明解析采纳注入 profile', async () => {
    const { world } = customEntryWorld()
    const baseDeps = {
      root: 'root',
      assetsDir: 'assets',
      blobsDir: 'blobs',
      runtimeDir: 'runtime',
      audits: new AuditIndex(),
      world: () => world,
      abortRun: () => false,
      startDetachedRun: () => ({ ok: true, run: 'r' }) as const,
      isStopping: () => false,
    }
    const defaultHost = createHostCapability(baseDeps)
    const customHost = createHostCapability({ ...baseDeps, ecosystem: CUSTOM_PROFILE })

    // 默认 profile 读不出声明：implements 为空、source.read 回 not_found
    expect(await defaultHost('identities', 'tester', null, 1000)).toMatchObject({
      ok: true,
      value: { list: [{ id: 'solo', implements: [] }] },
    })
    expect(
      await defaultHost('source.read', 'tester', { identity: 'solo', path: 'plugin.json' }, 1000),
    ).toMatchObject({ ok: false, code: 'not_found' })

    // 注入 profile 后声明可解析：implements 就位、source.read 读回源码
    expect(await customHost('identities', 'tester', null, 1000)).toMatchObject({
      ok: true,
      value: { list: [{ id: 'solo', implements: ['toy.echo'] }] },
    })
    expect(
      await customHost('source.read', 'tester', { identity: 'solo', path: 'plugin.json' }, 1000),
    ).toMatchObject({ ok: true, value: { path: 'plugin.json' } })
  })
})
