# #2 `config`（用户模型配置）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 2 / `config` |
| 职责 | 用户配置的**单一真源**：厂商连接实例（`base_url` / `auth_ref`）+ 模型目录与元数据 + 参数 / 权限档 / 主题 / 语言 / 侧栏宽度 + 当前选择 |
| 依赖 | pins 无；`<-` 12（读连接与模型、写档案元数据）、13（读上下文窗口）、15（写主题）、16（写侧栏宽度）、17（读写）、25（读权限档）、38（读 `ui.notify` 开关）、40（读推理档位、写模型 / 推理强度 / 权限档）、49（`+ 2` 读所选 vendor / model / params） |
| 成员 | terms, schema（**数据身份 + 一个纯读 term**；无 execute、无 pins、无 eff） |
| 能力类·方法 | 无 |
| 命令 | `config.read`（纯 term，无参，返回整份 body） |
| schema | `schema/config.json`（单文件平铺 · JSON Schema 白名单子集） |
| 机制 | 见下「包契约 / 数据契约 / 读取契约 / 写入契约 / 并发语义 / 缺省与版本提升」 |
| 边界 | 不存明文密钥（只存 `auth_ref`）；不做用户体系；不做厂商 SDK 适配（预设归 #4–10）；不做联网取数（归 #12）；**不设字段级 CAS** |
| 验收 | 1) 读命令返回偏好；2) 各写者直写后立即生效且可回放；3) 主题三档 / 权限四档为枚举；4) 非法写在写入端按 schema 被拒（宿主 v1 不校验身份数据）；5) 并发写不同字段不互相覆盖（读-改-写 + 有界重试）；6) 首启默认 body 使 #15 能判「无配置」；7) `providers.<id>.models` 的元数据可被 #12 / #13 / #40 读到；8) 世界与审计中不出现明文密钥 |
| 状态 | 细节设计（2026-09-19，含 provider 注册表并入）。**版本提升：被提升方** —— #24 `secrets` 要求 `auth_ref.kind` 枚举 `env` → **`local` / `env`**（密钥本体住宿主侧用户本地文件，提出方见 `plugins/secrets/DESIGN.md`）；#38 `ui-notify` 要求新增 **`ui.notify`**（提出方见 `plugins/ui-notify/DESIGN.md`）；**#16 `ui-sidebar` 要求新增 `ui.sidebar_width`**（提出方 #16 / 被提升方本文件，2026-09-19）。**另注**：#17 `ui-settings` S8 显示密钥状态需 `secrets.list`（D10）——#17 须新增 `-> 24` pin；该页同时读本插件 `providers` 连接实例与所选模型 |

> 两层分工：**本插件 = 用户模型配置**（连接实例 + 模型目录 + 参数 + 选择）；**`#4–10 vendor-*` = 厂商适配**（`sdk` / `quirks` / 模板默认值）。本插件是数据身份，不参与路由（§1.2 第 6 条）。

## 包契约 `plugin.json`

```jsonc
{ "identity": "config",
  "schema": "schema/config.json",
  "implements": [], "methods": {}, "pins": {},
  "start": "",                       // 空 ≡ 无执行件（数据身份）
  "protocol": "1",
  "restart": {}, "health": {},       // 无服务；字段仍必须在
  "state": "recomputable",
  "members": [
    { "kind": "term",   "path": "terms/" },
    { "kind": "schema", "path": "schema/" }
  ],
  "commands": [
    { "name": "config.read", "entry": "terms/config.read.json" }   // 无参 ⇒ argsSchema 缺省（不设门）
  ] }
```

## 数据契约 `schema/config.json`

`providers` 采用 **models.dev 原形状**（provider -> models），但按本框架适配：

| models.dev | 本框架 | 原因 |
| --- | --- | --- |
| `options.apiKey` | `auth_ref = {kind:"local"\|"env", name}` | **明文密钥不进世界**（本体住宿主侧用户本地文件 / 进程环境，见 `#24 secrets`） |
| `options.baseURL` | `base_url` | 同义 |
| `npm: "@ai-sdk/…"` | 去掉：预设厂商改用 `#4–10` 的 `sdk`，自定义用本插件 `protocol` | 本框架不靠 npm 适配，协议映射归厂商适配插件 |
| `models.<id>.reasoning: true` | `reasoning: [档位…]` | 社区有档位用社区；仅布尔 `true` → 用该 `sdk` 的 `default_reasoning`（厂商适配声明）；无 → 缺键不显示 |

