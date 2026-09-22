import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pkgRoot = new URL('../', import.meta.url)
const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, pkgRoot), 'utf8'))

// 与宿主 `assembly/decl.ts` 的 SAFE_BUILD_TOKEN 同口径：令牌含空白 / 引号 / shell 元字符即整包拒。
const SAFE_BUILD_TOKEN = /^[A-Za-z0-9_./:@,+-]+$/

test('plugin.json 的 build 令牌全部落在宿主白名单内', () => {
  const decl = readJson('plugin.json')
  assert.ok(Array.isArray(decl.build) && decl.build.length > 0)
  for (const step of decl.build) {
    assert.match(step.cmd, SAFE_BUILD_TOKEN)
    for (const arg of step.args) assert.match(arg, SAFE_BUILD_TOKEN)
  }
})

test('plugin.json 声明了 execute 成员与 start 命令', () => {
  const decl = readJson('plugin.json')
  assert.equal(decl.start, 'node execute/main.js')
  assert.ok(decl.members.some((member) => member.kind === 'execute'))
})

test('package.json 声明 React 与打包器，且打包脚本产出 dist/app.js', () => {
  const pkg = readJson('package.json')
  for (const name of ['react', 'react-dom', 'esbuild']) {
    assert.equal(typeof pkg.dependencies[name], 'string', `missing dependency ${name}`)
  }
  assert.match(pkg.scripts.build, /--outfile=dist\/app\.js/)
})

test('.worldignore 排除构建产物与测试', () => {
  const text = readFileSync(new URL('.worldignore', pkgRoot), 'utf8')
  const patterns = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(patterns.includes('dist/'))
  assert.ok(patterns.includes('test/'))
})
