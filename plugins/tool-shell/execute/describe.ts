// 工具面自述（`tool-shell.describe` 的输出）：单工具 `shell` + 描述四要素 + argsSchema + caps + render。
// 描述文本按注入的平台 shell 口径生成（Windows PowerShell / unix POSIX shell），不对模型声称跨平台统一语法；
// render 摘要取模型填写的 `description`（缺省为空串），命令本体在展开的 terminal 里。
// 形状对齐 `tool` 端口契约：四要素必填非空、`param_semantics` 覆盖必填参数、`caps` 对象形含 `fs.read`。

import type { Json, Rec } from './types.ts'

/** mode=code 支持的语言白名单（v1）。 */
export const LANGUAGES: readonly string[] = ['javascript', 'python', 'shell']

/** 声明上限：与 sandbox caps 形状一致；实际执行取「声明 ∩ 当前权限档」。 */
export const DEFAULT_CAPS: Rec = {
  fs: { read: 'workspace', write: 'workspace' },
  net: 'none',
  cpu_ms: 60000,
  mem_mb: 512,
  timeout_ms: 120000,
  output_max: 1048576,
  procs_max: 32,
}

/** 命令形态的平台原生 shell 调用：`cmd` + 固定参数前缀，输入串追加在末尾。 */
export interface ShellInvocation {
  cmd: string
  argsPrefix: readonly string[]
  /** 追加在输入串之前的固定前导（如 Windows 的控制台 UTF-8 编码设置）；缺省无。 */
  preamble?: string
}

/** 一次执行所用的平台 shell 口径：命令 / `code`=`shell` 用 `command`，`code`=`python` 用 `python`。 */
export interface ShellProfile {
  command: ShellInvocation
  /** 常驻会话 shell（stdin 行式 REPL）：Windows `-NoExit -Command -`；unix `sh -s`。 */
  session: ShellInvocation
  /** 会话哨兵口径：`powershell`（Write-Output）/ `posix`（printf）。 */
  sessionSyntax: 'powershell' | 'posix'
  python: string
  /** 人类可读 shell 名（describe 文本）：如 `pwsh` / `bash`。 */
  label: string
  /** 语法口径（describe 文本）：`PowerShell` / `POSIX shell`。 */
  syntax: string
}

/** 一次回报本插件暴露的全部工具（本插件只有一个 shell）。 */
export function describeTools(profile: ShellProfile): Json {
  return { tools: [shellTool(profile)] }
}

function shellTool(profile: ShellProfile): Rec {
  return {
    name: 'shell',
    intent: '在隔离环境中执行一条命令或一段代码片段。',
    when_to_use: '需要跑构建 / 测试 / 脚本、做一次性计算，或需要延续 cd / 环境变量、跑长驻服务时。',
    param_semantics: {
      action: "'run'（缺省）执行命令 / 代码；'output' 读后台任务新输出；'kill' 终止后台任务；'reset' 重开当前会话。",
      mode: "'command' 跑一条命令；'code' 跑脚本 / 表达式并按结构化结果回；缺省 'command'。",
      input: `命令串或代码片段（action=run 必填）。command 形态按平台原生 ${profile.syntax} 语法（${profile.label}）解析；相对路径以工作目录为基准。`,
      language: "mode=code 时的语言，取白名单之一（javascript / python / shell）。",
      description: '一句话说明这条命令做什么（供审批与审计展示；run 时务必填写）。',
      workdir: '本次命令的工作目录；相对路径以工作目录为基准，缺省即工作目录本身。',
      timeout_ms: '本次执行的超时上限（毫秒）；不得超过工具声明的上限，超过按声明上限截断。',
      background: 'true 时后台运行并立即回任务号，用 action:"output" 续读、action:"kill" 终止。',
      fresh: 'true 时先重开当前会话（清空 cwd / 环境变量）再执行。',
      task_id: 'action=output / kill 时的后台任务号。',
      cursor: 'action=output 时的读取游标（上次结果里的 next_cursor）。',
      wait_ms: 'action=output 时最多等待多久（毫秒）等新输出或任务结束。',
    },
    boundaries: '文件读写与查找优先用专用工具（找文件 glob、读文件 read、改文件 edit），不要用 shell 绕行。',
    description: `执行命令或代码片段，可用用户环境的工具（rg、wsl，自行查看），返回退出码与标准输出。命令默认在常驻会话内按平台原生 ${profile.syntax} 语法（${profile.label}）执行，cd 与环境变量跨调用延续。`,
    argsSchema: {
      type: 'object',
      properties: {
        action: { enum: ['run', 'output', 'kill', 'reset'] },
        input: { type: 'string', minLength: 1 },
        mode: {
          enum: ['command', 'code'],
        },
        language: {
          enum: [...LANGUAGES],
        },
        description: {
          type: 'string',
          minLength: 1,
        },
        workdir: {
          type: 'string',
          minLength: 1,
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1,
        },
        background: {
          type: 'boolean',
        },
        fresh: {
          type: 'boolean',
        },
        task_id: {
          type: 'string',
          minLength: 1,
        },
        cursor: {
          type: 'integer',
          minimum: 0,
        },
        wait_ms: {
          type: 'integer',
          minimum: 0,
        },
      },
      required: [],
      additionalProperties: false,
    },
    caps: DEFAULT_CAPS,
    idempotent: false,
    modes: ['command', 'code'],
    languages: [...LANGUAGES],
    render: {
      form: 'card',
      label: 'shell',
      summary: '{description}',
      tone: 'plain',
      detail: { kind: 'terminal' },
      live: true,
    },
  }
}
