// 预置 sandbox 四档 fs/net 映射默认 body（数据世代）：读同目录 default-body.json，
// 经 boot run 提交一条原子 batch。前置：宿主已 start（唯一写者）。
// 可重复执行（同内容命中幂等短路）。用法：node plugins/sandbox/tools/seed-default-body.mjs --root <宿主根目录>
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')

function rootArg() {
  const argv = process.argv.slice(2)
  const index = argv.indexOf('--root')
  if (index < 0 || argv[index + 1] === undefined) throw new Error('缺少 --root <宿主根目录>')
  return resolve(argv[index + 1])
}

function boot(root, args) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
  if (result.status !== 0) {
    throw new Error(`boot ${args[0]} 失败（exit ${result.status}）：${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout)
}

function main() {
  const root = rootArg()
  const body = JSON.parse(readFileSync(join(HERE, 'default-body.json'), 'utf8'))
  const status = boot(root, ['status'])
  const directive = [
    {
      kind: 'write',
      request: {
        id: 'sandbox-default-body',
        op: 'batch',
        target: { expect_pos: status.world_head.hash },
        args: {
          ops: [
            { op: 'put', args: { body } },
            {
              op: 'add_gen',
              args: { id: 'sandbox', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} },
            },
          ],
        },
        by: 'seed-default',
      },
    },
  ]
  const result = boot(root, ['run', JSON.stringify(directive)])
  if (result.status !== 'done') throw new Error(`写入未完成：${JSON.stringify(result)}`)
  process.stdout.write(`${JSON.stringify({ ok: true, identity: 'sandbox', status: result.status })}\n`)
}

main()
