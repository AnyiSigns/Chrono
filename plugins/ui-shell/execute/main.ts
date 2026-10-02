// `ui-shell` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 另起主端口 HTTP 服务 + 自实现入站客户端；反向调用经 `host.source.read` 取 headless 入口字节。

import {
  PortLink,
  createService as createSdkService,
  isDirectRun,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { InboundClient, inboundSocketPath, rootFromPluginState } from 'plugin-sdk/web'
import { Bridge, deriveBootMode, extractValue } from './bridge.ts'
import { decodeSourceRead } from './host-client.ts'
import { startUiServer } from './http-server.ts'
import type { ShellState, UiServer, UiServerDeps } from './http-server.ts'
import { identityInvalidatesHeadless } from './identity-events.ts'
import { log } from './log.ts'
import { DEFAULT_UI_PORT, ensureHeadless, ensureMounts } from './mounts.ts'
import type { HeadlessEntry } from './mounts.ts'
import { orderNav, recordsOf, uiStateKeysOf } from './nav.ts'
import type { NavRecord } from './nav.ts'
import { mergeSlotDecls, parseSlotDecls } from './slot-decls.ts'
import { ensureSlots } from './slots.ts'
import { SHELL_IMPL, shellStateRecord, SseHub } from './sse.ts'
import { normalizeThemePref, themePrefOfConfig } from './theme.ts'
import { isRecord } from './types.ts'
import type { Json, Rec } from './types.ts'

const CAPABILITY = 'ui-shell'
/** 是否 stdio 直接运行（反向通道随 `runStdio` 的 build 立即可用）；inproc / worker 由宿主后调 build。 */
const DIRECT_RUN = isDirectRun(import.meta.url)

const root = rootFromPluginState(process.env, process.cwd())
const stateDir = `${root}/state`
// 核心表（页面自带槽 / 默认挂载 / 默认 headless）：合并提供方 `ui-slot` 声明时它们恒优先。
const CORE_MOUNTS = ensureMounts(stateDir).mounts
const CORE_HEADLESS = ensureHeadless(stateDir).headless
const CORE_SLOTS = ensureSlots(stateDir).slots
let mounts = CORE_MOUNTS
let headless = CORE_HEADLESS
let slots = CORE_SLOTS

/** 解析壳自身端口（`CHRONO_UI_PORT`）；非法 / 缺省返回 null（回落 `DEFAULT_UI_PORT`）。 */
function parseShellPort(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

const sse = new SseHub()
/** 服务 → 宿主发帧出口；build 拿到 ctx.emit 后接入（模块级函数在装配后才发起反向调用）。 */
let emitFrame: (message: Json) => void = () => {}
const host = new PortLink({ write: (message) => emitFrame(message), idPrefix: 'ui-shell-pc' })
const headlessCache = new Map<string, string>()
let headlessIds = new Set(headless.map((entry) => entry.id))
/** slot 客户端半边字节缓存（取代 /p/ 反代；按挂载表 entry 字段判定）。 */
const uiCache = new Map<string, string>()
/** 挂载表中带客户端半边入口的项（headless 无入口、不参与 slot 装载）。 */
function uiEntriesOf(list: typeof mounts): (typeof mounts[number] & { entry: string })[] {
  return list.filter(
    (entry): entry is (typeof mounts[number] & { entry: string }) =>
      typeof entry.entry === 'string' && entry.entry.length > 0,
  )
}
let uiEntries = uiEntriesOf(mounts)
let uiIds = new Set(uiEntries.map((entry) => entry.id))
/** 最近一次汇集到的 `ui-nav` 记录：供 bootstrap 派生 uiState 键空间（合并进引导数据）。 */
let navRecords: NavRecord[] = []
/** 引导数据里的 uiState 键：由 nav 记录目标派生（供壳按数据登记键空间，不写死白名单）。 */
function uiStateKeys(): string[] {
  return uiStateKeysOf(navRecords)
}
/** 冷启动竞态等待上限：目标插件服务可能晚于壳就绪（物化 / 构建 / 起进程）。 */
const COLD_START_DEADLINE_MS = 30_000

let connected = false
let hasDisconnected = false
let themePref = 'system'
let bootMode = 'onboarding'
let uiServer: UiServer | null = null
let exiting = false

function shellState(): ShellState {
  return { connected, theme: themePref, boot_mode: bootMode }
}

const inbound = new InboundClient({
  socketPath: inboundSocketPath(root),
  log,
  onEvent: (impl, topic, payload) => {
    sse.hostEvent(impl, topic, payload)
    if (impl === 'host' && topic === 'identity.changed') {
      // 仅清单内身份、且代码世代变化时才失效重取；数据世代与清单外身份不动缓存。
      const staleHeadless = identityInvalidatesHeadless(payload, headlessIds)
      if (staleHeadless !== null) {
        headlessCache.delete(staleHeadless)
        void refreshHeadless()
        return
      }
      const staleUi = identityInvalidatesHeadless(payload, uiIds)
      if (staleUi !== null) {
        uiCache.delete(staleUi)
        void refreshUi()
      }
      // 世界成员表可能变化（新增 / 换代提供方）：合帧后重取槽声明与导航记录。
      scheduleProviderRefresh()
      return
    }
  },
  onFrame: (frame) => {
    const run = typeof frame['run'] === 'string' ? (frame['run'] as string) : null
    const topic = run === null ? 'host.frame' : 'run.result'
    sse.broadcast({ impl: SHELL_IMPL, topic, payload: frame as unknown as Json })
  },
  onConnectionChange: (next) => {
    const prev = connected
    connected = next
    sse.connectionChanged(prev, next, themePref, hasDisconnected)
    if (!next) {
      hasDisconnected = true
      return
    }
    void refreshHeadless()
    void refreshUi()
    void refreshConfig()
    void refreshSlotDecls()
    void refreshNav()
  },
})
// 入站桥超时须 ≥ 宿主调用超时（`--call-timeout-ms`，缺省 30s）：否则长回合（`chat.send` 整回合同步执行）
// 期间排队的 `chat.history` 会在壳侧先超时，UI 收到伪 `transport_failed`。留一点余量以收到宿主自身的超时回帧。
const bridge = new Bridge(inbound, 35_000)

/** 取单个 headless 入口字节（经 `host.source.read`）；失败返回 null。 */
async function fetchHeadless(entry: HeadlessEntry): Promise<string | null> {
  const result = await host.call('host', 'source.read', { identity: entry.id, path: entry.entry })
  if (!result.ok) {
    log(`headless ${entry.id}: source.read failed (${result.code})`)
    return null
  }
  const decoded = decodeSourceRead(result.value)
  if (decoded === null) {
    log(`headless ${entry.id}: source.read shape invalid`)
    return null
  }
  return decoded.text
}

/** 读 headless 入口字节；首载竞态（宿主刚装配）失败时短暂退避重试一次。失败不缓存，下次请求 / 重连再试。 */
async function refreshHeadless(): Promise<void> {
  for (const entry of headless as HeadlessEntry[]) {
    if (headlessCache.has(entry.id)) continue
    let text = await fetchHeadless(entry)
    if (text === null) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (exiting) return
      text = await fetchHeadless(entry)
    }
    if (text === null) continue
    headlessCache.set(entry.id, text)
    log(`headless ${entry.id}: ${text.length} bytes cached`)
  }
}

/**
 * 取单个 slot 客户端半边字节：走插件自己的 `<id>.client.read` 命令。
 * 产物在物化目录内、被 `.worldignore` 排除，`host.source.read`（只读世界树）读不到；
 * 由插件进程读自己的包内文件回字节，宿主只路由。
 */
async function fetchUi(entry: { id: string; entry: string }): Promise<string | null> {
  const result = await bridge.command(`${entry.id}.client.read`, { path: entry.entry })
  if (!result.ok) {
    log(`ui ${entry.id}: client.read failed (${result.code})`)
    return null
  }
  const value = extractValue(result.frame)
  const text = isRecord(value) && typeof value['text'] === 'string' ? value['text'] : null
  if (text === null) {
    // 服务尚未就绪（eff 未解析）是冷启动常态，交由重试等待；形状确有问题才记日志。
    if (!isRefusedFrame(result.frame)) log(`ui ${entry.id}: client.read shape invalid`)
    return null
  }
  return text
}

/** 读 slot 客户端半边字节；首载竞态失败时短暂退避重试一次。失败不缓存，下次请求 / 重连再试。 */
async function refreshUi(): Promise<void> {
  for (const entry of uiEntries) {
    if (uiCache.has(entry.id)) continue
    let text = await fetchUi(entry)
    if (text === null) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (exiting) return
      text = await fetchUi(entry)
    }
    if (text === null) continue
    uiCache.set(entry.id, text)
    log(`ui ${entry.id}: ${text.length} bytes cached`)
  }
}

