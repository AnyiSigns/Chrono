// 框架保留命令名的单一真源：CLI 派发与入世保留名校验共用同一份，防止两处清单漂移。
// 新 CLI 是两域命名空间：顶层 `world` / `plugin` / `term` / `help`，插件命令只能经
// `chrono plugin <世界> <命令>` 调用——因此插件声明名只与 plugin 子命令动词冲突，与顶层名不冲突。

/** 顶层 CLI 命令名：派发表键集，也是唯一「CLI 自有命令」清单。 */
export const FRAMEWORK_COMMAND_NAMES = ['world', 'plugin', 'term', 'help'] as const

/** 顶层命令名集合：CLI 判定的统一形态。 */
export const FRAMEWORK_COMMAND_NAME_SET: ReadonlySet<string> = new Set(FRAMEWORK_COMMAND_NAMES)

/**
 * plugin 子命名空间里的框架子命令（`chrono plugin <世界> <子命令>`）：
 * 插件声明的命令名撞这些即拒（否则与该嵌套子命令歧义）。
 */
export const PLUGIN_RESERVED_COMMAND_NAMES = [
  'ls',
  'add',
  'upgrade',
  'remove',
  'info',
  'switch',
  'commands',
] as const

/** plugin 保留名集合：入世保留名校验的形态。 */
export const PLUGIN_RESERVED_COMMAND_NAME_SET: ReadonlySet<string> = new Set(
  PLUGIN_RESERVED_COMMAND_NAMES,
)
