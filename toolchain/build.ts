// 打包接入：`node toolchain/build.ts <packageDir>`
// 读 `<pkg>/terms.src/*.json`（糖化源）→ 校验 → 降级 → 写 `<pkg>/terms/*.json`（运行期产物）。
// 宿主只执行 `plugin.json.build` 声明的命令，不解释糖化语义；糖化源应 `.worldignore` 排除。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lowerProgram } from './lower.ts'
import { validateProgram } from './validate.ts'
import type { Json } from './lower.ts'

const SRC = 'terms.src'
const OUT = 'terms'

export interface BuildResult {
  ok: boolean
  compiled: string[]
  issues: Array<{ path: string; message: string }>
}

/** 编译一个插件包：`terms.src/*.json` → `terms/*.json`；校验不过则不写产物。 */
export function buildPackage(dir: string): BuildResult {
  const pluginPath = join(dir, 'plugin.json')
  const plugin = existsSync(pluginPath)
    ? (JSON.parse(readFileSync(pluginPath, 'utf8')) as Record<string, unknown>)
    : {}
  const srcDir = join(dir, SRC)
  const terms: Record<string, Json> = {}
  if (existsSync(srcDir)) {
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.json')) continue
      terms[`${OUT}/${name}`] = JSON.parse(readFileSync(join(srcDir, name), 'utf8')) as Json
    }
  }
  const verdict = validateProgram({
    terms,
    implements: plugin['implements'] as string[] | undefined,
    pins: plugin['pins'] as Record<string, string> | undefined,
    methods: plugin['methods'] as Record<string, string[]> | undefined,
  })
  if (!verdict.ok) return { ok: false, compiled: [], issues: verdict.issues }

  const outDir = join(dir, OUT)
  mkdirSync(outDir, { recursive: true })
  const { asts } = lowerProgram(terms)
  const compiled: string[] = []
  for (const [path, ast] of Object.entries(asts)) {
    const name = path.slice(OUT.length + 1)
    const target = join(outDir, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(ast))
    compiled.push(`${OUT}/${name}`)
  }
  return { ok: true, compiled, issues: [] }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const dir = process.argv[2]
  if (dir === undefined) {
    process.stderr.write('usage: node build.ts <packageDir>\n')
    process.exitCode = 1
  } else {
    const result = buildPackage(dir)
    if (!result.ok) {
      for (const issue of result.issues) {
        process.stderr.write(`error ${issue.path}: ${issue.message}\n`)
      }
      process.exitCode = 1
    } else {
      process.stdout.write(
        `compiled ${result.compiled.length} term(s): ${result.compiled.join(', ')}\n`,
      )
    }
  }
}
