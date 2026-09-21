// `session` 计划落账 E2E（黑盒，经 boot CLI + 直连服务协议）：
// pack session + input → seed → start → 写 input / session 初始 body（数据世代）
// → 直连 session 服务调 commit（args 带轮首 body / 槽体 / 双方消息，帧 env.now 固定）
// → 把返回的 $directives 经 `boot run` 落账 → stop → verify + replay
// → 离线读投影确认 session head/count、消息 def 在 refs 里、input 本线程键为 idle。
// 失败路径也 stop，释放单写者锁。
// 用法：node plugins/session/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { projectBaseOnly } from '../../../packages/host/projection/index.ts'
import { hostPaths } from '../../../packages/host/paths.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const SESSION_DIR = join(REPO_ROOT, 'plugins', 'session')
const INPUT_DIR = join(REPO_ROOT, 'plugins', 'input')
const FIXED_NOW = 1_700_000_000_000
const AT = new Date(FIXED_NOW).toISOString()

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
    throw new Error(`boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || stdout}`)
  }
  return parsed
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

/** 直连 session 服务：hello → call，收集 event，返回 result 值。 */
function callCommit(args) {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(process.execPath, ['execute/main.ts'], {
      cwd: SESSION_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const decoder = createDecoder()
    const pending = new Map()
    const events = []
    const timer = setTimeout(() => {
      child.kill()
      rejectCall(new Error('session 服务调用超时'))
    }, 8000)
    child.stdout.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.kind === 'event') {
          events.push(message)
          continue
        }
        const handler = pending.get(message.id)
        if (handler !== undefined) {
          pending.delete(message.id)
          handler(message)
        }
      }
    })
    child.stderr.on('data', () => {})
    let seq = 0
    function request(kind, fields, expect) {
      seq += 1
      const id = `e2e-${seq}`
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, (message) => {
          if (message.kind !== expect) {
            rejectRequest(new Error(`expected ${expect} got ${message.kind}`))
            return
          }
          resolveRequest(message)
        })
        child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
      })
    }
    ;(async () => {
      await request('hello', { impl: 'session', gen: 'e2e' }, 'manifest')
      const result = await request(
        'call',
        {
          port: 'session',
          method: 'commit',
          args,
          env: { run: 'e2e-run', thread: 't1', now: FIXED_NOW },
        },
        'result',
      )
      clearTimeout(timer)
      child.stdin.end()
      resolveCall({ value: result.value, events })
    })().catch((err) => {
      clearTimeout(timer)
      child.kill()
      rejectCall(err)
    })
  })
}

function sessionBody() {
  return {
    version: 1,
    current: 'c1',
    conversations: [
      {
        id: 'c1',
        workspace_id: 'w1',
        title: '新对话',
        kind: 'main',
        parent: null,
        agent: null,
        participants: [],
        workflow: null,
        inbox: { tail: null, count: 0, last_seen: 0 },
        status: 'waiting',
        last_activity: null,
        pending: { approval: 0, question: 0 },
        head: null,
        count: 0,
        created: AT,
        deleted_at: null,
      },
    ],
  }
}

function writeBatch(root, ops) {
  const status = boot(root, ['status'])
  const directive = [
    {
      kind: 'write',
      request: {
        id: 'e2e-seed-bodies',
        op: 'batch',
        target: { expect_pos: status.world_head.hash },
        args: { ops },
        by: 'e2e',
      },
    },
  ]
  const written = boot(root, ['run', JSON.stringify(directive)])
  assert.equal(written.status, 'done', `初始 body 写入未完成：${JSON.stringify(written)}`)
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-session-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    for (const pkg of [
      { id: 'session', dir: SESSION_DIR },
      { id: 'input', dir: INPUT_DIR },
    ]) {
      const packed = boot(root, ['pack', pkg.dir, '--identity', pkg.id])
      assert.equal(packed.ok, true, `pack ${pkg.id} 报告 ok:false`)
      console.log(`pack ${pkg.id}: ${packed.status}`)
    }

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'session', path: SESSION_DIR },
        { name: 'input', path: INPUT_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true

    // 初始数据世代：input 空槽 body + session 初始会话 body
    writeBatch(root, [
      { op: 'put', args: { body: { slots: {} } } },
      { op: 'add_gen', args: { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
      { op: 'put', args: { body: sessionBody() } },
      { op: 'add_gen', args: { id: 'session', payload: { $n: 2 }, sig: { $n: 2 }, pins: {} } },
    ])
    console.log('初始 body：done')

    const beforeStatus = boot(root, ['status'])

    const { value, events } = await callCommit({
      thread_id: 't1',
      session: sessionBody(),
      slots: { slots: { t1: { kind: 'chat.message', text: 'hello' } } },
      conversation: 'c1',
      user: { content: 'hello' },
      assistant: { content: 'world' },
    })
    assert.equal(events.length, 1)
    assert.equal(events[0].topic, 'thread.updated')
    assert.equal(events[0].payload.run, 'e2e-run')
    const directives = value.$directives
    assert.equal(directives.length, 2)
    assert.equal(directives[0].kind, 'write')
    assert.equal(directives[0].request.op, 'batch')
    console.log(`commit 计划：${directives[0].request.args.ops.length} ops + extern`)

    const landed = boot(root, ['run', JSON.stringify(directives)])
    assert.equal(landed.status, 'done', `计划落账未完成：${JSON.stringify(landed)}`)
    console.log('计划落账：done')

    const afterStatus = boot(root, ['status'])
    assert.notDeepEqual(afterStatus.world_head, beforeStatus.world_head, '落账后链头应推进')

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, afterStatus.world_head, 'replay 链头与落账后 status 不一致')
    console.log('verify + replay：ok')

    // 离线读投影
    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const session = projection.ids.session.body
    const conversation = session.conversations[0]
    assert.equal(session.current, 'c1')
    assert.equal(conversation.count, 2)
    assert.match(conversation.head.def, /^[0-9a-f]{64}$/)
    const assistant = projection.ids.session.refs[conversation.head.def]
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.content, 'world')
    const user = projection.ids.session.refs[assistant.prev.def]
    assert.equal(user.role, 'user')
    assert.equal(user.content, 'hello')
    assert.equal(projection.ids.input.body.slots.t1.kind, 'idle')
    console.log('离线投影：head/count/refs/清槽 全部正确')

    console.log(`E2E ok（root=${root}）`)
  } finally {
    if (started) {
      try {
        boot(root, ['stop'])
      } catch (err) {
        console.error(`stop 失败：${err.message}`)
      }
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
