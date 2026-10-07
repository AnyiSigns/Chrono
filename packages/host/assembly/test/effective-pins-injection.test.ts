// 有效 pins 注入：stdio / inproc / worker 三形态下，服务工厂上下文拿到的 pins = effectivePins
// （该身份代码世代 `commit.body.meta.needs` 的 `one` 绑定）。stdio 走 spawn env，inproc / worker 走工厂 ctx。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { startAssembly } from '../runtime.ts'
import type { AssemblyRuntimeHandle } from '../runtime.ts'
import { effectivePins } from '../index.ts'
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
 * 三形态共用的 toy 服务：`read` 回 `ctx.pins`（inproc / worker 由宿主传入；stdio 无该字段时
 * 回落读 `process.env.CHRONO_PLUGIN_PINS`）。自起帧循环，不依赖 plugin-sdk。
 */
const PINS_SERVICE_MAIN = `import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROTOCOL_VERSION = '1'
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(name) {
  try { return JSON.parse(readFileSync(join(packageRoot, name), 'utf8')) } catch { return {} }
}

function pinsOf(ctx) {
  if (ctx && ctx.pins !== undefined) return ctx.pins
  const raw = process.env.CHRONO_PLUGIN_PINS
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
      case 'call': ctx.emit({ v: PROTOCOL_VERSION, id: message.id, kind: 'result', ok: true, value: { pins: pinsOf(ctx) } }); return
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

describe('有效 pins：三形态注入服务工厂上下文', () => {
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

  /** 在独立 root 里 seed 提供方 `title` + 消费方 `pins-consumer`（one-need title），按 transport 起装配。 */
  async function startForm(
    transport: Form,
  ): Promise<{ handle: AssemblyRuntimeHandle; world: World; root: string }> {
    const root = createTempRoot()
    roots.push(root)
    const start = transport === 'stdio' ? 'node execute/main.mjs' : 'execute/main.mjs'
    const provider = writeTempPackage(root, {
      identity: 'pins-provider',
      implements: ['title'],
      methods: { title: ['get'] },
    })
    const consumer = writeTempPackage(root, {
      identity: 'pins-consumer',
      implements: ['toy.pins'],
      methods: { 'toy.pins': ['read'] },
      needs: { title: { mode: 'one' } },
      start,
      transport,
      files: { 'execute/main.mjs': PINS_SERVICE_MAIN },
    })
    const report = runSeed(root, [
      { name: 'pins-consumer', path: consumer },
      { name: 'pins-provider', path: provider },
    ])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const handle = await startAssembly({ root, world, log: () => {} })
    handles.push(handle)
    return { handle, world, root }
  }

  it('stdio / inproc / worker 下服务读到的 pins 等于 effectivePins', async () => {
    for (const transport of FORMS) {
      const { handle, world, root } = await startForm(transport)
      const expected = effectivePins(world, 'pins-consumer', hostPaths(root).blobsDir)
      expect(expected, `${transport} 有效 pins 应存在`).toEqual({ title: 'pins-provider' })

      const gen = world.ids['pins-consumer'].active as Hash
      const row = handle.endpoints.get('pins-consumer', gen, 'toy.pins', 'read')
      expect(row, `${transport} 端点行应在`).not.toBeNull()
      const link = row!.link as unknown as ServiceLink
      const response = await link.call('toy.pins', 'read', null, 5000)
      expect(response.ok, `${transport} read 应成功`).toBe(true)
      const value = response.ok ? (response.value as Json) : null
      expect((value as { pins: Json }).pins, `${transport} ctx.pins`).toEqual(expected)
      await link.drain(200, 2000)
    }
  }, 30000)
})
