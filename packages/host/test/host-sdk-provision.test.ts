// SDK 运行期供给验收：SDK 版 toy 服务在非仓库临时根下、无手工 `node_modules/plugin-sdk` 时，
// 由宿主在准备阶段把框架安装的 SDK 链接进物化树，三形态（stdio / inproc / worker）均可起服务并服务。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startAssembly } from '../assembly/runtime.ts'
import type { AssemblyRuntimeHandle } from '../assembly/runtime.ts'
import type { ServiceLink } from '../service-link.ts'
import { runSeed } from '../offline.ts'
import { loadAnchor } from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { FIXTURE_SDK_MAIN, writeTempPackage } from './test-helpers-ext.ts'
import type { Hash } from '../../kernel/index.ts'

type Form = 'stdio' | 'inproc' | 'worker'

const FORMS: readonly Form[] = ['stdio', 'inproc', 'worker']

describe('SDK 运行期供给（任意宿主根）', () => {
  let root: string
  let handle: AssemblyRuntimeHandle | null = null

  beforeEach(() => {
    root = createTempRoot()
    handle = null
  })

  afterEach(async () => {
    if (handle !== null) {
      try {
        await handle.stop()
      } catch {
        // 尽力停机
      }
    }
    await cleanupTempRoot(root)
  })

  it.each(FORMS)(
    '%s：物化树内供给 SDK，服务起得来且可调用',
    async (transport) => {
      const start = transport === 'stdio' ? 'node execute/main.mjs' : 'execute/main.mjs'
      const pkg = writeTempPackage(root, {
        identity: 'toy-sdk',
        implements: ['toy.sdk'],
        methods: { 'toy.sdk': ['echo'] },
        start,
        transport,
        files: { 'execute/main.mjs': FIXTURE_SDK_MAIN },
      })
      expect(runSeed(root, [{ name: 'toy-sdk', path: pkg }]).ok).toBe(true)
      // 临时根不是仓库：起服务前不得存在任何手工 node_modules
      expect(existsSync(join(root, 'node_modules'))).toBe(false)

      const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
      handle = await startAssembly({ root, world, log: () => {} })

      const gen = world.ids['toy-sdk'].active as Hash
      const row = handle.endpoints.get('toy-sdk', gen, 'toy.sdk', 'echo')
      expect(row, `${transport} 端点行应在`).not.toBeNull()
      const response = await (row!.link as unknown as ServiceLink).call(
        'toy.sdk',
        'echo',
        { n: 1 },
        5000,
      )
      expect(response.ok, `${transport} echo 应成功`).toBe(true)
      expect(response.ok ? response.value : null).toEqual({ echo: { n: 1 } })

      // 供给落点在物化树，根下仍无 node_modules
      const materialized = join(hostPaths(root).materializedDir, gen)
      expect(existsSync(join(materialized, 'node_modules', 'plugin-sdk', 'package.json'))).toBe(
        true,
      )
      expect(existsSync(join(root, 'node_modules'))).toBe(false)
    },
    20000,
  )
})
