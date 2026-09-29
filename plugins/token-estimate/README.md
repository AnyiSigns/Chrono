# token-estimate（token 估算提供方）

按 v1 估算器规格把文本映射为 token 估算数：`count`（批量：`texts[] → counts[]`）与 `version`（规格版本）。
确定、同输入同输出、不取时间 / 随机。被上层 `context-window` 经反向 `port.call` 消费（每轮装配只发一次批量
`count`）；自身无反向调用、不读投影、不写世界。

- 身份：`token-estimate`
- 能力类 / 方法：`token-estimate` → `count` / `version`
- 命令：无（由消费方按能力类反向调用，不暴露命令面）
- 成员：`execute`（TS 服务）、`native/tokenizer`（napi 原生扩展，唯一计数实现）、`schema`
- `pins`：无（`"pins": {}`；无宿主 / 跨身份依赖）
- 状态档：`recomputable`（无本地持久状态）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`token-estimate.count`
- 运行时零 npm 依赖

## 方法

| 方法      | 入参      | 返回        | 行为                                            |
| --------- | --------- | ----------- | ----------------------------------------------- |
| `count`   | `{texts}` | `{counts}`  | 批量按 v1 规格计数，返回与 `texts` 同序同长数组 |
| `version` | `{}`      | `{version}` | 估算器规格版本（接缝替换真 tokenizer 时变更）   |

## v1 估算器规格

写死、同输入同输出：

- CJK 码点：每码点 1 token；
- ASCII 词（`[A-Za-z0-9_]` 的极大连续段）：每段 1 token；
- 空白（含非 ASCII 空白）：分隔符，0 token；
- 其余码点（ASCII 标点 / 符号 + 非 ASCII 非 CJK 字符）：每 4 码点 1 token（不足 4 向上取整）。

唯一实现在 `native/tokenizer`（Rust cdylib + 手写 napi binding）；TS 侧按平台产物名定位并复制为
`tokenizer.<pid>.node` 后 `require`。原生缺失 / 加载失败 ⇒ 服务在 hello 前退出非 0（宿主隔离），
**绝不回落 JS 计数**（两份实现必然漂移，破坏「预算 / 阈值 / 同输入同输出」）。

## 结果

- 成功：`{counts}`（同序同长，非负整数）。
- 失败：结构化 `bad_args`（`texts` 缺失 / 非数组 / 含非字符串项）。

## 边界

- 不做：token 预算建模与配额（归 `budget`）/ 消息级调配（归 `context-window`）。
- 不写世界、不读投影、无命令面。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test          # 协议级 + 纯函数级测试（node --test；自动构建本地原生库）
npm run test:rust # 原生估算器规格向量（cargo test）
```

## `.worldignore`

`node_modules/` / `target/` / `*.node` / `test/` / `tools/` 不入世界；
`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` / `native/tokenizer/src` /
`Cargo.toml` / `Cargo.lock` 随源码入世。
