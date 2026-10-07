// 兼容性门禁：换代码世代前，对每个以 `needs.mode='one'` 指向该身份的消费方，
// 校验新提供方是否仍覆盖其声明的方法契约（消费方 `needs.methods`，或拥有方 `slots[cap].methods`）。
// 不满足即整次换代拒绝、旧版继续服务。纯数据世代（term / schema）不触发（此处只比较声明面）。
// 本模块只读世界与磁盘包，不落账。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../common/json.ts'
import { needsBindingsOf, parsePluginDecl, readPluginDecl } from './decl.ts'
import type { PluginDecl } from './decl.ts'
import { DEFAULT_ECOSYSTEM } from './ecosystem.ts'
import type { EcosystemProfile } from './ecosystem.ts'
import { resolveEntryRoot } from './ingest.ts'
import type { PluginEntry } from './ingest.ts'
import type { Json, World } from '../../kernel/index.ts'

/** 读包根磁盘上的新 `plugin.json`；读不出 / 非法返回 null。 */
function readNextDecl(
  root: string,
  entry: PluginEntry,
  ecosystem: EcosystemProfile,
): PluginDecl | null {
  const pkgRoot = resolveEntryRoot(root, entry)
  if (pkgRoot === null) return null
  const file = join(pkgRoot, 'plugin.json')
  if (!existsSync(file)) return null
  let parsed: Json
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Json
  } catch {
    return null
  }
  const result = parsePluginDecl(parsed, ecosystem)
  return result.ok ? result.decl : null
}

/**
 * 校验「换代到 `entry` 声明的新提供方」是否对既有消费方兼容。
 * 返回违规原因列表；空 = 兼容（放行）。
 */
export function checkCompatibility(
  root: string,
  world: World,
  entry: PluginEntry,
  blobsDir: string | undefined,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): string[] {
  const next = readNextDecl(root, entry, ecosystem)
  if (next === null) return []
  const provider = next.identity
  const oldProvider = readPluginDecl(world, provider, blobsDir, ecosystem)
  const out: string[] = []
  for (const consumerId of Object.keys(world.ids).sort()) {
    if (consumerId === provider) continue
    const consumer = readPluginDecl(world, consumerId, blobsDir, ecosystem)
    if (consumer === null) continue
    const bindings = needsBindingsOf(world, consumer.gen)
    for (const cap of Object.keys(consumer.decl.needs).sort()) {
      const need = consumer.decl.needs[cap]
      if (need.mode !== 'one') continue
      if (bindings[cap] !== provider) continue
      if (!next.implements.includes(cap)) {
        out.push(`incompatible_cap:${consumerId}:${cap}`)
        continue
      }
      if (need.methods !== undefined) {
        const available = next.methods[cap] ?? next.slots[cap]?.methods ?? []
        const missing = need.methods.filter((method) => !available.includes(method))
        if (missing.length > 0) {
          out.push(`incompatible_methods:${consumerId}:${cap}:${missing.join(',')}`)
        }
        continue
      }
      // 无自带方法的 `one`：契约在拥有方 `slots`。新契约须覆盖旧契约的方法集。
      const oldContract = oldProvider?.decl.slots[cap]?.methods
      if (oldContract === undefined) continue
      const newContract = next.slots[cap]?.methods ?? next.methods[cap] ?? []
      const missing = oldContract.filter((method) => !newContract.includes(method))
      if (missing.length > 0) out.push(`incompatible_contract:${cap}:${missing.join(',')}`)
    }
  }
  return out
}
