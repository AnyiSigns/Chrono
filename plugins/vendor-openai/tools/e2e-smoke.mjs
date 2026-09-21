// 七包合并 E2E 冒烟（黑盒，经 boot CLI）：pack → seed → start → 六个 seed 脚本写模板 body 数据世代
// → 经投影读回六家 body → stop → verify + replay。宿主是单写者，任何失败路径都会尝试 stop 释放锁。
// 用法：node plugins/vendor-openai/tools/e2e-smoke.mjs
// 临时根目录建在系统临时目录的 kilo/ 下，执行后可留作排查。
//
// 说明：本脚本是入世排除（.worldignore 声明 tools/）的本地开发工具，不属于插件运行时代码；
// 它只在开发期构造一个读取投影的 term def（用内核的 H 算 def 哈希）以抽查投影 body。
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const KERNEL_INDEX = join(REPO_ROOT, 'packages', 'kernel', 'index.ts')

const SEEDED_IDS = [
  'vendor-openai',
  'vendor-deepseek',
  'vendor-dashscope',
  'vendor-google',
  'vendor-zai',
  'vendor-kimi',
]
const CUSTOM_ID = 'vendor-custom'
const ALL_IDS = [...SEEDED_IDS, CUSTOM_ID]

const dirOf = (id) => join(REPO_ROOT, 'plugins', id)

function boot(root, args) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
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
      'boot ' + args.join(' ') + ' 失败（exit ' + result.status + '）：' + (result.stderr || stdout),
    )
  }
  return parsed
}

function assertSevenSchemasIdentical() {
  const first = readFileSync(join(dirOf(ALL_IDS[0]), 'schema', 'vendor.json'), 'utf8')
  for (const id of ALL_IDS.slice(1)) {
    const text = readFileSync(join(dirOf(id), 'schema', 'vendor.json'), 'utf8')
    assert.equal(text, first, '七包 schema 应逐字节一致：' + id)
  }
  console.log('schema shape: identical across ' + ALL_IDS.length + ' packages')
}

async function main() {
  const { H } = await import(pathToFileURL(KERNEL_INDEX).href)
  assertSevenSchemasIdentical()

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', 'chrono-vendors-' + stamp)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    for (const id of ALL_IDS) {
      const packed = boot(root, ['pack', dirOf(id), '--identity', id])
      assert.equal(packed.ok, true, 'pack ' + id + ' 报告 ok:false：' + JSON.stringify(packed))
      console.log('pack ' + id + ': ' + packed.status)
    }

    const manifest = ALL_IDS.map((id) => ({ name: id, path: dirOf(id) }))
    writeFileSync(join(root, 'state', 'plugins.json'), JSON.stringify(manifest, null, 2))
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false：' + JSON.stringify(seeded))
    console.log('seed: ' + seeded.items.map((item) => item.name + '=' + item.status).join(' '))

    boot(root, ['start'])
    started = true

    for (const id of SEEDED_IDS) {
      const script = join(dirOf(id), 'tools', 'seed-default-body.mjs')
      const out = spawnSync(process.execPath, [script, '--root', root], {
        encoding: 'utf8',
        cwd: REPO_ROOT,
      })
      if (out.status !== 0) {
        throw new Error('seed 脚本 ' + id + ' 失败：' + (out.stderr || out.stdout))
      }
      console.log('seed body ' + id + ': ' + out.stdout.trim())
    }

    for (const id of SEEDED_IDS) {
      const term = ['g', ['ids', id, 'body']]
      const termHash = H({ body: term })
      const put = boot(root, [
        'run',
        JSON.stringify([
          {
            kind: 'write',
            request: { id: 'e2e-read-term-' + id, op: 'put', args: { body: term }, by: 'e2e' },
          },
        ]),
      ])
      assert.equal(put.status, 'done', 'put 读取 term 未完成：' + JSON.stringify(put))
      const read = boot(root, ['run', JSON.stringify([{ kind: 'eval', entry: termHash }])])
      assert.equal(read.status, 'done', 'eval 未完成：' + JSON.stringify(read))
      const value = read.observations[0].value
      const expected = JSON.parse(readFileSync(join(dirOf(id), 'tools', 'default-body.json'), 'utf8'))
      assert.deepEqual(value, expected, '投影 body 与默认 body 不一致：' + id)
      console.log('projection ' + id + ': ok')
    }

    boot(root, ['stop'])
    started = false

    const verify = boot(root, ['verify'])
    assert.equal(verify.ok, true, 'verify 报告 ok:false：' + JSON.stringify(verify))
    console.log('verify: ok')
    const replay = boot(root, ['replay'])
    assert.ok(
      typeof replay.worldRev === 'string' && replay.worldRev.length === 64,
      'replay worldRev 形态非法：' + JSON.stringify(replay),
    )
    console.log('replay: ok（head seq=' + replay.head.seq + '）')

    console.log('E2E ok（root=' + root + '）')
  } finally {
    if (started) {
      try {
        boot(root, ['stop'])
      } catch (err) {
        console.error('stop 失败：' + err.message)
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
