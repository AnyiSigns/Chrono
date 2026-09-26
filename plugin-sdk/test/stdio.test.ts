// stdio 形态端到端：SDK 起帧循环，spawn 子进程经服务协议握手、调用、反向调用与断连自退出。

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startService } from '../driver.ts'

const SDK_URL = new URL('../index.ts', import.meta.url).href

function makePackage(): string {
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
    intercept: (message) => link.settle(message),
    onDrain: () => link.failAll(),
    onClose: () => link.failAll(),
    handlers: {
      echo: (args) => ({ value: { echo: args }, events: [{ topic: 'echoed', payload: args }] }),
      ask: async () => ({ value: await link.call('dep', 'ping', {}), events: [] }),
    },
  })
}

if (isDirectRun(import.meta.url)) runStdio(createService, { log: () => {} })
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
})
