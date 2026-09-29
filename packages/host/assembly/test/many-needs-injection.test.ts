// many 成员表注入：stdio / inproc / worker 三形态下，服务工厂上下文拿到的 manyNeeds =
// `manyNeedsOf`（该身份 `needs` 中 `mode:"many"` 的能力类 → 世界提供方身份名，码元序）。
// stdio 走 spawn env `CHRONO_PLUGIN_MANY_NEEDS`，inproc / worker 走工厂 ctx。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { startAssembly } from '../runtime.ts'
import type { AssemblyRuntimeHandle } from '../runtime.ts'
import { manyNeedsOf } from '../index.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { ServiceLink } from '../../service-link.ts'
import type { Hash, Json, World } from '../../../kernel/index.ts'

type Form = 'stdio' | 'inproc' | 'worker'

const FORMS: readonly Form[] = ['stdio', 'inproc', 'worker']

/**
 * 三形态共用的 toy 服务：`read` 回 `ctx.manyNeeds`（inproc / worker 由宿主传入；stdio 无该字段时
 * 回落读 `process.env.CHRONO_PLUGIN_MANY_NEEDS`）。自起帧循环，不依赖 plugin-sdk。
 */
const MANY_SERVICE_MAIN = `import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROTOCOL_VERSION = '1'
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(name) {
  try { return JSON.parse(readFileSync(join(packageRoot, name), 'utf8')) } catch { return {} }
}

function manyNeedsOf(ctx) {
  if (ctx && ctx.manyNeeds !== undefined) return ctx.manyNeeds
  const raw = process.env.CHRONO_PLUGIN_MANY_NEEDS
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) } catch { return null }
}

export function createService(ctx) {
  function manifest() {
    const plugin = readJson('plugin.json')
    return { v: PROTOCOL_VERSION, identity: plugin.identity, implements: plugin.implements, methods: plugin.methods, protocol: plugin.protocol, state: plugin.state }
  }
  function handle(message) {
    if (message === null || typeof message !== 'object') return
    switch (message.kind) {
      case 'hello': ctx.emit(Object.assign({ id: message.id, kind: 'manifest' }, manifest())); return
      case 'probe': ctx.emit({ id: message.id, kind: 'pong', ok: true }); return
      case 'reload': ctx.emit({ v: PROTOCOL_VERSION, id: message.id, kind: 'ack' }); return
      case 'drain': ctx.emit({ v: PROTOCOL_VERSION, id: message.id, kind: 'bye' }); return
      case 'call': ctx.emit({ v: PROTOCOL_VERSION, id: message.id, kind: 'result', ok: true, value: { manyNeeds: manyNeedsOf(ctx) } }); return
    }
  }
  return { receive: handle, close() {} }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const frame = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const head = Buffer.allocUnsafe(4)
    head.writeUInt32BE(body.length, 0)
    process.stdout.write(Buffer.concat([head, body]))
  }
  const instance = createService({ emit: frame })
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      const body = buffer.subarray(4, 4 + length).toString('utf8')
      buffer = buffer.subarray(4 + length)
      try { instance.receive(JSON.parse(body)) } catch {}
    }
  })
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))
}
`

