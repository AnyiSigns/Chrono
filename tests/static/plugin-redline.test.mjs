// 仓库级静态门禁（红线）：
// 1) 框架运行期不得 import `toolchain`（toolchain 只由 CLI 子命令 / 插件 `build` 触发）；
// 2) 插件运行期源码不得 import `packages/*`（插件只经线协议 + `needs` 通信）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** 递归收集目录下的代码文件（.ts/.js/.mjs/.cjs），缺目录返回空。 */
function collectCode(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    if (!/\.(ts|js|mjs|cjs)$/.test(entry.name)) continue
    out.push(join(entry.parentPath ?? entry.path, entry.name))
  }
  return out
}

/** 是否测试 / 构建配置文件（不参与运行期红线）。 */
function isTestFile(file) {
  const norm = file.replace(/\\/g, '/')
  return norm.includes('/test/') || norm.endsWith('.test.ts') || norm.endsWith('vitest.config.ts')
}

test('框架运行期不 import toolchain', () => {
  const files = collectCode(join(ROOT, 'packages'))
  for (const file of files) {
    if (isTestFile(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:import|export)[^'\n]*from\s+'([^']+)'/g)) {
      assert.doesNotMatch(match[1], /toolchain/, `${file} 运行期 import 了 toolchain: ${match[1]}`)
    }
  }
})

test('插件运行期源码不 import packages/*', () => {
  // 仓库不含生产插件；夹具即插件源码的取样（`fixtures/plugins/**`）。
  const roots = [join(ROOT, 'fixtures', 'plugins')]
  for (const root of roots) {
    for (const file of collectCode(root)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/(?:import|require)[^'\n]*?['"]([^'"]+)['"]/g)) {
        const spec = match[1]
        assert.doesNotMatch(spec, /packages\//, `${file} 插件源码 import 了 packages/*: ${spec}`)
      }
    }
  }
})
