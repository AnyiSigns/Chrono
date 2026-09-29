// `embedding-fixture`：最小嵌入提供方（自注册 `implements:["embedding-provider"]`）。
// 证明「加一个嵌入提供方 = 新插件自注册，门面与消费方零改动」：本服务只声明模型 `x`
// 并按 `x` 返回确定性向量；门面 `embedding` 按世界成员表逐个反调 `describe-models` 选成员。
// 自实现最小服务协议帧循环（不依赖 plugin-sdk / 无第三方依赖），便于测试直接 spawn。

const PROTOCOL = '1'
const IDENTITY = 'embedding-fixture'
const MODEL = 'x'
const DIM = 8
const FILL = 9

function manifest() {
  return {
    v: PROTOCOL,
    identity: IDENTITY,
    implements: ['embedding-provider'],
    methods: { 'embedding-provider': ['embed', 'describe-models'] },
    protocol: PROTOCOL,
    state: 'recomputable',
  }
}

function describeModels() {
  return { models: [{ model: MODEL, dim: DIM }] }
}

function embed(args) {
  const texts = Array.isArray(args?.texts) ? args.texts : []
  const model = typeof args?.model === 'string' ? args.model : MODEL
  if (model !== MODEL) return { error: 'unknown_model', message: `unknown model ${model}` }
  const vectors = texts.map(() =>
    new Array(DIM).fill(0).map((_, index) => (index === 0 ? FILL : 0)),
  )
  return { value: { model: MODEL, dim: DIM, vectors } }
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
      if (message.port !== 'embedding-provider') {
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
      if (message.method === 'describe-models') {
        emit({ v: PROTOCOL, id: message.id, kind: 'result', ok: true, value: describeModels() })
        return
      }
      if (message.method === 'embed') {
        const outcome = embed(message.args)
        if (outcome.error !== undefined) {
          emit({
            v: PROTOCOL,
            id: message.id,
            kind: 'error',
            ok: false,
            code: outcome.error,
            message: outcome.message,
          })
          return
        }
        emit({ v: PROTOCOL, id: message.id, kind: 'result', ok: true, value: outcome.value })
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
process.stderr.write(`[embedding-fixture] started\n`)
