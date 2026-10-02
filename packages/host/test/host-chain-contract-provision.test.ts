// 契约包运行期供给验收：契约版 toy 服务在非仓库临时根下、无手工 `node_modules/chain-contract` 时，
// 由宿主在准备阶段把框架安装的契约包链接进物化树，三形态（stdio / inproc / worker）均可起服务并服务，
// 服务运行期裸导入 `chain-contract` 的导出（CONTRACT_VERSION / checkContractVersion）可用。

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
import { FIXTURE_CONTRACT_MAIN, writeTempPackage } from './test-helpers-ext.ts'
import type { Hash } from '../../kernel/index.ts'

type Form = 'stdio' | 'inproc' | 'worker'

const FORMS: readonly Form[] = ['stdio', 'inproc', 'worker']

describe('契约包运行期供给（任意宿主根）', () => {
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
    '%s：物化树内供给 chain-contract，服务裸导入可用',
    async (transport) => {
      const start = transport === 'stdio' ? 'node execute/main.mjs' : 'execute/main.mjs'
      const pkg = writeTempPackage(root, {
        identity: 'toy-contract',
        implements: ['toy.contract'],
        methods: { 'toy.contract': ['echo'] },
        start,
        transport,
        files: { 'execute/main.mjs': FIXTURE_CONTRACT_MAIN },
      })
      expect(runSeed(root, [{ name: 'toy-contract', path: pkg }]).ok).toBe(true)
      // 临时根不是仓库：起服务前不得存在任何手工 node_modules
      expect(existsSync(join(root, 'node_modules'))).toBe(false)

      const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
      handle = await startAssembly({ root, world, log: () => {} })

      const gen = world.ids['toy-contract'].active as Hash
      const row = handle.endpoints.get('toy-contract', gen, 'toy.contract', 'echo')
      expect(row, `${transport} 端点行应在`).not.toBeNull()
      const response = await (row!.link as unknown as ServiceLink).call(
        'toy.contract',
        'echo',
        { n: 1 },
        5000,
      )
      expect(response.ok, `${transport} echo 应成功`).toBe(true)
      expect(response.ok ? response.value : null).toEqual({
        echo: { n: 1 },
        contract: '1.0',
        checked: true,
      })

      // 供给落点在物化树，根下仍无 node_modules
      const materialized = join(hostPaths(root).materializedDir, gen)
      expect(
        existsSync(join(materialized, 'node_modules', 'chain-contract', 'package.json')),
      ).toBe(true)
      expect(existsSync(join(root, 'node_modules'))).toBe(false)
    },
    20000,
  )
})
