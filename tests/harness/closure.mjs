// 真实 pin 闭包计算：从 `chat` 出发沿 `plugins/*/plugin.json` 的 `pins` 走完全程（host 保留身份不计）。
// `pins` 是 DAG 闭包边；`needs` 不建闭包边，但 boot 需为闭包内身份的 needs 目标提供提供方（桩 / 替身），
// 故另有 `computeNeedsTargets` 求「needs 目标提供方」集合并与 pin 闭包求并。Rust 构件的同身份 toy 映射在此登记。

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
  'embedding-local': 'toy-embedding-local',
  'evolve-evidence': 'toy-evolve-evidence',
  'evolve-ledger': 'toy-evolve-ledger',
  'evolve-shadow': 'toy-evolve-shadow',
  'evolve-sweep': 'toy-evolve-sweep',
  'query-plan': 'toy-query-plan',
  rerank: 'toy-rerank',
  'sandbox-exec': 'toy-sandbox-exec',
  'sandbox-fs': 'toy-sandbox-fs',
  'sandbox-policy': 'toy-sandbox-policy',
  tokenizer: 'toy-tokenizer',
}

/**
 * 保留原生实现（不挂 toy）的 Rust 身份：`token-estimate` 的计数唯一实现在原生扩展，
 * 夹具预置该扩展产物即可，无需 JS 替身（其真值语义（真实计数）是上下文装配的输入）。
 */
export const NATIVE_CARGO_IDENTITIES = new Set(['token-estimate'])

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

/** 能力类 → 提供方身份名列表（字典序）。同一能力类可有多个提供方（`many` 槽）。 */
export function providerIndex(pluginsDir = PLUGINS_DIR) {
  const { decls } = readPinGraph(pluginsDir)
  const index = {}
  for (const [identity, { decl }] of Object.entries(decls)) {
    for (const capability of decl.implements ?? []) {
      if (index[capability] === undefined) index[capability] = []
      index[capability].push(identity)
    }
  }
  for (const list of Object.values(index)) list.sort()
  return index
}

/**
 * 从给定身份集合出发，求「needs 目标提供方」的传递集合（不含起点自身）。
 * `needs` 不建 DAG 闭包边，但 boot 时每个身份的 `one` / `many` 需求都需提供方存在（`one` 唯一）；
 * 故把每个需求能力类的**全部**提供方纳入，并递归展开（提供方自身也有 needs）。
 * 起点集合也要展开（闭包内身份的 needs 目标同样需在场）。
 */
export function computeNeedsTargets(identities, pluginsDir = PLUGINS_DIR) {
  const { decls } = readPinGraph(pluginsDir)
  const providers = providerIndex(pluginsDir)
  const visited = new Set()
  const targets = new Set()
  const stack = [...identities]
  while (stack.length > 0) {
    const current = stack.pop()
    if (visited.has(current)) continue
    visited.add(current)
    for (const capability of Object.keys(decls[current]?.decl?.needs ?? {})) {
      for (const provider of providers[capability] ?? []) {
        targets.add(provider)
        if (!visited.has(provider)) stack.push(provider)
      }
    }
  }
  return [...targets].sort()
}

/** e2e 世界的身份集：pin 闭包 ∪ 其 needs 目标提供方（传递），字典序。 */
export function computeWorldIdentities(start = 'chat', pluginsDir = PLUGINS_DIR) {
  const closure = computeClosure(start, pluginsDir)
  const needs = computeNeedsTargets(closure, pluginsDir)
  return [...new Set([...closure, ...needs])].sort()
}

/** 某身份的真实声明（供 bootWorld 生成原生替身 / 校验）；无可为 null。 */
export function readDecl(identity, pluginsDir = PLUGINS_DIR) {
  const { decls } = readPinGraph(pluginsDir)
  return decls[identity]?.decl ?? null
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
