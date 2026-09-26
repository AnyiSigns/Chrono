// toy 服务（三形态共用）：stdio 下自行起帧循环；inproc / worker 下由宿主 import 后直调。
// 同一份派发逻辑，故 stdio / inproc / worker 三种形态对同一组调用产出逐字节一致的结果。
// 入口模块路径由宿主按 plugin.json.transport 选择：stdio 走 `node execute/main.mjs`，
// inproc / worker 直接 import 本文件并调用具名导出 `createService`。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROTOCOL_VERSION = '1'
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function readJson(name) {
  try {
    return JSON.parse(readFileSync(join(packageRoot, name), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write('[toy-channel] bad ' + name + ': ' + err.message + '\n')
    }
    return {}
  }
}

/** 三形态共用的服务实例：收协议帧、按声明回帧。`env` 是宿主传的 ③ / ④ 目录（非环境变量）。 */
export function createService({ emit, env }) {
  const config = readJson('service-config.json')
  let calls = 0

  function manifest() {
    const plugin = readJson('plugin.json')
    const base = {
      v: PROTOCOL_VERSION,
      identity: plugin.identity,
      implements: plugin.implements,
      methods: plugin.methods,
      protocol: plugin.protocol,
      state: plugin.state,
    }
    for (const key of Object.keys(config.manifest || {})) base[key] = config.manifest[key]
    return base
  }

  function handle(message) {
    if (message === null || typeof message !== 'object') return
    switch (message.kind) {
      case 'hello':
        emit({
          v: PROTOCOL_VERSION,
          id: 'evt-ready',
          kind: 'event',
          topic: 'ready',
          payload: { impl: readJson('plugin.json').identity },
        })
        emit(Object.assign({ id: message.id, kind: 'manifest' }, manifest()))
        return
      case 'probe':
        emit({ id: message.id, kind: 'pong', ok: config.probeMode !== 'fail' })
        return
      case 'reload':
        emit({ v: PROTOCOL_VERSION, id: message.id, kind: 'ack' })
        return
      case 'drain':
        emit({ v: PROTOCOL_VERSION, id: message.id, kind: 'bye' })
        return
      case 'call': {
        calls += 1
        if (config.callMode === 'exit') process.exit(1)
        if (config.callMode === 'error') {
          emit({
            v: PROTOCOL_VERSION,
            id: message.id,
            kind: 'error',
            ok: false,
            code: 'toy.channel.failed',
            message: 'toy channel error',
          })
          return
        }
        const value = {
          impl: readJson('plugin.json').identity,
          port: message.port,
          method: message.method,
          args: message.args === undefined ? null : message.args,
          calls,
          hasState: env.CHRONO_PLUGIN_STATE !== undefined,
          hasData: env.CHRONO_PLUGIN_DATA !== undefined,
        }
        emit({ v: PROTOCOL_VERSION, id: message.id, kind: 'result', ok: true, value })
        return
      }
    }
  }

  return { receive: handle, close() {} }
}

// stdio 形态：直接运行本文件时起帧循环（inproc / worker 由宿主 import，不触发）。
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const frame = (message) => {
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const head = Buffer.allocUnsafe(4)
    head.writeUInt32BE(body.length, 0)
    process.stdout.write(Buffer.concat([head, body]))
  }
  const env = {}
  if (process.env.CHRONO_PLUGIN_STATE !== undefined) {
    env.CHRONO_PLUGIN_STATE = process.env.CHRONO_PLUGIN_STATE
  }
  if (process.env.CHRONO_PLUGIN_DATA !== undefined) {
    env.CHRONO_PLUGIN_DATA = process.env.CHRONO_PLUGIN_DATA
  }
  const instance = createService({ emit: frame, env })
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      const body = buffer.subarray(4, 4 + length).toString('utf8')
      buffer = buffer.subarray(4 + length)
      try {
        instance.receive(JSON.parse(body))
      } catch (err) {
        process.stderr.write('[toy-channel] bad frame: ' + err.message + '\n')
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('close', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))
}
