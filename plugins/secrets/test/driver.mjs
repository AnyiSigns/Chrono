// `secrets` 协议级测试驱动：spawn 真实 `secrets` 门面进程，按宿主机制注入
// `CHRONO_PLUGIN_MANY_NEEDS`（`secrets-backend` 成员表），并把门面的反向 `port.call`
// 按 `provider` 转给「进程内假后端」（local / env）或「真实夹具后端进程」（vault）。
// 成员表变化 = 世界变更 → 重注入；消费方（门面）代码零改动。
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { relayFrame, serviceEntry, startBridgedService } from './bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG_ROOT = resolve(HERE, '..')

export const FIXED_ENV = { run: 'run-1', thread: 't1', now: 1_700_000_000_000 }

/** 缺省成员表（码元序）：env 与 local 两个内置后端。 */
export const DEFAULT_MEMBERS = ['secrets-env', 'secrets-local']

/** 测试用本地文件读取（仿真 secrets-local）：缺失 → 空表；损坏 → 不可读。 */
export function readLocalSecrets(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, secrets: {} }
    return { ok: false }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false }
  const secrets = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string') secrets[name] = value
  }
  return { ok: true, secrets }
}

/** 进程内假 local 后端：按 secretsFile 读，kinds = ["local"]。 */
function localBackend(secretsFile) {
  return (method, args) => {
    if (method === 'kinds') return { ok: true, value: ['local'] }
    const read = readLocalSecrets(secretsFile)
    if (!read.ok) {
      return { ok: false, code: 'secret_unreadable', message: 'local secrets file is unreadable' }
    }
    if (method === 'list') {
      const value = Object.keys(read.secrets)
        .sort()
        .map((name) => ({ name, has: true }))
      return { ok: true, value }
    }
    if (method === 'read') {
      const value = read.secrets[args?.name]
      if (value === undefined) {
        return { ok: false, code: 'secret_missing', message: 'local secret not found' }
      }
      return { ok: true, value }
    }
    return { ok: false, code: 'unknown_method', message: String(method) }
  }
}

/** 进程内假 env 后端：按 env 映射读，kinds = ["env"]，list 恒空表。 */
function envBackend(env) {
  return (method, args) => {
    if (method === 'kinds') return { ok: true, value: ['env'] }
    if (method === 'list') return { ok: true, value: [] }
    if (method === 'read') {
      const value = env[args?.name]
      if (value === undefined) {
        return { ok: false, code: 'secret_missing', message: 'env secret not found' }
      }
      return { ok: true, value }
    }
    return { ok: false, code: 'unknown_method', message: String(method) }
  }
}

/**
 * 启动一个 `secrets` 门面实例。
 * @param {object} options
 * @param {string[]} [options.members] 注入的 `secrets-backend` 成员表（码元序）
 * @param {string} [options.secretsFile] local 假后端读取的文件路径
 * @param {Record<string,string>} [options.env] env 假后端的取值映射
 * @param {object} [options.vault] 真实 vault 夹具服务（startBridgedService 返回值）
 * @param {string[]} [options.vaultAliases] 视为 vault 夹具的 provider 名
 */
export function startFacade(options = {}) {
  const members = options.members ?? DEFAULT_MEMBERS
  const localFake = localBackend(options.secretsFile)
  const envFake = envBackend(options.env ?? {})
  const vault = options.vault ?? null
  const vaultAliases = options.vaultAliases ?? ['secrets-vault']

  const service = startBridgedService({
    cwd: PKG_ROOT,
    entry: serviceEntry(PKG_ROOT),
    timeoutMs: options.timeoutMs ?? 15000,
    env: { CHRONO_PLUGIN_MANY_NEEDS: JSON.stringify({ 'secrets-backend': members }) },
    onPortCall: async (message) => {
      const provider = typeof message.provider === 'string' ? message.provider : message.port
      if (vault !== null && vaultAliases.includes(provider)) {
        return relayFrame(
          await vault.call(message.port, message.method, message.args ?? {}, message.env),
        )
      }
      if (provider === 'secrets-local') return localFake(message.method, message.args ?? {})
      if (provider === 'secrets-env') return envFake(message.method, message.args ?? {})
      return { ok: false, code: 'unresolved_cap', message: `no backend ${String(provider)}` }
    },
  })

  return {
    child: service.child,
    exit: service.exit,
    portCalls: service.portCalls,
    stderrText: () => service.stderr.join(''),
    request: service.request,
    hello: () => service.hello('secrets'),
    call: (method, args) => service.call('secrets', method, args, FIXED_ENV),
    close: () => service.close(),
  }
}
