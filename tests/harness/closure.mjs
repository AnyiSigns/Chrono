// 真实 pin 闭包计算：从 `chat` 出发沿 `plugins/*/plugin.json` 的 `pins` 走完全程（host 保留身份不计）。
// 不信任任何文档里的规模数字；结果即世界装配所需身份集。Rust 构件的同身份 toy 映射在此登记。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PLUGINS_DIR = join(REPO_ROOT, 'plugins')
export const FIXTURE_PLUGINS_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'plugins')

/** 需要同身份 toy 替代的实现，键 = 真实身份名，值 = 夹具目录名。 */
export const TOY_OVERRIDES = {
  'tool-fs': 'toy-tool-fs',
  sandbox: 'toy-sandbox',
  workspace: 'toy-workspace',
  'memory-retrieval': 'toy-memory-retrieval',
  'evolve-metrics': 'toy-evolve-metrics',
  embedding: 'toy-embedding',
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 读 `plugins/` 下每个 `plugin.json` 的 pins（host 保留身份剔除）。 */
export function readPinGraph(pluginsDir = PLUGINS_DIR) {
  const graph = {}
  const decls = {}
  for (const name of readdirSync(pluginsDir)) {
    const manifest = join(pluginsDir, name, 'plugin.json')
    if (!existsSync(manifest)) continue
    const decl = readJson(manifest)
    const pins = {}
    for (const [logical, target] of Object.entries(decl.pins ?? {})) {
      if (target === 'host') continue
      pins[logical] = target
    }
    graph[decl.identity] = pins
    decls[decl.identity] = { dir: join(pluginsDir, name), decl }
  }
  return { graph, decls }
}

/** 从 `start` 出发的传递闭包（含起点），字典序。 */
export function computeClosure(start = 'chat', pluginsDir = PLUGINS_DIR) {
  const { graph } = readPinGraph(pluginsDir)
  const seen = new Set([start])
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const target of Object.values(graph[current] ?? {})) {
      if (!seen.has(target)) {
        seen.add(target)
        stack.push(target)
      }
    }
  }
  return [...seen].sort()
}

/** 闭包里哪些身份含原生（cargo）构建声明。 */
export function cargoIdentities(identities, pluginsDir = PLUGINS_DIR) {
  const { decls } = readPinGraph(pluginsDir)
  const out = []
  for (const id of identities) {
    const build = decls[id]?.decl?.build ?? []
    if (build.some((step) => String(step.cmd).includes('cargo'))) out.push(id)
  }
  return out
}

/** 某身份在闭包内是否有同身份 toy 替身。 */
export function toyFor(identity) {
  const name = TOY_OVERRIDES[identity]
  return name === undefined ? null : join(FIXTURE_PLUGINS_DIR, name)
}

/** 某身份在 e2e 里应使用的包目录（toy 优先）。 */
export function sourceDirFor(identity, pluginsDir = PLUGINS_DIR) {
  return toyFor(identity) ?? join(pluginsDir, identity)
}

/** 夹具插件目录绝对路径。 */
export function fixturePluginDir(name) {
  return join(FIXTURE_PLUGINS_DIR, name)
}