```json
{
  "title": "config（用户模型配置）",
  "description": "用户配置单一真源：连接实例 + 模型目录 + 参数 + 当前选择。缺键语义由写入端维护（宿主 v1 不校验身份数据）。",
  "type": "object",
  "required": ["version", "params", "permission", "ui", "providers"],
  "additionalProperties": true,
  "properties": {
    "version": { "type": "integer" },
    "vendor": { "type": "string", "description": "当前选择；**缺键 = 尚未完成首启配置**（#15 判「无配置」的判据）" },
    "model": { "type": "string", "description": "当前选择的模型 id；缺键 = 未选" },
    "params": {
      "type": "object",
      "properties": {
        "temperature": { "type": "number" },
        "reasoning": { "type": "string", "description": "所选模型的推理强度档位值；推理默认开启（无开关），该模型无档位时缺键（#12 用模型默认档）" },
        "max_tokens": { "type": "integer" }
      }
    },
    "permission": { "enum": ["auto", "severe", "review", "deny"], "description": "全局权限档（#40 输入框写）：fs 范围由 #25 sandbox 强制（auto 全过 / severe 工作区 RW / review 工作区只读 / deny 全拒）；「工作区外 / 危险操作弹卡」的升级由 #26 guard 判定（#25 只做 fs 强制）" },
    "ui": {
      "type": "object",
      "properties": {
        "theme": { "enum": ["day", "night", "system"] },
        "language": { "type": "string", "description": "缺键 = 跟随系统语言" },
        "style": { "type": "string", "description": "语言风格自由文本片段（#13 拼 messages 用）；随 config JSON 导入导出" },
        "sidebar_width": { "type": "integer", "minimum": 220, "maximum": 420 },
        "notify": { "type": "object", "additionalProperties": true,
          "description": "通知开关（#38 ui-notify 读）：{ approval_pending, run_finished, run_failed, model_error, disconnected, orchestration_change, plugin_write, orchestration_unhealthy, question_pending, only_when_unfocused }，缺键 = 默认 true；由 S7 通用页「通知」分组写" }
      }
    },
    "providers": {
      "type": "object",
      "description": "厂商连接实例 + 模型目录，键 = 厂商身份名（vendor-* 去前缀，如 deepseek / custom）。每个值形如：{ name, protocol?, base_url, auth_ref:{kind:'local'|'env',name}, models:{ <id>:{ name, context_window, max_output, reasoning:[档位…], modalities:{input:[],output:[]}, params:{}, enabled } } }；**protocol 仅自定义厂商**（三基础协议 openai-chat / openai-responses / anthropic-messages），预设厂商的 sdk 由 #4–10 提供；auth_ref 只存引用名、不存密钥本体（本体住宿主侧用户本地文件 / 进程环境，见 #24）；models 只收用户勾选的模型。形状校验归写入端（宿主 v1 不校验身份数据）",
      "additionalProperties": true
    }
  }
}
```

- 白名单子集**没有 `oneOf` / `$ref`，`type` 只能单值**（`docs/plugins.md` §二），故「可空」用**缺键**表达（与 #1 `conversation` 缺键 = 当前会话同规）。
- 白名单子集里 **`additionalProperties` 只能是布尔**，故 `providers` / `models` 的字典值形状写在 `description` 里，由**写入端**校验（宿主 v1 不校验身份数据）。
- `ui.theme` 枚举 `day | night | system` 是**用户语义**；落 DOM 由 #15 映射 `data-theme="light | dark"`（`system` 跟随 `prefers-color-scheme`），见 `docs/plans/ui-design.md` §12。

## 读取契约

