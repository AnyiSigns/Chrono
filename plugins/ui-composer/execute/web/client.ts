// 本插件命令 / 提交薄封装：全部走壳 api（`ctx.command` / `ctx.submit` / `ctx.cancel`），
// 不再自建 HTTP 面。只做「帧形状 → 结构化结果」的归一，不触 DOM。
// 读-改-写只覆盖本线程键（per-thread 键控）。

import type { SlotContext } from '@chrono/ui-contract'
import { configWriteDirective, isRecord, mergeSlotBody, slotWriteDirective } from './model.ts'

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
  writeConfig(body: unknown, thread?: string): Promise<SubmitResult>
  readInputBody(threadKey: string): Promise<unknown>
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

  async function readConfig(): Promise<unknown> {
    const result = await command('config.read', null)
    return result.ok && isRecord(result.value) ? result.value : null
  }

  async function readInputBody(threadKey: string): Promise<unknown> {
    const result = await command('input.read', { thread: threadKey }, threadKey)
    return result.ok && isRecord(result.value) ? result.value : null
  }

  return {
    readConfig,
    writeConfig: (body, thread) => submitDirectives([configWriteDirective(body as never)], thread),
    readInputBody,
    async writeSlot(threadKey, slot) {
      const body = await readInputBody(threadKey)
      if (body === null) return { ok: false, code: 'input_unavailable', run: null }
      const merged = mergeSlotBody(body, threadKey, slot as never)
      return submitDirectives([slotWriteDirective(merged)], threadKey)
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
