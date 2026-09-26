// 框架保留命令名的单一真源：CLI 派发与入世保留名校验共用同一份，防止两处清单漂移。
// 它是「框架保留的命令名」，不是「CLI 自有命令」——CLI 与入世都是它的消费者。

/** 框架保留命令名：插件命令不得占用，CLI 亦不把它们当插件命令。 */
export const FRAMEWORK_COMMAND_NAMES = [
  'start',
  'stop',
  'run',
  'status',
  'seed',
  'pack',
  'verify',
  'replay',
  'unseeded',
  'compact',
  'commands',
  'audit',
  'assets',
  'blobs',
  'materialized',
  'help',
] as const

export type FrameworkCommandName = (typeof FRAMEWORK_COMMAND_NAMES)[number]

/** 保留名集合：入世与 CLI 判定的共同形态。 */
export const FRAMEWORK_COMMAND_NAME_SET: ReadonlySet<string> = new Set(FRAMEWORK_COMMAND_NAMES)
