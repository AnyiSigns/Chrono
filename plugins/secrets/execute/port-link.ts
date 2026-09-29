// 本地密钥读取后端抽象：生产环境经 SDK 反向调用通道发 `port.call secrets-local.read / list`，
// 单测注入假后端。失败作数据（结构化码），不抛未捕获错误、不断通道。

import type { Json, PortCaller } from 'plugin-sdk'

/** secrets-local 读取失败：带结构化码，调用方据此回结构化错误。 */
export class LocalSecretsError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LocalSecretsError'
    this.code = code
  }
}

/** 本地密钥读取后端抽象：生产环境是反向调用 `secrets-local.read / list`，单测注入假后端。 */
export interface LocalSecretsReader {
  read(name: string): Promise<string>
  list(): Promise<Json>
}

/** `secrets-local.read / list` 的反向调用后端：成功回值，失败抛结构化 LocalSecretsError。 */
export class RemoteLocalSecrets implements LocalSecretsReader {
  private readonly link: PortCaller

  constructor(link: PortCaller) {
    this.link = link
  }

  async read(name: string): Promise<string> {
    const outcome = await this.link.call('secrets-local', 'read', { name })
    if (!outcome.ok) throw new LocalSecretsError(outcome.code, outcome.message)
    if (typeof outcome.value !== 'string') {
      throw new LocalSecretsError('secret_missing', 'secrets-local.read returned no value')
    }
    return outcome.value
  }

  async list(): Promise<Json> {
    const outcome = await this.link.call('secrets-local', 'list', {})
    if (!outcome.ok) throw new LocalSecretsError(outcome.code, outcome.message)
    return outcome.value
  }
}
