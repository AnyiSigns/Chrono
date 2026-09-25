// 本插件命令薄封装：全部走壳 api（`ctx.command` / `ctx.cancel`），不再自建 HTTP 面。
// 只做「帧形状 → 结构化结果」的归一，不触 DOM。运行记录出世界：槽 / 配置写走 owner 命令。

import type { SlotContext } from '@chrono/ui-contract'
import {
  configWriteCommand,
  identityActive,
  identityBody,
  identityDataGen,
  isRecord,
  slotWriteCommand,
} from './model.ts'

export interface CommandResult {
  ok: boolean
  value: unknown
  code: string
  message: string
}

export interface SubmitResult {
  ok: boolean
  code: string
  run: string | null
}

/** 身份读值：data body + 该身份的 active（写 `add_gen` 的 `expect_active`）。
 * `error` 非空表示读取本身失败（命令未 ok / 传输中断），此时 `body` 为 null；
 * 与「读成功但 body 为空」区分，供上层渲染失败态而非静默空配置。 */
export interface IdentityRead {
  body: unknown
  active: string | null | undefined
  dataGen: unknown
  error: string | null
}

function asCommand(result: unknown): CommandResult {
  if (isRecord(result)) {
    const ok = result.ok === true
    return {
      ok,
      value: result.value,
      code: typeof result.code === 'string' ? result.code : ok ? '' : 'unknown',
      message: typeof result.message === 'string' ? result.message : '',
    }
  }
  return { ok: false, value: null, code: 'unknown', message: '' }
}

function asSubmit(result: unknown): SubmitResult {
  if (isRecord(result)) {
    const ok = result.ok === true
    return {
      ok,
      code: typeof result.code === 'string' ? result.code : ok ? '' : 'bad_directive',
      run: typeof result.run === 'string' ? result.run : null,
    }
  }
  return { ok: false, code: 'bad_directive', run: null }
}

export interface ComposerClient {
  readConfig(): Promise<unknown>
  readConfigState(): Promise<IdentityRead>
  writeConfig(patch: unknown, thread?: string): Promise<SubmitResult>
  writeSlot(threadKey: string, slot: unknown): Promise<SubmitResult>
  triggerSend(threadKey: string): Promise<CommandResult>
  cancelRun(run: string): Promise<{ ok: boolean; code: string }>
  fetchProfile(): Promise<CommandResult>
}

export function createClient(ctx: SlotContext): ComposerClient {
  async function command(name: string, args: unknown, thread?: string): Promise<CommandResult> {
    const options = typeof thread === 'string' ? { thread } : undefined
    return asCommand(await ctx.command(name, args as never, options))
  }

  /** 读身份：命令返回整份身份视图，拆出 `body` 与 `active`。 */
  async function readIdentity(name: string, args: unknown, thread?: string): Promise<IdentityRead> {
    const result = await command(name, args, thread)
    if (!result.ok) return { body: null, active: undefined, dataGen: undefined, error: result.code }
    return {
      body: identityBody(result.value),
      active: identityActive(result.value),
      dataGen: identityDataGen(result.value),
      error: null,
    }
  }

  async function readConfigState(): Promise<IdentityRead> {
    return readIdentity('config.read', null)
  }

  async function readConfig(): Promise<unknown> {
    return (await readConfigState()).body
  }

  return {
    readConfig,
    readConfigState,
    /** 配置写口：`config.write` 命令，服务按补丁读-改-写自有持久存储（不再整值 put + add_gen）。 */
    async writeConfig(patch, thread) {
      const built = configWriteCommand(isRecord(patch) ? patch : {})
      return asSubmit(await command(built.name, built.args, thread))
    },
    /** 输入槽写口：`input.write` 命令，服务按线程键写自有持久存储（不再构造世界写 directive）。 */
    async writeSlot(threadKey, slot) {
      const built = slotWriteCommand(threadKey, slot)
      return asSubmit(await command(built.name, built.args, threadKey))
    },
    triggerSend: (threadKey) => command('chat.send', null, threadKey),
    async cancelRun(run) {
      const result = await ctx.cancel(run)
      if (isRecord(result)) {
        return { ok: result.ok === true, code: typeof result.code === 'string' ? result.code : '' }
      }
      return { ok: false, code: '' }
    },
    fetchProfile: () => command('model.profile', null),
  }
}
