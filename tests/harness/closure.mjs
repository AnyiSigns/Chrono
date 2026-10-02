// 真实依赖闭包计算：从 `chat` 出发沿 `plugins/*/plugin.json` 的 `needs` `one` 绑定解析提供方
// （唯一提供方即 DAG 闭包边；`host` 哨兵与 `many` 不计入单值闭包边），走完全程。
// boot 时闭包内身份的 `needs`（含 `many`）还需要提供方在场，故 `computeNeedsTargets` 另求
// 「needs 目标提供方」集合与闭包求并。Rust 构件的同身份 toy 映射在此登记。

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
  embedding: 'toy-embedding',
  'embedding-local': 'toy-embedding-local',
  'evolve-ledger': 'toy-evolve-ledger',
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

/**
 * 读 `plugins/` 下每个 `plugin.json`：`decls`（身份 → 目录 / 声明）与 `providers`
 * （能力类 → 提供方身份名列表，字典序；排除 `host` 哨兵）。
 */
export function readDeclGraph(pluginsDir = PLUGINS_DIR) {
  const decls = {}
  const providers = {}
  for (const name of readdirSync(pluginsDir)) {
    const manifest = join(pluginsDir, name, 'plugin.json')
    if (!existsSync(manifest)) continue
    const decl = readJson(manifest)
    decls[decl.identity] = { dir: join(pluginsDir, name), decl }
    for (const capability of decl.implements ?? []) {
      if (capability === 'host') continue
      if (providers[capability] === undefined) providers[capability] = []
      providers[capability].push(decl.identity)
    }
  }
  for (const list of Object.values(providers)) list.sort()
  return { decls, providers }
}

/** 从 `start` 出发的传递闭包（含起点）：沿 `needs` 的 `one` 绑定解析唯一提供方。字典序。 */
export function computeClosure(start = 'chat', pluginsDir = PLUGINS_DIR) {
  const { decls, providers } = readDeclGraph(pluginsDir)
  const seen = new Set([start])
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop()
    const needs = decls[current]?.decl?.needs ?? {}
    for (const [capability, need] of Object.entries(needs)) {
      if (need.mode !== 'one' || capability === 'host') continue
      const candidates = (providers[capability] ?? []).filter((id) => id !== current)
      // 只有唯一提供方才构成单值闭包边；0 / 多提供方由入世期按 unresolved / ambiguous 报出。
      if (candidates.length !== 1) continue
      if (!seen.has(candidates[0])) {
        seen.add(candidates[0])
        stack.push(candidates[0])
      }
    }
  }
  return [...seen].sort()
}

/** 能力类 → 提供方身份名列表（字典序）。同一能力类可有多个提供方（`many` 槽）。 */
export function providerIndex(pluginsDir = PLUGINS_DIR) {
  return readDeclGraph(pluginsDir).providers
}

/**
 * 从给定身份集合出发，求「needs 目标提供方」的传递集合（不含起点自身）。
 * `needs`（`one` 与 `many`）都需提供方在场（`one` 唯一）；故把每个需求能力类的**全部**
 * 提供方纳入，并递归展开（提供方自身也有 needs）。起点集合也要展开。
 */
export function computeNeedsTargets(identities, pluginsDir = PLUGINS_DIR) {
  const { decls, providers } = readDeclGraph(pluginsDir)
  const visited = new Set()
  const targets = new Set()
  const stack = [...identities]
  while (stack.length > 0) {
    const current = stack.pop()
    if (visited.has(current)) continue
    visited.add(current)
    for (const capability of Object.keys(decls[current]?.decl?.needs ?? {})) {
      if (capability === 'host') continue
      for (const provider of providers[capability] ?? []) {
        targets.add(provider)
        if (!visited.has(provider)) stack.push(provider)
      }
    }
  }
  return [...targets].sort()
}

/** e2e 世界的身份集：one-needs 闭包 ∪ 其 needs 目标提供方（传递），字典序。 */
export function computeWorldIdentities(start = 'chat', pluginsDir = PLUGINS_DIR) {
  const closure = computeClosure(start, pluginsDir)
  const needs = computeNeedsTargets(closure, pluginsDir)
  return [...new Set([...closure, ...needs])].sort()
}

/** 某身份的真实声明（供 bootWorld 生成原生替身 / 校验）；无可为 null。 */
export function readDecl(identity, pluginsDir = PLUGINS_DIR) {
  const { decls } = readDeclGraph(pluginsDir)
  return decls[identity]?.decl ?? null
}

/** 闭包里哪些身份含原生（cargo）构建声明。 */
export function cargoIdentities(identities, pluginsDir = PLUGINS_DIR) {
  const { decls } = readDeclGraph(pluginsDir)
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
