// 防再漂门禁（`judgment-as-data-plan.md` 步骤 8）：纯判定必须走 term（`plugin.json.judgments`），
// 不得只写在服务代码里。三条机械检查：
//  1) 判定登记表：全插件 `judgments` 集合须与本表一致（新增 / 移除判定必须显式改本表，防静默漂移）。
//  2) 判定产物：每条判定路径须是 `terms/` 下存在文件，且插件 `members` 含覆盖它的 `term` 成员。
//  3) 保留方法名：能力方法名 ∈ {judge, select, verdict, gate, score, rank} 时须由 term 承载
//     （显式豁免见 `METHOD_EXCEPTIONS`）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins')

/** 已迁 term 的判定登记表：`身份 → 能力类 → 方法名[]`。 */
const REGISTRY = {
  guard: { guard: ['judge'] },
  router: { router: ['select'] },
}

/** 判定味方法名：命中即须由 term 承载。 */
const JUDGMENT_METHODS = new Set(['judge', 'select', 'verdict', 'gate', 'score', 'rank'])

/** 显式豁免（合法但非判定的同名方法）：`<身份>.<方法>`。 */
const METHOD_EXCEPTIONS = new Set(['graph-gate.select', 'session.select'])

const pluginNames = () =>
  readdirSync(PLUGINS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

const readDecl = (name) => JSON.parse(readFileSync(join(PLUGINS, name, 'plugin.json'), 'utf8'))

test('判定登记表：全插件 `judgments` 集合与本表一致（防静默增删）', () => {
  const actual = {}
  for (const name of pluginNames()) {
    const decl = readDecl(name)
    if (decl.judgments === undefined || Object.keys(decl.judgments).length === 0) continue
    actual[name] = Object.fromEntries(
      Object.entries(decl.judgments).map(([cap, methods]) => [cap, Object.keys(methods).sort()]),
    )
  }
  assert.deepEqual(actual, REGISTRY, 'judgments 与登记表不一致：新增 / 移除判定须显式更新本表')
})

test('判定产物：路径在 terms/ 下、文件存在、members 含 term 成员覆盖', () => {
  for (const name of pluginNames()) {
    const decl = readDecl(name)
    const termMembers = (decl.members ?? []).filter((member) => member.kind === 'term')
    for (const [cap, methods] of Object.entries(decl.judgments ?? {})) {
      for (const [method, rel] of Object.entries(methods)) {
        assert.ok(
          rel.startsWith('terms/'),
          `${name}.${cap}.${method} 判定路径须在 terms/ 下：${rel}`,
        )
        assert.ok(existsSync(join(PLUGINS, name, rel)), `${name} 缺判定产物 ${rel}`)
        assert.ok(
          termMembers.some((member) => rel.startsWith(member.path)),
          `${name} 的 members 缺 term 成员覆盖 ${rel}`,
        )
      }
    }
  }
})

test('保留方法名须由 term 承载（显式豁免除外）', () => {
  const offenders = []
  for (const name of pluginNames()) {
    const decl = readDecl(name)
    for (const [cap, methods] of Object.entries(decl.methods ?? {})) {
      for (const method of methods) {
        if (!JUDGMENT_METHODS.has(method)) continue
        if (METHOD_EXCEPTIONS.has(`${name}.${method}`)) continue
        if (decl.judgments?.[cap]?.[method] === undefined)
          offenders.push(`${name}.${cap}.${method}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `保留方法名未由 term 承载且未显式豁免（防判定只写在服务代码里）：\n${offenders.join('\n')}`,
  )
})
