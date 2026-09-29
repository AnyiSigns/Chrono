// `secrets-vault`：最小密钥后端提供方（自注册 `implements:["secrets-backend"]`，kinds = ["vault"]）。
// 证明「新增一个密钥后端 = 新插件自注册，secrets 与消费方零改动」：本服务只回固定引用名与明文；
// 定位由 secrets 按注入的成员表逐个 `kinds` 完成，无需任何枢纽枚举。
// 自实现最小服务协议帧循环（不依赖 plugin-sdk / 无第三方依赖），便于测试直接 spawn。

const PROTOCOL = '1'
const IDENTITY = 'secrets-vault'

/** 固定引用名 → 明文（测试夹具，无真实保险库）。 */
const VAULT = { VAULT_TOKEN: 'vault-token-xyz' }

function manifest() {
  return {
    v: PROTOCOL,
    identity: IDENTITY,
    implements: ['secrets-backend'],
    methods: { 'secrets-backend': ['read', 'list', 'kinds'] },
    protocol: PROTOCOL,
    state: 'recomputable',
  }
}

function handle(message, emit) {
  if (message === null || typeof message !== 'object') return
  switch (message.kind) {
    case 'hello':
      emit({ id: message.id, kind: 'manifest', ...manifest() })
      return
    case 'probe':
      emit({ v: PROTOCOL, id: message.id, kind: 'pong', ok: true })
      return
    case 'reload':
      emit({ v: PROTOCOL, id: message.id, kind: 'ack' })
      return
    case 'drain':
      emit({ v: PROTOCOL, id: message.id, kind: 'bye' })
      return
    case 'call': {
      if (message.port !== 'secrets-backend') {
        emit({
          v: PROTOCOL,
          id: message.id,
          kind: 'error',
          ok: false,
          code: 'unresolved_cap',
          message: `unknown capability ${String(message.port)}`,
        })
        return
      }
      if (message.method === 'kinds') {
        emit({ v: PROTOCOL, id: message.id, kind: 'result', ok: true, value: ['vault'] })
        return
      }
      if (message.method === 'list') {
        const value = Object.keys(VAULT)
          .sort()
          .map((name) => ({ name, has: true }))
        emit({ v: PROTOCOL, id: message.id, kind: 'result', ok: true, value })
        return
      }
      if (message.method === 'read') {
        const args = message.args && typeof message.args === 'object' ? message.args : {}
        const value = VAULT[args.name]
        if (value === undefined) {
          emit({
            v: PROTOCOL,
            id: message.id,
            kind: 'error',
            ok: false,
            code: 'secret_missing',
            message: 'vault secret not found',
          })
          return
        }
        emit({ v: PROTOCOL, id: message.id, kind: 'result', ok: true, value })
        return
      }
      emit({
        v: PROTOCOL,
        id: message.id,
        kind: 'error',
        ok: false,
        code: 'unknown_method',
        message: `unknown method ${String(message.method)}`,
      })
      return
    }
    default:
      return
  }
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32BE(body.length, 0)
  process.stdout.write(Buffer.concat([head, body]))
}

const emit = (message) => frame(message)
let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
  while (buffer.length >= 4) {
    const length = buffer.readUInt32BE(0)
    if (buffer.length < 4 + length) break
    const body = buffer.subarray(4, 4 + length).toString('utf8')
    buffer = buffer.subarray(4 + length)
    try {
      handle(JSON.parse(body), emit)
    } catch {
      // 坏帧忽略
    }
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.on('error', () => process.exit(0))
process.stderr.write(`[secrets-vault] started\n`)
