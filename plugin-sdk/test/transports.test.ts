// 三形态接口：同一 SDK 服务入口既可被宿主 inproc 直调，也可经宿主 worker 引导载入。
// stdio 形态在 stdio.test.ts 覆盖；本文件用宿主的实际加载口验证另外两种。

import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import type { Json, Rec } from '../json.ts'

const SDK_URL = new URL('../index.ts', import.meta.url).href
const WORKER_BOOTSTRAP = new URL(
  '../../packages/host/assembly/worker-bootstrap.mjs',
  import.meta.url,
)

function makePackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-sdk-transport-'))
  mkdirSync(join(dir, 'execute'), { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      identity: 'toy',
      implements: ['toy'],
      methods: { toy: ['echo'] },
      protocol: '1',
      state: 'recomputable',
    }),
  )
  writeFileSync(
    join(dir, 'execute', 'main.ts'),
    `import { createService as sdk, isDirectRun, runStdio } from ${JSON.stringify(SDK_URL)}
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

export function createService(ctx) {
  return sdk({
    pluginRoot: root,
    capability: 'toy',
    emit: ctx.emit,
    log: () => {},
    handlers: {
      echo: (args) => ({ value: { echo: args }, events: [] }),
    },
  })
}

if (isDirectRun(import.meta.url)) runStdio(createService, { log: () => {} })
`,
  )
  return dir
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timeout')
}

describe('三形态接口', () => {
  it('inproc：宿主 import 入口后经 createService 直调', async () => {
    const dir = makePackage()
    try {
      const module = (await import(pathToFileURL(join(dir, 'execute', 'main.ts')).href)) as {
        createService: (ctx: { emit: (m: Json) => void; env: Record<string, string> }) => {
          receive: (m: Json) => void
        }
      }
      const sent: Rec[] = []
      const instance = module.createService({ emit: (m) => sent.push(m as Rec), env: {} })
      instance.receive({ id: 'h', kind: 'hello', impl: 'toy', gen: 'g' })
      await waitFor(() => sent.length > 0, 2000)
      expect(sent[0]['kind']).toBe('manifest')
      expect(sent[0]['identity']).toBe('toy')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('worker：宿主 worker 引导载入同一入口并回 manifest', async () => {
    const dir = makePackage()
    const worker = new Worker(WORKER_BOOTSTRAP, {
      workerData: { entry: join(dir, 'execute', 'main.ts'), env: {} },
    })
    try {
      const received: Rec[] = []
      worker.on('message', (message) => received.push(message as Rec))
      worker.postMessage({ v: '1', id: 'h', kind: 'hello', impl: 'toy', gen: 'g' })
      await waitFor(() => received.length > 0, 5000)
      expect(received[0]['kind']).toBe('manifest')
      expect(received[0]['identity']).toBe('toy')
    } finally {
      await worker.terminate()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