/** 经入站 `config.read` 更新无配置判据与主题偏好（服务不读投影）；变化时广播重推。 */
async function refreshConfig(): Promise<void> {
  const read = await bridge.configRead()
  if (!read.ok) return
  const nextBoot = deriveBootMode(read.value)
  const nextTheme = normalizeThemePref(themePrefOfConfig(read.value))
  const changed = nextBoot !== bootMode || nextTheme !== themePref
  bootMode = nextBoot
  themePref = nextTheme
  if (changed) sse.broadcast(shellStateRecord(connected, themePref))
}

/** 结果帧是否为拒绝（`eff_error` 等）：冷启动期服务未就绪即属此类，应重试而非报错。 */
function isRefusedFrame(frame: Rec | null): boolean {
  if (frame === null) return false
  const observations = frame['observations']
  return (
    Array.isArray(observations) &&
    observations.some((item) => isRecord(item) && item['kind'] === 'refused')
  )
}

/**
 * 首载竞态（宿主刚装配 / 目标插件重启）退避重试至截止时间；失败返回 null 并记一条日志。
 * 冷启动时目标服务可能晚于壳就绪，单次重试窗口不足，故按指数退避等待。
 */
async function fetchWithRetry(label: string, fetch: () => Promise<string | null>): Promise<string | null> {
  const deadline = Date.now() + COLD_START_DEADLINE_MS
  let delay = 200
  for (;;) {
    const text = await fetch()
    if (text !== null) return text
    if (exiting) return null
    if (Date.now() >= deadline) {
      log(`${label}: not ready after ${Math.round(COLD_START_DEADLINE_MS / 1000)}s`)
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, 2000)
  }
}

