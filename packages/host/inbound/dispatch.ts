// 入站 kind → handler 的薄路由：协议版本校验、停机态拦截、未知 kind fail-closed。
// 只做派发，不解释消息语义；run 的登记与收口交给 handlers / run-registry。

import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { PROTOCOL_VERSION } from '../wire.ts'
import type { InboundMessage, OutboundMessage } from '../wire.ts'
import { parseAuditFilter } from '../audit.ts'
import type { AuditQuery } from '../audit.ts'
import { getAsset, putAsset } from '../assets.ts'
import { deleteSecret, isValidSecretName, putSecret } from '../secrets.ts'
import { asDirectives } from './validate.ts'
import type { CommandIndexFor, InboundHandlers, SendFn } from './handlers.ts'
import type { RunRegistry } from '../run-registry.ts'
import type { AssemblyRuntimeHandle } from '../assembly/index.ts'
import type { HostPaths } from '../paths.ts'
import type { WorldState } from '../writer.ts'
import type { Hash, Head, Json, World } from '../../kernel/index.ts'

export interface DispatchDeps {
  send: SendFn
  registry: RunRegistry
  paths: HostPaths
  audits: AuditQuery
  isStopping: () => boolean
  requestStop: () => void
  getRuntime: () => AssemblyRuntimeHandle | undefined
  getSnapshot: () => WorldState
  cachedWorldRev: (world: World, head: Head) => Hash
  commandIndexFor: CommandIndexFor
  handlers: InboundHandlers
}

