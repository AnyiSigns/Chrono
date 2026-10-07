// toy-channel 服务：三种 transport（stdio / inproc / worker）共用同一派发实现。
// stdio 下直接起帧循环；inproc / worker 下导出 createService(ctx) 供宿主直调。
// 结果里不含 pid，保证三形态回值逐字节一致。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF = fileURLToPath(import.meta.url)

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, name), 'utf8'))
  } catch {
    return {}
  }
}

function makeService(emit) {
  const plugin = readJson('plugin.json')
  const config = readJson('service-config.json')
  const manifest = {
    v: '1',
    identity: plugin.identity,
    implements: plugin.implements ?? [],
    methods: plugin.methods ?? {},
    protocol: plugin.protocol ?? '1',
    state: plugin.state ?? 'recomputable',
  }
  return {
    receive(message) {
      if (message === null || typeof message !== 'object') return
      switch (message.kind) {
        case 'hello':
          emit(Object.assign({ id: message.id, kind: 'manifest' }, manifest))
          return
        case 'probe':
          emit({ id: message.id, kind: 'pong', ok: true })
          return
        case 'reload':
          emit({ v: '1', id: message.id, kind: 'ack' })
          return
        case 'drain':
          emit({ v: '1', id: message.id, kind: 'bye' })
          return
        case 'call':
          if (config.callMode === 'exit') {
            process.exit(1)
            return
          }
          if (config.callMode === 'silent') return
          emit({
            v: '1',
            id: message.id,
            kind: 'result',
            ok: true,
            value: {
              impl: plugin.identity,
              port: message.port,
              method: message.method,
              args: message.args === undefined ? null : message.args,
            },
          })
          return
      }
    },
    close() {},
  }
}

const READY = { v: '1', id: 'ready-1', kind: 'event', topic: 'ready', payload: { phase: 'init' } }

export function createService(ctx) {
  const service = makeService((message) => ctx.emit(message))
  ctx.emit(READY)
  return service
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(SELF)

if (invokedDirectly) {
  const write = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const head = Buffer.allocUnsafe(4)
    head.writeUInt32BE(body.length, 0)
    process.stdout.write(Buffer.concat([head, body]))
  }
  const service = makeService(write)
  write(READY)
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      const body = buffer.subarray(4, 4 + length).toString('utf8')
      buffer = buffer.subarray(4 + length)
      try {
        service.receive(JSON.parse(body))
      } catch (err) {
        process.stderr.write('[toy-channel] bad frame: ' + err.message + '\n')
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))
}
