// defineService：声明式入口返回宿主 inproc / worker 直调工厂；direct-run 自起 stdio 帧循环。

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { defineService } from '../service.ts'
import { startService } from '../driver.ts'
import type { Json, Rec } from '../json.ts'

const SDK_URL = new URL('../index.ts', import.meta.url).href

function makePackage(methods: string[] = ['echo']): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-sdk-define-'))
  mkdirSync(join(dir, 'execute'), { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      identity: 'toy',
      implements: ['toy'],
      methods: { toy: methods },
      protocol: '1',
      state: 'recomputable',
    }),
  )
  return dir
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

function last(sent: Rec[]): Rec {
  return sent[sent.length - 1]
}

describe('defineService', () => {
  it('返回工厂：pluginRoot / capability / handlers / eventIdPrefix 生效', async () => {
    const dir = makePackage()
    try {
      const sent: Rec[] = []
      let seenCapability = ''
      const factory = defineService({
        entry: pathToFileURL(join(dir, 'execute', 'main.ts')).href,
        capability: 'toy',
        logPrefix: 'toy',
        setup: (_ctx, capability) => {
          seenCapability = capability
          return {
            handlers: {
              echo: (args) => ({
                value: { capability, args },
                events: [{ topic: 't', payload: 1 }],
              }),
            },
            eventIdPrefix: 'toy-evt',
          }
        },
      })
      const instance = factory({ emit: (message) => sent.push(message as Rec), env: {} })
      instance.receive({ v: '1', id: 'h', kind: 'hello', impl: 'toy' })
      await tick()
      expect(sent[0]).toMatchObject({
        kind: 'manifest',
        identity: 'toy',
        methods: { toy: ['echo'] },
      })
      instance.receive({
        v: '1',
        id: 'c',
        kind: 'call',
        port: 'toy',
        method: 'echo',
        args: { a: 1 },
      })
      await tick()
      expect(seenCapability).toBe('toy')
      expect(sent[1]).toMatchObject({ kind: 'event', id: 'toy-evt-1' })
      expect(last(sent)).toMatchObject({
        kind: 'result',
        value: { capability: 'toy', args: { a: 1 } },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('direct-run 起 stdio：握手 / 调用 / 断连自退出', async () => {
    const dir = makePackage()
    try {
      writeFileSync(
        join(dir, 'execute', 'main.ts'),
        `import { defineService } from ${JSON.stringify(SDK_URL)}

export const createService = defineService({
  entry: import.meta.url,
  capability: 'toy',
  logPrefix: 'toy',
  setup: () => ({
    handlers: {
      echo: (args) => ({ value: args, events: [] }),
    },
  }),
})
`,
      )
      const drv = startService({ entry: join(dir, 'execute', 'main.ts'), cwd: dir })
      try {
        const manifest = await drv.hello('toy')
        expect(manifest['identity']).toBe('toy')
        const result = await drv.call('toy', 'echo', { a: 1 } as Json)
        expect(result['value']).toEqual({ a: 1 })
        drv.close()
        expect(await drv.exit).toBe(0)
      } finally {
        drv.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