describe('many 成员表：三形态注入服务工厂上下文', () => {
  const handles: AssemblyRuntimeHandle[] = []
  const roots: string[] = []

  beforeEach(() => {
    handles.length = 0
    roots.length = 0
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      try {
        await handle.stop()
      } catch {
        // 尽力停机
      }
    }
    handles.length = 0
    for (const dir of roots.splice(0)) await cleanupTempRoot(dir)
  })

  /** 在独立 root 里 seed 两个 `tool-provider` 提供方 + 一个 `many` 消费方，按 transport 起装配。 */
  async function startForm(
    transport: Form,
  ): Promise<{ handle: AssemblyRuntimeHandle; world: World; root: string }> {
    const root = createTempRoot()
    roots.push(root)
    const start = transport === 'stdio' ? 'node execute/main.mjs' : 'execute/main.mjs'
    const providerA = writeTempPackage(root, {
      identity: 'many-provider-a',
      implements: ['tool-provider'],
      methods: { 'tool-provider': ['describe', 'invoke'] },
    })
    const providerB = writeTempPackage(root, {
      identity: 'many-provider-b',
      implements: ['tool-provider'],
      methods: { 'tool-provider': ['describe', 'invoke'] },
    })
    const consumer = writeTempPackage(root, {
      identity: 'many-consumer',
      implements: ['toy.many'],
      methods: { 'toy.many': ['read'] },
      needs: { 'tool-provider': { mode: 'many', methods: ['describe', 'invoke'] } },
      start,
      transport,
      files: { 'execute/main.mjs': MANY_SERVICE_MAIN },
    })
    const report = runSeed(root, [
      { name: 'many-consumer', path: consumer },
      { name: 'many-provider-a', path: providerA },
      { name: 'many-provider-b', path: providerB },
    ])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const handle = await startAssembly({ root, world, log: () => {} })
    handles.push(handle)
    return { handle, world, root }
  }

  it('stdio / inproc / worker 下服务读到的 manyNeeds 等于 manyNeedsOf', async () => {
    for (const transport of FORMS) {
      const { handle, world, root } = await startForm(transport)
      const expected = manyNeedsOf(world, 'many-consumer', hostPaths(root).blobsDir)
      expect(expected, `${transport} many 成员表应存在`).toEqual({
        'tool-provider': ['many-provider-a', 'many-provider-b'],
      })

      const gen = world.ids['many-consumer'].active as Hash
      const row = handle.endpoints.get('many-consumer', gen, 'toy.many', 'read')
      expect(row, `${transport} 端点行应在`).not.toBeNull()
      const link = row!.link as unknown as ServiceLink
      const response = await link.call('toy.many', 'read', null, 5000)
      expect(response.ok, `${transport} read 应成功`).toBe(true)
      const value = response.ok ? (response.value as Json) : null
      expect((value as { manyNeeds: Json }).manyNeeds, `${transport} ctx.manyNeeds`).toEqual(
        expected,
      )
      await link.drain(200, 2000)
    }
  }, 40000)

  it('成员变更（新增提供方）= 世界变更 → 重解析重注入消费方成员表', async () => {
    const root = createTempRoot()
    roots.push(root)
    const consumer = writeTempPackage(root, {
      identity: 'many-consumer',
      implements: ['toy.many'],
      methods: { 'toy.many': ['read'] },
      needs: { 'tool-provider': { mode: 'many', methods: ['describe', 'invoke'] } },
      start: 'node execute/main.mjs',
      transport: 'stdio',
      files: { 'execute/main.mjs': MANY_SERVICE_MAIN },
    })
    const providerA = writeTempPackage(root, {
      identity: 'many-provider-a',
      implements: ['tool-provider'],
      methods: { 'tool-provider': ['describe', 'invoke'] },
    })
    expect(
      runSeed(root, [
        { name: 'many-consumer', path: consumer },
        { name: 'many-provider-a', path: providerA },
      ]).ok,
    ).toBe(true)
    let world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const handle = await startAssembly({ root, world, log: () => {} })
    handles.push(handle)
    const gen = world.ids['many-consumer'].active as Hash

    /** 经端点反向读回消费方当刻注入的成员表（每次调用后 drain，避免端口在途悬挂）。 */
    const readMany = async (): Promise<Json> => {
      const row = handle.endpoints.get('many-consumer', gen, 'toy.many', 'read')
      expect(row).not.toBeNull()
      const link = row!.link as unknown as ServiceLink
      const response = await link.call('toy.many', 'read', null, 5000)
      await link.drain(200, 2000)
      expect(response.ok).toBe(true)
      return (response.ok ? (response.value as { manyNeeds: Json }).manyNeeds : null) as Json
    }
    expect(await readMany()).toEqual({ 'tool-provider': ['many-provider-a'] })

    // 新增提供方 B：世界变更 → 消费方成员集变化 → 强制重注入（进程换代重启）。
    const providerB = writeTempPackage(root, {
      identity: 'many-provider-b',
      implements: ['tool-provider'],
      methods: { 'tool-provider': ['describe', 'invoke'] },
    })
    expect(runSeed(root, [{ name: 'many-provider-b', path: providerB }]).ok).toBe(true)
    world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    await handle.applyWorld(world)
    expect(await readMany()).toEqual({
      'tool-provider': ['many-provider-a', 'many-provider-b'],
    })
  }, 40000)
})