- `config.read`：纯 term，无参，直出 `["g",["ids","config","body"]]`；**不触发 eff、不推进链**。
- **投影读**（不产生依赖边）：
  - `#12` 读 `providers.<vendor>.base_url` / `auth_ref` / `models.<model>`（连接与所选模型）；**预设厂商**的 `sdk` 从 `#4–10` 读，**自定义厂商**的 `protocol` 从 config 读；
  - `#13` 读 `providers.<vendor>.models.<model>.context_window` / `max_output`（裁剪预算）；
  - `#40` 读 `providers.<vendor>.models.<model>.reasoning`（推理档位选项）与当前 `model` / `params.reasoning` / `permission`。
- **命令读**：`#15` 判「无配置」（body 无 `vendor` 键）、`#40` 取当前选择。
- **导出**：`#17` 取 `config.read` 返回值另存 JSON——导出范围 = 整份 body（含 `providers`；`auth_ref` 只有引用名，无明文）。

## 写入契约（客户端经入站面 `submit`）

写者同路：**客户端身份** `put` 整值 + `add_gen`，不设专用写命令（`docs/plugins.md` §三 红线 2）。`#12` 的档案同步走**服务返回写计划**（服务无写通道）。

```jsonc
{ kind:'write', request:{ id, op:'batch', target:{ expect_pos: <head> }, args:{ ops:[
  { op:'put',     args:{ body: /* 整份 config body */ } },
  { op:'add_gen', args:{ id:'config', payload:{ $n:0 }, pins:{}, sig:{ $n:0 } } }
]}}}
```

- `put` 只造 def（无身份参数），身份绑定由 `add_gen` 的 `payload` 占位符 `{"$n":0}` 指回本批 `put`（口径同 #1）。
- `add_gen` 四字段全必填且 `payload` / `sig` 必须 64-hex；占位符只能指向本批内更早的 `put`。
- **写者与字段**：
  - `#17 ui-settings` 写 `providers` 连接实例 + 勾选模型 + 当前选择 + `params`（S1 引导 / S8 模型 / S7 通用）；
  - `#12 model-protocol` 拉 models.dev 后返回计划，只写 `providers.<vendor>.models.<id>` 的元数据（`context_window` / `max_output` / `reasoning` / `modalities`）；
  - `#15 ui-shell` 写 `ui.theme`；`#16 ui-sidebar` 写 `ui.sidebar_width`（防抖 300ms）；`#40 ui-composer` 写 `model` / `params.reasoning` / `permission`。

## 并发语义（本轮定案）

- config 是**整值寄存器**；内核只有单链 CAS（`expect_pos` 一个链头），**无字段级 CAS**（`docs/kernel.md` §十二）。
- **口径：读-改-写 + 有界重试**。每个写者：读当前 body -> 只改自己那一处 -> 整值 `put`（`expect_pos` = 链头）；CAS 失败则重读重试，上限 **3** 次；超限返回结构化错误，**不静默丢字段**。
- 不采用「后写覆盖」，也不新增 config 专用写者队列；**提交串行化由宿主的单一提交队列提供**（`host.md` §五 写者 / H12），各写者仍按读-改-写 + 有界重试提交。

## 缺省与版本提升

- **缺省（本轮定）**：seed 预置默认 body —— `version: 1` / 无 `vendor` / 无 `model` / `params` 取保守默认 / `permission: "review"`（偏安全）/ `ui.theme: "system"` / 无 `ui.language` / `ui.style: ""` / `ui.sidebar_width: 260` / `providers: {}`。**body 无 `vendor` 键**即 #15 判「无配置」、进 #17 S1 的判据。
- **版本提升登记**：`#16 ui-sidebar` 要求本插件升一代，新增 `ui.sidebar_width`（提出方 #16 / 被提升方本文件，双方各记一条；只加字段、不改调用方向）。
- **档位来源（本轮定）**：① 社区有显式档位数组 → 用社区；② 社区只有布尔 `true` → 用该 `sdk` / `protocol` 的 `default_reasoning`（厂商适配声明，**按 SDK 不按模型**，不逐模型维护）；③ 无 → 缺键，不显示档位控件（#12 仍默认开推理、用模型默认档）。
