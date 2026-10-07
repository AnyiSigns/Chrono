// 框架包构建：tsc 产出 dist（packages / plugin-sdk / toolchain），
// 再把 SDK 的非 TS 资产（package.json / rust / tools / README）与 toolchain 文档拷进 dist。
// 只清 dist（构建产物），绝不触碰源码；rust/target 与 node_modules 排除在外。

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = join(ROOT, 'dist')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    process.stderr.write(`build failed: ${command} ${args.join(' ')} (code=${result.status})\n`)
    process.exit(result.status ?? 1)
  }
}

/** 复制目录并按相对路径过滤（排除顶层的 rust/target 与任意 node_modules）。 */
function copyFiltered(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = src
        .slice(from.length)
        .split(/[\\/]/)
        .filter((part) => part.length > 0)
      if (rel.includes('node_modules')) return false
      if (rel[0] === 'target') return false
      return true
    },
  })
}

function main() {
  rmSync(DIST, { recursive: true, force: true })
  run(process.execPath, [
    join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    'tsconfig.build.json',
  ])

  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const sdkSrc = join(ROOT, 'plugin-sdk')
  const sdkDist = join(DIST, 'plugin-sdk')
  if (!existsSync(sdkDist)) {
    process.stderr.write('build failed: dist/plugin-sdk missing after tsc\n')
    process.exit(1)
  }

  // SDK 运行期包元数据：指到编译产物（而非 TS 源码），随框架包发布。
  writeFileSync(
    join(sdkDist, 'package.json'),
    `${JSON.stringify(
      {
        name: 'plugin-sdk',
        version: rootPkg.version,
        type: 'module',
        description:
          '插件服务协议壳（编译产物）：帧编解码 / 帧循环 / manifest 派生 / 调用派发 / 反向调用通道',
        exports: {
          '.': { types: './index.d.ts', default: './index.js' },
          './web': { types: './web/index.d.ts', default: './web/index.js' },
        },
        engines: { node: '>=24' },
      },
      null,
      2,
    )}\n`,
  )
  // Rust crate 与作者工具随 SDK 发布（rust/target、node_modules 排除）。
  for (const dir of ['rust', 'tools']) {
    const from = join(sdkSrc, dir)
    if (existsSync(from)) copyFiltered(from, join(sdkDist, dir))
  }
  for (const file of ['README.md']) {
    const from = join(sdkSrc, file)
    if (existsSync(from)) cpSync(from, join(sdkDist, file))
  }

  // toolchain 构建期文档随包（入口为 dist/toolchain/build.js，由 `chrono term build` 调用）。
  const tcSrc = join(ROOT, 'toolchain')
  const tcDist = join(DIST, 'toolchain')
  for (const file of ['README.md', 'spec.md']) {
    const from = join(tcSrc, file)
    if (existsSync(from)) cpSync(from, join(tcDist, file))
  }

  process.stdout.write('build: dist/ ready (packages + plugin-sdk + toolchain)\n')
}

main()
