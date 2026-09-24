// 本插件命令 / 提交薄封装：全部走壳 api（`ctx.command` / `ctx.submit` / `ctx.cancel`），
// 不再自建 HTTP 面。只做「帧形状 → 结构化结果」的归一，不触 DOM。
// 读-改-写只覆盖本线程键（per-thread 键控）。

import type { SlotContext } from '@chrono/ui-contract'
import {
  configWriteDirective,
  identityActive,
  identityBody,
  isCodeGenFallbackBody,
  isRecord,
  mergeSlotBody,
  slotWriteDirective,
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

/** 身份读值：data body + 该身份的 active（写 `add_gen` 的 `expect_active`）。 */
export interface IdentityRead {
  body: unknown
  active: string | null | undefined
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
  writeConfig(body: unknown, expectActive?: string | null, thread?: string): Promise<SubmitResult>
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

  async function submitDirectives(directives: unknown, thread?: string): Promise<SubmitResult> {
    const options = typeof thread === 'string' ? { thread } : undefined
    return asSubmit(await ctx.submit(directives as never, options))
  }

  /** 读身份：命令返回整份身份视图，拆出 `body` 与 `active`。 */
  async function readIdentity(name: string, args: unknown, thread?: string): Promise<IdentityRead> {
    const result = await command(name, args, thread)
    if (!result.ok) return { body: null, active: undefined }
    return { body: identityBody(result.value), active: identityActive(result.value) }
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
    writeConfig: (body, expectActive, thread) =>
      submitDirectives([configWriteDirective(body as never, expectActive)], thread),
    async writeSlot(threadKey, slot) {
      const read = await readIdentity('input.read', { thread: threadKey }, threadKey)
      if (read.body === null) return { ok: false, code: 'not_loaded', run: null }
      // 读到代码世代回落 body（无数据世代）→ 未就绪，拒写以免污染身份。
      if (isCodeGenFallbackBody(read.body)) return { ok: false, code: 'not_loaded', run: null }
      const merged = mergeSlotBody(read.body, threadKey, slot as never)
      return submitDirectives([slotWriteDirective(merged, read.active)], threadKey)
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
