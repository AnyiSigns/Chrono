// CLI 薄壳：解析入口参数后交给四域派发表 `world` / `plugin` / `term` / `help`。
// 未知顶层命令 fail-closed（不再有扁平插件命令兜底——插件命令只经 `plugin <世界> <命令>`）。

import { parseEntryArgv, resolveRoot } from '../host/index.ts'
import { handlers, helpText } from './commands.ts'

async function main(): Promise<void> {
  const options = parseEntryArgv(process.argv.slice(2))
  const root = resolveRoot(options.root)
  const [command, ...args] = options.rest

  if (command === undefined) {
    process.stdout.write(`${helpText()}\n`)
    return
  }
  const handler = Object.hasOwn(handlers, command) ? handlers[command] : undefined
  if (handler === undefined) throw new Error(`unknown_command: ${command}`)
  await handler({ root, args, options })
}

try {
  await main()
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`)
  process.exitCode = 1
}
