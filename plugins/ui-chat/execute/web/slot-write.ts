// 输入槽写指令（纯函数，零 react / DOM）：输入槽已出世界，写走 `input` 服务的 `input.write` 命令。
// 服务按调用帧 `env.thread` 与本线程键写入自有持久存储（④），不再构造世界写 directive。

/** 构造写本线程槽的命令：`{name, args}` 交 `ctx.command` 调用。 */
export function slotWriteCommand(threadKey: string, slot: any): { name: string; args: any } {
  return { name: 'input.write', args: { thread: threadKey, slot } }
}