export function createDispatch(deps: DispatchDeps): (socket: Socket, message: InboundMessage) => void {
  const { send } = deps

  const error = (socket: Socket, id: string, code: string, message: string): void => {
    send(socket, { v: PROTOCOL_VERSION, id, kind: 'error', code, message })
  }

  /** 登记并启动一次入站 run（submit / command / forward 同规）：建控制器、入册、跑 handler。 */
  const startRun = (
    socket: Socket,
    id: string,
    accepted: boolean,
    run: (
      runId: string,
      thread: string | null,
      signal: AbortSignal,
    ) => Promise<void>,
    message: InboundMessage,
  ): void => {
    const runId = randomUUID()
    const thread = 'thread' in message && typeof message.thread === 'string' ? message.thread : null
    const controller = new AbortController()
    deps.registry.register(runId, controller)
    // accepted 先于推进发出：长提交不阻塞后到客户端的受理确认（run 入册后即可被 cancel 命中）
    if (accepted) send(socket, { v: PROTOCOL_VERSION, id, kind: 'accepted', run: runId })
    const task = run(runId, thread, controller.signal)
      .catch(() => {
        try {
          error(socket, id, 'internal', 'run failed')
        } catch {
          // 客户端已断：错误无处可送
        }
      })
      .finally(() => {
        deps.registry.unregister(runId)
        deps.registry.untrack(task)
      })
    deps.registry.track(task)
  }

  return (socket, message) => {
    if (message.v !== PROTOCOL_VERSION) {
      error(socket, message.id, 'protocol_mismatch', `protocol ${message.v} != ${PROTOCOL_VERSION}`)
      return
    }
    switch (message.kind) {
      case 'submit': {
        if (deps.isStopping()) return error(socket, message.id, 'internal', 'stopping')
        const directives = asDirectives(message.directives)
        if (directives === null) {
          return error(socket, message.id, 'bad_directive', 'directives must be an array')
        }
        startRun(
          socket,
          message.id,
          true,
          (runId, thread, signal) =>
            deps.handlers.submit(socket, message, directives, runId, thread, signal),
          message,
        )
        return
      }
      case 'command': {
        if (deps.isStopping()) return error(socket, message.id, 'internal', 'stopping')
        startRun(
          socket,
          message.id,
          false,
          (runId, thread, signal) =>
            deps.handlers.command(socket, message, runId, thread, signal),
          message,
        )
        return
      }
      case 'forward': {
        if (deps.isStopping()) return error(socket, message.id, 'internal', 'stopping')
        startRun(
          socket,
          message.id,
          false,
          (runId, thread, signal) =>
            deps.handlers.forward(socket, message, runId, thread, signal),
          message,
        )
        return
      }
      case 'cancel': {
        if (typeof message.run !== 'string' || message.run.length === 0) {
          return error(socket, message.id, 'bad_directive', 'cancel expects run')
        }
        if (!deps.registry.abort(message.run)) {
          // 未知 / 已结束的 run：fail-closed（不猜、不静默）
          return error(socket, message.id, 'unknown_run', message.run)
        }
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'accepted' })
        return
      }
      case 'audit': {
        const filter = parseAuditFilter(message.filter)
        if (filter === null) return error(socket, message.id, 'bad_directive', 'bad audit filter')
        const report = deps.audits.query(filter)
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'audits',
          records: report.records as unknown as Json[],
          truncated: report.truncated,
        })
        return
      }
      case 'asset.put': {
        const result = putAsset(deps.paths.assetsDir, message.mime, message.bytes)
        if (!result.ok) return error(socket, message.id, result.code, 'asset put rejected')
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'asset.ref',
          ref: result.ref as unknown as Json,
        })
        return
      }
      case 'asset.get': {
        const result = getAsset(deps.paths.assetsDir, message.sha256)
        if (!result.ok) return error(socket, message.id, result.code, message.sha256)
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'asset.bytes',
          sha256: result.sha256,
          size: result.size,
          bytes: result.bytes,
        })
        return
      }
      case 'secrets.put': {
        const { name, value } = message
        if (typeof name !== 'string' || typeof value !== 'string' || !isValidSecretName(name)) {
          return error(socket, message.id, 'bad_directive', 'secrets.put expects { name, value }')
        }
        const written = putSecret(deps.paths.secretsFile, name, value)
        if (!written.ok) {
          // 损坏文件 fail-closed：不静默以 {} 覆写丢密钥
          return error(
            socket,
            message.id,
            written.reason === 'corrupt' ? 'internal' : 'bad_directive',
            `secrets.put rejected: ${written.reason}`,
          )
        }
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'secrets.ok', name })
        return
      }
      case 'secrets.delete': {
        const { name } = message
        if (typeof name !== 'string' || !isValidSecretName(name)) {
          return error(socket, message.id, 'bad_directive', 'secrets.delete expects { name }')
        }
        const removed = deleteSecret(deps.paths.secretsFile, name)
        if (!removed.ok) {
          return error(
            socket,
            message.id,
            removed.reason === 'corrupt' ? 'internal' : 'bad_directive',
            `secrets.delete rejected: ${removed.reason}`,
          )
        }
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'secrets.ok', name })
        return
      }
      case 'commands': {
        const snapshot = deps.getSnapshot()
        const commands = deps.commandIndexFor(snapshot.world, snapshot.head).commands.map(
          (command) => ({ identity: command.identity, name: command.name, entry: command.entry }),
        )
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'list', commands })
        return
      }
      case 'status': {
        const runtime = deps.getRuntime()
        const loaded = runtime === undefined ? [] : runtime.loaded().map((entry) => ({ id: entry.id, gen: entry.gen }))
        const current = deps.getSnapshot()
        send(socket, {
          v: PROTOCOL_VERSION,
          id: message.id,
          kind: 'state',
          world_head: { seq: current.head.seq, hash: current.head.hash },
          world_rev: deps.cachedWorldRev(current.world, current.head),
          loaded,
        })
        return
      }
      case 'stop': {
        // 同步置停机态：stop 经 setImmediate 延迟执行，窗口内不得再受理新 run
        deps.requestStop()
        send(socket, { v: PROTOCOL_VERSION, id: message.id, kind: 'accepted' })
        return
      }
      default: {
        // 未知 kind：fail-closed 回错，不静默无响应（TS 视联合类型已穷尽，运行时仍可能收到畸形 kind）
        const unknown = message as unknown as { id?: unknown; kind?: unknown }
        send(socket, {
          v: PROTOCOL_VERSION,
          id: typeof unknown.id === 'string' ? unknown.id : '',
          kind: 'error',
          code: 'bad_directive',
          message: `unknown kind: ${String(unknown.kind)}`,
        })
        return
      }
    }
  }
}
