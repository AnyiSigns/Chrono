// 服务进程模型：按 `plugin.json.transport` 选择服务的加载 / 通信形态。
// - `stdio`：宿主 spawn 子进程，协议帧走其 stdin/stdout（存量形态，默认）。
// - `inproc`：把同语言入口动态 import 进宿主进程同一线程，直调（不开端口、不走 stdio）。
// - `worker`：用 worker_threads 载入同语言入口，独立堆、结构化克隆通信（不开端口、不走 stdio）。
// 本模块只做通道与生命周期，不解释业务；形态校验 / 健康 / 重启 / 隔离在 runtime.ts。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFrameDecoder, encodeFrame } from '../wire.ts'
import type { ServiceChannel, ServiceTransport } from '../service-link.ts'
import { isRecord } from '../common/json.ts'
import { ServiceStartError, exitReason, terminateChild, waitForExit } from './supervision.ts'
import type { PluginDecl } from './decl.ts'
import type { Json } from '../../kernel/index.ts'

/** 同语言入口模块导出的服务工厂名：宿主直调口，插件侧（含 SDK）以同名导出。 */
export const SERVICE_FACTORY_EXPORT = 'createService'

/**
 * 同语言入口模块的工厂上下文。③ / ④ 目录对 inproc / worker 是 loader 参数（worker 经
 * `workerData` 传），不是环境变量——只有 stdio 形态才注入 spawn env。
 */
export interface ServiceFactoryContext {
  /** 服务 → 宿主发一帧。 */
  emit: (message: Json) => void
  /** ③ / ④ 目录（只含已注入项）。 */
  env: Record<string, string>
}

/** 同语言入口模块返回的服务实例。 */
export interface ServiceInstance {
  receive: (message: Json) => void
  close?: () => void
}

export type ServiceFactory = (ctx: ServiceFactoryContext) => ServiceInstance

/** 服务退出与 teardown：stdio 是子进程，inproc / worker 是模型自身的执行体。 */
export interface ServiceLifecycle {
  /** 仅 stdio 有：被 spawn 的子进程（供测试 / 兼容读取）。 */
  readonly proc?: ChildProcess
  /** 执行体是否已退出。 */
  readonly exited: boolean
  /** 退出原因（`exited` 为真时有值）；未退出为 `null`。 */
  readonly exitReason: string | null
  /** 注册退出回调（可多个）；注册时已退出则立即回调一次。 */
  onExit(cb: (reason: string) => void): void
  /** 强制终止执行体（stdio 杀进程树；worker 终止 worker；inproc 关实例）。 */
  terminate(): void
  /** 等执行体真正退出（有界）；已退出立即返回。 */
  waitForExit(timeoutMs: number): Promise<void>
}

export interface ServiceStart {
  channel: ServiceChannel
  lifecycle: ServiceLifecycle
}

/**
 * 起服务的输入（准备阶段产物的超集）：物化目录 + 声明 `durable` 时的 ④ 目录 +
 * 该身份的 ③ 目录 + stdio 专用启动包装器。③ / ④ 对 inproc / worker 是 loader 参数，不是环境变量。
 */
export interface ServiceStartInput {
  cwd: string
  /** 声明 `durable` 时已建好的本身份持久目录；否则 `undefined`。 */
  dataDir?: string
  /** 该身份的插件 ③ 目录（`state/plugins/<id>/`）。 */
  pluginStateDir?: string
  /** 宿主侧服务启动包装器；仅 stdio 模型使用。 */
  startWrapper?: string
}

/** 一种服务形态：把声明的服务起成一个通道 + 生命周期。 */
export interface ServiceHost {
  start(decl: PluginDecl, input: ServiceStartInput): Promise<ServiceStart>
}

/** 按声明选择服务形态；未声明 / `stdio` 走子进程模型。 */
export function selectServiceHost(transport: ServiceTransport): ServiceHost {
  if (transport === 'inproc') return inprocHost
  if (transport === 'worker') return workerHost
  return stdioHost
}

/**
 * 拼接实际 spawn 命令：包装器命令片段前置到原 `start`，交给 shell 重新解析（跨平台同口径）。
 * 未配置包装器 → 原样返回 `start`（零行为变化）。仅 stdio 模型使用。
 */
export function composeStartCommand(start: string, wrapper?: string): string {
  return wrapper === undefined ? start : `${wrapper} ${start}`
}

