// stdio 形态端到端：SDK 起帧循环，spawn 子进程经服务协议握手、调用、反向调用与断连自退出。

import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startService } from '../driver.ts'

const SDK_URL = new URL('../index.ts', import.meta.url).href

function makePackage(options: { failClosed?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-sdk-stdio-'))
  mkdirSync(join(dir, 'execute'), { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      identity: 'toy',
      implements: ['toy'],
      methods: { toy: ['echo', 'ask'] },
      protocol: '1',
      state: 'recomputable',
    }),
  )
  const runOptions = options.failClosed
    ? `{ log: () => {}, onMalformedFrame: 'exit' }`
    : `{ log: () => {} }`
  writeFileSync(
    join(dir, 'execute', 'main.ts'),
    `import { PortLink, createService as sdk, isDirectRun, runStdio } from ${JSON.stringify(SDK_URL)}
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

export function createService(ctx) {
  const link = new PortLink({ write: ctx.emit, idPrefix: 'toy' })
  return sdk({
    pluginRoot: root,
    capability: 'toy',
    emit: ctx.emit,
    log: () => {},
    eventIdPrefix: 'toy-evt',
    portLinks: [link],
    handlers: {
      echo: (args) => ({ value: { echo: args }, events: [{ topic: 'echoed', payload: args }] }),
      ask: async () => ({ value: await link.call('dep', 'ping', {}), events: [] }),
    },
  })
}

if (isDirectRun(import.meta.url)) runStdio(createService, ${runOptions})
`,
  )
  return dir
}

describe('stdio 形态', () => {
  it('握手 / 调用 / 事件 / 反向调用 / 断连自退出', async () => {
    const dir = makePackage()
    const drv = startService({ entry: join(dir, 'execute', 'main.ts'), cwd: dir })
    try {
      const manifest = await drv.hello('toy')
      expect(manifest['identity']).toBe('toy')
      expect(manifest['methods']).toEqual({ toy: ['echo', 'ask'] })

      const echoed = await drv.call('toy', 'echo', { a: 1 }, { run: 'r', thread: null, now: 7 })
      expect(echoed['kind']).toBe('result')
      expect(echoed['value']).toEqual({ echo: { a: 1 } })
      expect(drv.events.map((event) => event['topic'])).toEqual(['echoed'])
      expect(drv.events[0]['id']).toBe('toy-evt-1')

      const asked = await drv.call('toy', 'ask', {})
      expect(asked['value']).toEqual({ ok: true, value: null })
      expect(drv.portCalls.map((frame) => [frame['port'], frame['method']])).toEqual([
        ['dep', 'ping'],
      ])

      expect((await drv.request('probe', {}, 'pong'))['ok']).toBe(true)
      expect((await drv.request('reload', { gen: 'g2' }, 'ack'))['kind']).toBe('ack')
      expect((await drv.request('drain', { deadline_ms: 100 }, 'bye'))['kind']).toBe('bye')

      drv.close()
      expect(await drv.exit).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stdin EOF 即自退出（无孤儿端点）', async () => {
    const dir = makePackage()
    const drv = startService({ entry: join(dir, 'execute', 'main.ts'), cwd: dir })
    try {
      await drv.hello('toy')
      drv.close()
      expect(await drv.exit).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drain 后自退出：不等 stdin 关闭', async () => {
    const dir = makePackage()
    const drv = startService({ entry: join(dir, 'execute', 'main.ts'), cwd: dir })
    try {
      await drv.hello('toy')
      const bye = await drv.request('drain', { deadline_ms: 100 }, 'bye')
      expect(bye['kind']).toBe('bye')
      expect(await drv.exit).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('坏帧默认忽略：后续帧照常处理', async () => {
    const dir = makePackage()
    const drv = startService({ entry: join(dir, 'execute', 'main.ts'), cwd: dir })
    try {
      const bad = Buffer.alloc(4 + 5)
      bad.writeUInt32BE(5, 0)
      bad.write('{bad}', 4)
      drv.child.stdin?.write(bad)
      const manifest = await drv.hello('toy')
      expect(manifest['identity']).toBe('toy')
    } finally {
      drv.close()
      await drv.exit
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('onMalformedFrame: exit 坏帧 fail-closed 退出非 0', async () => {
    const dir = makePackage({ failClosed: true })
    const child = spawn(process.execPath, [join(dir, 'execute', 'main.ts')], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const bad = Buffer.alloc(4 + 5)
      bad.writeUInt32BE(5, 0)
      bad.write('{bad}', 4)
      child.stdin?.write(bad)
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
      expect(code).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