/**
 * 取 headless 入口字节（供 `/assets/headless/<id>.js`）：冷缓存时**等待**取回再回 200，
 * 不再「先 404、下次再来」——否则每次刷新都会先掉一批 404。取不到才 null（调用方回 404）。
 */
async function headlessSource(id: string): Promise<string | null> {
  const cached = headlessCache.get(id)
  if (cached !== undefined) return cached
  const entry = headless.find((item) => item.id === id)
  if (entry === undefined) return null
  const text = await fetchWithRetry(`headless ${id}`, () => fetchHeadless(entry))
  if (text !== null) headlessCache.set(id, text)
  return text
}

/**
 * 取 slot 客户端半边字节（供 `/assets/ui/<id>.js`）：冷缓存时等待取回再回 200，失败才 null。
 * 取代旧的「首次未命中即 404 + 异步预热」，避免刷新时的 404 洪峰。
 */
async function uiSource(id: string): Promise<string | null> {
  const cached = uiCache.get(id)
  if (cached !== undefined) return cached
  const entry = uiEntries.find((item) => item.id === id)
  if (entry === undefined) return null
  const text = await fetchWithRetry(`ui ${id}`, () => fetchUi(entry))
  if (text !== null) uiCache.set(id, text)
  return text
}

/**
 * 汇集某能力类各提供方经 `list` 返回的值：经宿主身份清单发现实现者，按身份名码元序逐一反向调
 * `<capability>.list`（按成员定位的 many）。零提供方 / 调用失败 / 形状非法一律按缺席处理，回空表。
 */
async function collectProviders(capability: string): Promise<{ provider: string; value: Json }[]> {
  const listed = await host.call('host', 'identities', {})
  if (!listed.ok || !isRecord(listed.value)) return []
  const list = listed.value['list']
  if (!Array.isArray(list)) return []
  const providers: string[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    const id = item['id']
    const implemented = item['implements']
    if (typeof id !== 'string' || !Array.isArray(implemented)) continue
    if (implemented.includes(capability)) providers.push(id)
  }
  providers.sort()
  const out: { provider: string; value: Json }[] = []
  for (const provider of providers) {
    const outcome = await host.call(capability, 'list', {}, { provider })
    if (!outcome.ok) continue
    out.push({ provider, value: outcome.value })
  }
  return out
}

/** 汇集 `ui-nav` 各提供方的中立记录并缓存（供 bootstrap 派生 uiState 键空间）。 */
async function collectNav(): Promise<{ records: NavRecord[] }> {
  const groups = (await collectProviders('ui-nav')).map(({ provider, value }) => ({
    provider,
    records: recordsOf(value),
  }))
  return { records: orderNav(groups) }
}

/** 拉取并缓存 `ui-nav` 记录；bootstrap 的 uiState 键空间据此派生。 */
async function refreshNav(): Promise<void> {
  const { records } = await collectNav()
  navRecords = records
}

/**
 * 汇集 `ui-slot` 提供方的槽 / 挂载 / headless 声明，并入壳的核心表（核心条目优先）。
 * 合并结果同时回写 http-server 依赖对象，后续页面引导按合并后的表渲染。
 */