/** 把 ③ / ④ 目录收成 loader 参数（只含已注入项）。 */
function loaderEnv(stateDir?: string, dataDir?: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (stateDir !== undefined) env['CHRONO_PLUGIN_STATE'] = stateDir
  if (dataDir !== undefined) env['CHRONO_PLUGIN_DATA'] = dataDir
  return env
}

/** 解析同语言入口模块的服务工厂：具名导出优先，其次默认导出（含 CJS `module.exports` 形态）。 */
function resolveServiceFactory(module: Record<string, unknown>): ServiceFactory | null {
  const named = module[SERVICE_FACTORY_EXPORT]
  if (typeof named === 'function') return named as ServiceFactory
  const fallback = module['default']
  if (typeof fallback === 'function') return fallback as ServiceFactory
  if (isRecord(fallback)) {
    const nested = fallback[SERVICE_FACTORY_EXPORT]
    if (typeof nested === 'function') return nested as ServiceFactory
  }
  return null
}

// ---------------------------------------------------------------------------
// stdio：子进程 + stdin/stdout 帧通道
// ---------------------------------------------------------------------------

/** stdio 通道：宿主 → 服务写 stdin，服务 → 宿主读 stdout；帧编解码在本层。 */
export function createStdioChannel(child: ChildProcess): ServiceChannel {
  const decoder = createFrameDecoder()
  let messageCb: ((message: Json) => void) | null = null
  let closeCb: ((reason: string) => void) | null = null
  let closed = false
  const notifyClose = (reason: string): void => {
    if (closed) return
    closed = true
    closeCb?.(reason)
  }
  child.stdout?.on('data', (chunk: Buffer) => {
    if (closed) return
    let messages: Json[]
    try {
      messages = decoder.push(chunk)
    } catch {
      notifyClose('protocol_error')
      return
    }
    for (const message of messages) messageCb?.(message)
  })
  child.stdout?.on('error', () => notifyClose('channel_error'))
  child.stdout?.on('end', () => notifyClose('channel_closed'))
  child.stdin?.on('error', () => notifyClose('channel_error'))
  return {
    get pid() {
      return child.pid
    },
    write(frame: Json): void {
      if (closed) throw new Error('channel_closed')
      child.stdin?.write(encodeFrame(frame))
    },
    onMessage(cb) {
      messageCb = cb
    },
    onClose(cb) {
      closeCb = cb
    },
    close(): void {
      if (closed) return
      closed = true
      try {
        child.stdin?.end()
      } catch {
        // 通道可能已断；关闭是幂等的
      }
    },
  }
}

/** stdio 生命周期：退出 = 子进程 exit / error；terminate = 杀进程树。 */
function createProcessLifecycle(child: ChildProcess): ServiceLifecycle {
  const callbacks: Array<(reason: string) => void> = []
  let exited = child.exitCode !== null || child.signalCode !== null
  let reason: string | null = exited ? exitReason(child.exitCode, child.signalCode) : null
  const fire = (next: string): void => {
    if (exited) return
    exited = true
    reason = next
    for (const cb of callbacks) cb(next)
  }
  child.once('exit', (code, signal) => fire(exitReason(code, signal)))
  child.once('error', () => fire('spawn_error'))
  return {
    proc: child,
    get exited() {
      return exited
    },
    get exitReason() {
      return reason
    },
    onExit(cb) {
      callbacks.push(cb)
      if (exited) cb(reason ?? 'exit:unknown')
    },
    terminate() {
      terminateChild(child)
    },
    waitForExit(timeoutMs) {
      return waitForExit(child, timeoutMs)
    },
  }
}

const stdioHost: ServiceHost = {
  async start(decl, input) {
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (input.pluginStateDir !== undefined) env['CHRONO_PLUGIN_STATE'] = input.pluginStateDir
    if (input.dataDir !== undefined) env['CHRONO_PLUGIN_DATA'] = input.dataDir
    const child = spawn(composeStartCommand(decl.start, input.startWrapper), {
      cwd: input.cwd,
      shell: true,
      windowsHide: true,
      // POSIX 下建独立进程组，便于连同 shell 包装一起杀整树
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })
    // 服务日志走 stderr；宿主持有读端防写满阻塞，stdout 只许协议帧
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.stderr?.on('error', () => {})
    child.stdout?.on('error', () => {})
    child.stdin?.on('error', () => {})
    return { channel: createStdioChannel(child), lifecycle: createProcessLifecycle(child) }
  },
}

// ---------------------------------------------------------------------------
// inproc：同语言入口载入宿主进程同一线程，直调
// ---------------------------------------------------------------------------

