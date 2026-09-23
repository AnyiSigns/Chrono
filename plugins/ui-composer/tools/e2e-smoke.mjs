// `ui-composer` 宿主装配冒烟（黑盒，经 boot CLI）：
// pack 入世树核对 → 临时 root seed（ui-composer + input + config）→ start → 轮询 loaded →
// 声明核对 → stop → verify + replay。客户端半边改由插件自交付后，不再有子应用 HTTP / 端口步骤。
// 失败路径同样尝试 stop 释放锁。用法：node plugins/ui-composer/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { packSourceDir, readWorldignore } from '../../../packages/host/assembly/source.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const COMPOSER_DIR = join(REPO_ROOT, 'plugins', 'ui-composer')

/** 依赖先于本插件的 seed 顺序（本插件无 pins，input / config 供命令面往返）。 */
const PACKAGES = ['input', 'config', 'ui-composer']

function boot(root, args, env) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: env ?? process.env,
  })
  const stdout = result.stdout.trim()
  let parsed = null
  if (stdout.length > 0) {
    try {
      parsed = JSON.parse(stdout)
    } catch {
      parsed = null
    }
  }
  if (result.status !== 0) {
    throw new Error(
      `boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || stdout}`,
    )
  }
  return parsed
}

async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
}

/** 从打包子操作里收集树内文件路径（目录 put 的 entries；文件条目 hash 是真实哈希）。 */
function collectPackedPaths(ops, rootIndex) {
  const paths = []
  const walk = (index, prefix) => {
    const body = ops[index]?.args?.body
    const entries = body?.entries
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const name = entry?.name
      if (typeof name !== 'string') continue
      const path = prefix.length === 0 ? name : `${prefix}/${name}`
      if (
        entry.mode === 'dir' &&
        entry.hash !== null &&
        typeof entry.hash === 'object' &&
        Number.isInteger(entry.hash.$n)
      ) {
        walk(entry.hash.$n, path)
      } else if (entry.mode === 'file') {
        paths.push(path)
      }
    }
  }
  walk(rootIndex, '')
  return paths
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-composer-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    // 1) 入世树核对：契约文件、terms 与客户端源码入世；test/、tools/、dist/ 排除。
    const worldignore = readWorldignore(COMPOSER_DIR)
    assert.equal(worldignore.ok, true, '.worldignore 解析失败')
    const source = packSourceDir(COMPOSER_DIR, worldignore.patterns)
    const packedPaths = collectPackedPaths(source.ops, source.rootTreeIndex)
    for (const required of [
      'plugin.json',
      'package.json',
      'package-lock.json',
      'README.md',
      'execute/main.ts',
      'execute/client-read.ts',
      'execute/web/entry.tsx',
      'execute/web/model.ts',
      'execute/web/run-model.ts',
      'execute/web/attach.ts',
      'execute/web/dropdown.ts',
      'execute/web/messages.ts',
      'execute/web/store.ts',
      'terms/client.read.json',
    ]) {
      assert.ok(packedPaths.includes(required), `入世树缺 ${required}`)
    }
    assert.ok(!packedPaths.some((path) => path.startsWith('test/')), '入世树含 test/')
    assert.ok(!packedPaths.some((path) => path.startsWith('tools/')), '入世树含 tools/')
    assert.ok(
      !packedPaths.some((path) => path.startsWith('execute/web/dist/')),
      '入世树含 dist/',
    )
    assert.ok(!packedPaths.some((path) => path.startsWith('schema/')), '零 schema 不应有 schema/')
    console.log(`入世树：ok（${packedPaths.length} 个文件，排除 test/ tools/ dist/）`)

    // 2) seed（input / config 供命令面往返）
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify(
        PACKAGES.map((name) => ({ name, path: join(REPO_ROOT, 'plugins', name) })),
        null,
        2,
      ),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, `seed 报告 ok:false：${JSON.stringify(seeded.items)}`)
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    // 3) start + 轮询 loaded
    boot(root, ['start'])
    started = true
    await waitFor(() => {
      const status = boot(root, ['status'])
      const loaded = status.loaded.map((item) => item.id)
      return ['ui-composer', 'input', 'config'].every((id) => loaded.includes(id))
    }, 'ui-composer + input + config loaded')
    const status = boot(root, ['status'])
    console.log(`loaded: ${status.loaded.map((item) => item.id).join(' ')}`)

    // 4) 声明核对：只读命令 client.read、无 pins、零 schema
    const commands = boot(root, ['commands'])
    const clientRead = commands.find((command) => command.name === 'ui-composer.client.read')
    assert.ok(clientRead !== undefined, `缺 ui-composer.client.read 命令：${JSON.stringify(commands)}`)
    assert.equal(clientRead.readonly, true)
    const decl = JSON.parse(readFileSync(join(COMPOSER_DIR, 'plugin.json'), 'utf8'))
    assert.deepEqual(decl.pins, {})
    assert.deepEqual(decl.commands, [
      { name: 'ui-composer.client.read', entry: 'terms/client.read.json', readonly: true },
    ])
    assert.equal(Object.hasOwn(decl, 'schema'), false, '零 schema：省略字段')
    assert.equal(Object.hasOwn(decl, 'exclusive'), false, '不得再声明 port 独占')
    console.log('声明：ok（client.read 只读 / pins 空 / 零 schema）')

    // 5) stop → verify + replay
    const beforeStop = boot(root, ['status'])
    boot(root, ['stop'])
    started = false
    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, beforeStop.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    console.log(`E2E ok（root=${root}）`)
  } finally {
    if (started) {
      try {
        boot(root, ['stop'])
      } catch (err) {
        console.error(`stop 失败：${err.message}`)
      }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt === 4) console.error(`清理临时 root 失败（不影响结果）：${err.message}`)
        else await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
      }
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