async function refreshSlotDecls(): Promise<void> {
  const decls = (await collectProviders('ui-slot')).map(({ value }) => parseSlotDecls(value))
  const merged = mergeSlotDecls(
    { slots: CORE_SLOTS, mounts: CORE_MOUNTS, headless: CORE_HEADLESS },
    decls,
  )
  slots = merged.slots
  mounts = merged.mounts
  headless = merged.headless
  headlessIds = new Set(headless.map((entry) => entry.id))
  uiEntries = uiEntriesOf(mounts)
  uiIds = new Set(uiEntries.map((entry) => entry.id))
  uiDeps.mounts = mounts
  uiDeps.headless = headless
  uiDeps.slots = slots
}

/** http-server 依赖：`refreshSlotDecls` 合并后回写 `mounts` / `headless` / `slots`。 */
const uiDeps: UiServerDeps = {
  mounts,
  headless,
  slots,
  bridge,
  sse,
  state: shellState,
  headlessSource,
  uiSource,
  applyThemePref,
  uiStateKeys,
  log,
}

/** 提供方声明重取的合帧计时器：identity.changed 常成批到达，合并成一次汇集。 */
let providerRefreshTimer: ReturnType<typeof setTimeout> | null = null

/** 世界身份变化后重取 `ui-slot` 声明与 `ui-nav` 记录（新增 / 换代提供方免改壳源码）。 */
function scheduleProviderRefresh(): void {
  if (providerRefreshTimer !== null) return
  providerRefreshTimer = setTimeout(() => {
    providerRefreshTimer = null
    void refreshSlotDecls()
    void refreshNav()
  }, 250)
  providerRefreshTimer.unref?.()
}

function applyThemePref(pref: string): void {
  themePref = normalizeThemePref(pref)
  sse.broadcast(shellStateRecord(connected, themePref))
}

/** 停机：关入站连接与主端口；返回的 promise 落地后由 stdio 形态收口退出（inproc / worker 由宿主 teardown）。 */
function shutdown(): Promise<void> {
  if (exiting) return Promise.resolve()
  exiting = true
  inbound.close()
  const server = uiServer
  uiServer = null
  if (server === null) return Promise.resolve()
  return server.close().then(
    () => undefined,
    () => undefined,
  )
}

/** 构造服务实例：唯一方法为健康占位；反向调用应答由 SDK 的 `portLinks` 结算。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  emitFrame = ctx.emit
  // inproc / worker 下模块加载早于宿主调 build，反向通道此时才可用：补一次提供方声明汇集。
  if (!DIRECT_RUN) {
    void refreshSlotDecls()
    void refreshNav()
  }
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: {
      ping: () => ({ value: { pong: true, identity: CAPABILITY }, events: [] }),
      nav: async () => {
        const result = await collectNav()
        navRecords = result.records
        return { value: result, events: [] }
      },
    },
    emit: ctx.emit,
    log,
    portLinks: [host],
    onDrain: () => shutdown(),
    onClose: () => {
      void shutdown()
    },
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log })
}

inbound.start()

const uiPort = parseShellPort(process.env['CHRONO_UI_PORT']) ?? DEFAULT_UI_PORT

/** 提供方声明首载等待上限：宿主装配可能晚就绪，超时即用核心表起服务，后续汇聚再回写。 */
const EAGER_DECL_WAIT_MS = 2500

/**
 * 起主端口服务。stdio 下先在有限窗口内汇集 `ui-slot` / `ui-nav`，令首批引导数据即含合并后的表；
 * 窗口内未就绪则照常起服务，由连接恢复 / 世界变更的后续汇聚补齐（不阻塞 UI 端口绑定）。
 */
async function bootUiServer(): Promise<void> {
  if (DIRECT_RUN) {
    await Promise.race([
      Promise.all([refreshSlotDecls(), refreshNav()]).then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, EAGER_DECL_WAIT_MS)
        timer.unref?.()
      }),
    ])
  }
  try {
    const server = await startUiServer(uiDeps, uiPort)
    uiServer = server
    log(`ui-shell listening on 127.0.0.1:${server.port} (pid ${process.pid})`)
    // 宿主入站 socket 在装配后才监听：延迟一次尝试取 headless 字节与配置（失败由重连兜底）
    const timer = setTimeout(() => {
      if (connected) {
        void refreshHeadless()
        void refreshUi()
        void refreshConfig()
        void refreshSlotDecls()
        void refreshNav()
      }
    }, 1500)
    timer.unref?.()
  } catch (err) {
    log(`cannot listen on 127.0.0.1:${uiPort}: ${(err as Error).message}`)
    process.exit(1)
  }
}

void bootUiServer()