const inprocHost: ServiceHost = {
  async start(decl, input) {
    const entry = pathToFileURL(join(input.cwd, decl.start)).href
    let module: Record<string, unknown>
    try {
      module = (await import(entry)) as Record<string, unknown>
    } catch {
      throw new ServiceStartError('import_failed')
    }
    const factory = resolveServiceFactory(module)
    if (factory === null) throw new ServiceStartError('bad_service_entry')
    let instance: ServiceInstance | null = null
    let messageCb: ((message: Json) => void) | null = null
    let closed = false
    const channel: ServiceChannel = {
      write(frame: Json): void {
        if (closed) throw new Error('channel_closed')
        const copy = structuredClone(frame)
        queueMicrotask(() => {
          if (!closed) instance?.receive(copy)
        })
      },
      onMessage(cb) {
        messageCb = cb
      },
      onClose() {
        // in-proc 无独立退出事件：同线程服务崩溃即宿主崩溃（已知代价，见 docs/plugins.md）
      },
      close(): void {
        if (closed) return
        closed = true
        try {
          instance?.close?.()
        } catch {
          // close 尽力而为
        }
      },
    }
    try {
      instance = factory({
        emit: (message) => {
          if (closed) return
          const copy = structuredClone(message)
          queueMicrotask(() => {
            if (!closed) messageCb?.(copy)
          })
        },
        env: loaderEnv(input.pluginStateDir, input.dataDir),
      })
    } catch {
      throw new ServiceStartError('service_init_failed')
    }
    const lifecycle: ServiceLifecycle = {
      get exited() {
        return closed
      },
      get exitReason() {
        return closed ? 'closed' : null
      },
      onExit() {
        // 同线程无独立退出事件
      },
      terminate() {
        channel.close()
      },
      waitForExit() {
        return Promise.resolve()
      },
    }
    return { channel, lifecycle }
  },
}

// ---------------------------------------------------------------------------
// worker：worker_threads 独立堆 + 结构化克隆消息
// ---------------------------------------------------------------------------

function createWorkerChannel(worker: Worker): ServiceChannel {
  let messageCb: ((message: Json) => void) | null = null
  let closeCb: ((reason: string) => void) | null = null
  let closed = false
  const notifyClose = (reason: string): void => {
    if (closed) return
    closed = true
    closeCb?.(reason)
  }
  worker.on('message', (message) => {
    if (!closed) messageCb?.(message as Json)
  })
  worker.on('error', () => notifyClose('worker_error'))
  worker.on('exit', (code) => notifyClose(code === 0 ? 'worker_exit' : `exit:${code}`))
  return {
    get pid() {
      return undefined
    },
    write(frame: Json): void {
      if (closed) throw new Error('channel_closed')
      worker.postMessage(frame)
    },
    onMessage(cb) {
      messageCb = cb
    },
    onClose(cb) {
      closeCb = cb
    },
    close(): void {
      if (closed) return
      closed = true
      void worker.terminate()
    },
  }
}

function waitForWorkerExit(worker: Worker, timeoutMs: number): Promise<void> {
  if (worker.threadId === -1) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      worker.removeListener('exit', onExit)
      resolve()
    }, timeoutMs)
    timer.unref?.()
    worker.once('exit', onExit)
  })
}

function createWorkerLifecycle(worker: Worker): ServiceLifecycle {
  const callbacks: Array<(reason: string) => void> = []
  let exited = false
  let reason: string | null = null
  const fire = (next: string): void => {
    if (exited) return
    exited = true
    reason = next
    for (const cb of callbacks) cb(next)
  }
  worker.on('exit', (code) => fire(code === 0 ? 'worker_exit' : `exit:${code}`))
  worker.on('error', () => fire('worker_error'))
  return {
    get exited() {
      return exited
    },
    get exitReason() {
      return reason
    },
    onExit(cb) {
      callbacks.push(cb)
      if (exited) cb(reason ?? 'worker_exit')
    },
    terminate() {
      void worker.terminate()
    },
    waitForExit(timeoutMs) {
      return waitForWorkerExit(worker, timeoutMs)
    },
  }
}

const workerHost: ServiceHost = {
  async start(decl, input) {
    const entry = join(input.cwd, decl.start)
    const worker = new Worker(new URL('./worker-bootstrap.mjs', import.meta.url), {
      workerData: { entry, env: loaderEnv(input.pluginStateDir, input.dataDir) },
    })
    return { channel: createWorkerChannel(worker), lifecycle: createWorkerLifecycle(worker) }
  },
}
