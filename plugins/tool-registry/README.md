# tool-registry（工具目录装配）

工具目录装配与 argsSchema 方言校验提供方：把各工具提供者的声明并集装配为**工具目录**，
并按同一白名单方言校验模型传入的 args。被 `tool-dispatch` 与图解释器经反向 `port.call` 消费；
自身消费各工具提供者的 `describe`。

- 身份：`tool-registry`
- 能力类 / 方法：`tool-registry` → `list` / `validate-args`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`tool-registry.json`）
- `pins`：无声明（`"pins": {}`）；目录覆盖的 describe 提供者类与绑定提供者类走 `needs.one` 注入有效 pins
- 状态档：`recomputable`（无本地持久状态）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 运行时零 npm 依赖

## `list(bag) -> 目录`

目录 = `pins` 里 describe/invoke 提供者各自的 `describe` 并集 + `bag.tools_bindings` 绑定表

- `bag.mcp_tools`（外部 MCP 工具）。

* 调用方已给出 `bag.directory` / `bag.tools` → 直接复用、不再拉 `describe`、不再重复校验。
* 逐项校验：四要素缺一 / `argsSchema` 含白名单外关键词 / `param_semantics` 未覆盖必填参数 /
  `caps` 形状非法 → **`bad_tool_decl`**（该项不进目录、不派发），并在 `rejected` 里留诊断。
* **外部 MCP 工具例外**：四要素由 MCP description 兜底、缺项不拒；`argsSchema` 净化到白名单子集。
* **工具名全局唯一**：重名后者被拒。
* 返回 `{tools:[声明], rejected:[{name,code,message}]}`；`description` 由四要素机械拼装：
  `description`（提供者直给的短摘要）作首行，其后拼 `使用时机：` / `边界：`；`param_semantics` 是参数文案的
  **唯一来源**，逐项并入 `argsSchema` 对应属性的 `description`；仅当某键在 `argsSchema` 无对应属性时
  才回落到 description 的 `参数：` 行。
* **注入参数（`hidden_params`）**：声明里列出的参数由调用方在派发前填好、模型不该也不能填。list 时把这些属性
  从**模型可见** `argsSchema` 摘掉（`required` 同摘），并保留完整 schema 到 `validateSchema` 供派发校验。

## `validate-args({schema, value}) -> {ok, message}`

按白名单方言（JSON Schema 子集）机械校验模型传入的 args；语义校验归各工具提供者。
失败回可读原因，不抛异常。

## 依赖与背压

- argsSchema 白名单校验 / 净化与 caps 形状校验是住同包 `execute/schema-validate.ts` 的**纯函数**，
  不再跨插件反向调用。
- describe/invoke / 绑定提供者类（`one`，逐个）：describe 并集与绑定 class 归属判定。

## 服务纪律

服务不读投影（绑定表 / MCP 清单 / 执行根由调用方随 bag 传入）、不取时间 / 随机、同输入同输出；
不落账、无写通道；跨插件只走反向帧 `port.call`。

## 运行

```sh
npm test    # 协议级 + 逻辑级测试（node --test）
```

## `.worldignore`

声明 `test/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
