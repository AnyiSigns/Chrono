# context-window（上下文调配器）

插件化 agent 运行时的**上下文调配器**：在召回写 bag 之后、调模型之前，把候选上下文组装成
一次模型调用可用的消息列。它是**只读派生视图**——组装结果只决定发给模型的内容，
永不回写会话、永不删消息。

- 身份：`context-window`
- 能力类 / 方法：`context` → `build`
- 命令：无
- 成员：`execute`（TS 服务）、`native`（Rust tokenizer 子组件）、`schema`（`policy.json`）
- 状态档：`recomputable`（③ 可重算；无本地持久状态）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧）
- pins：无（一切输入随 bag 由调用方入口 term 装配传入；服务不读投影）

## 组装流水线

```
候选汇集 → L1 TTL 过滤 → 结构化 → 去重 → 预算建模 + token 计数 → 配额分配 → 裁剪
→ 冲突消解 → 前缀缓存排序 → 方言格式化 → 组装清单事件 → 75% 压缩提示 → 交错引导
```

- **候选来源**：本轮用户消息 / 系统提示 / 工具 schema / L2 / 上一会话 L1 / 本会话 L1 /
  技能 / L3 召回 / 历史 / 风格。
- **去重**：规范化后完全一致只留最新；跨来源时历史是事实源，丢记忆副本（召回 / 摘要副本）。
- **预算** = `context_window - max_output - 余量`（余量比例住 policy）。P0（系统提示 + 工具 schema +
  本轮用户消息）不裁；`P0 + P1 > budget` 返回结构化 `budget_impossible`；`budget ≤ 0` 返回 `budget_exceeded`。
- **配额**：P1 记忆保底，P2 技能 / P3 召回 / P5 风格按配额截断，未用额度下滚给 P4 历史（新 → 旧，
  atomic 组整组进出）。
- **前缀缓存排序**：稳定前缀 = 系统提示 → 工具 schema；其后 L2 → L1 → 技能 → 召回 → 历史 → 风格；
  本轮输入在最后。
- **方言格式化**：`openai-chat` / `openai-responses` / `anthropic-messages`；多模态按模型
  `modalities.input` 编 content parts，不支持该模态时降级为文本引用并标 `modality_dropped`。
- **组装清单**：每次组装发一条 `context.assembled` 事件（经宿主透传，不落账、不进世界）；
  `run` / `thread` 取自协议帧 `env`。
- **75% 触发**：`used ≥ budget × 75%` 时追加**一条** system 压缩提示（文案住 policy）。
- **交错引导**：本轮含工具结果时追加**一条** system 引导语（说意图、禁工具标识符；文案住 policy）。

## 返回值

```jsonc
// 成功
{ "ok": true,
  "messages": [ /* 方言化 content parts 列表 */ ],
  "params": { "model": "…", "max_output": 4096, "max_tokens_field": "max_tokens" },
  "manifest": { /* 同 context.assembled 事件载荷 */ } }

// 结构化错误（非崩溃，由上层按策略处理）
{ "ok": false, "code": "budget_impossible" | "budget_exceeded", "message": "…",
  "budget": 0, "used": 0, "manifest": { /* … */ } }
```

## bag 字段契约

服务不读投影；调用方入口 term 读 `ctx` 后把下列键装进 bag（缺键即视为无该来源）：

| 键 | 形状 | 说明 |
| --- | --- | --- |
| `input` | `string \| { content?, parts?, attachments?, at? }` | 本轮用户消息；可解析附件 `text` 内联，二进制只留资产引用 |
| `system_prompt` | `string` | 系统提示（稳定前缀） |
| `tools` | `[{ name, description?, schema? }]` | 工具 schema（稳定前缀；每工具一条） |
| `memories` | `{ l2?, prev_l1?, l1? }` | 记忆切片；条目 = `{ summary, covered_upto?, expires_at?, at?, subject? }` |
| `skills` | `[{ name?, id?, content? }]` | 技能片段 |
| `recall` | `[{ entry?, id?, content?, score? }]` | L3 召回（按 `score` 降序截断） |
| `session` | `{ head?, refs? }` | 历史候选：`refs` = `{ <def 哈希>: <消息体> }`，沿 `prev` 还原链 |
| `style` | `string \| { text? }` | 风格片段 |
| `config` | `{ model?, context_window?, max_output?, sdk?, protocol?, quirks?, modalities? }` | 模型档案与厂商方言 |
| `thread_kind` | `main \| subagent \| group \| workflow` | 线程口径（缺省 `main`） |
| `parent_summaries` | `[{ summary, … }]` | subagent：父会话摘要 |
| `task_prompt` | `string` | subagent：父 agent 任务提示词 |
| `inbox_unread` | `[{ kind?, body?, from?, at? }]` | subagent：本线程未读消息 |
| `persona` / `topic` | `string` | group：本轮发言者人格 / 圆桌议题 |

**线程口径**：`main` 全切片；`subagent` 去掉「上一会话 L1」，加 `parent_summaries` + `task_prompt` +
`inbox_unread`，不继承父消息历史；`group` 用群聊 transcript（带发言者名）替换历史切片，并加人格与议题；
`workflow` 不组装消息历史。

`covered_upto` 是组装边界：只注入它**之后**的消息；对不上历史（失效）则丢弃该 L1 并标 `l1_invalid`。
`expires_at ≤ env.now` 的条目读侧过滤、不注入：**L1 标 `l1_expired`、L2 标 `l2_expired`**（按来源区分，不复用）。

## 协议与内存口径（写死）

- **坏帧即退出**：解码器遇坏 JSON / 超长帧（协议损坏）时记 stderr 并 `exit(1)`——与原生服务同口径，
  让宿主 fail-closed 隔离该服务；不在坏缓冲区上反复抛错。
- **缓存有界**：token 计数缓存与规范化缓存按 LRU 近似（Map 插入序）设上限 `CACHE_MAX_ENTRIES`，
  超限淘汰最久未用条目，防长驻服务内存随会话单调增长。

## 原生 tokenizer 子组件

- **单一实现（写死）**：token 计数只有 Rust 一份（`native/tokenizer/`，napi 原生扩展）。
  native 缺失 / 加载失败 ⇒ 服务在 hello 前退出非 0（宿主隔离），**绝不回落 JS 计数**——两份实现会漂移。
- **v1 估算器（确定、同输入同输出）**：ASCII 词 ≈ 1 token、CJK 每码点 ≈ 1 token、
  其余码点每 4 个 ≈ 1 token。规格在 Rust 里实现，是后续替换真 tokenizer 的接缝。
- **物化与加载**：包根 `Cargo.toml` 是 workspace（members 含 `native/tokenizer`）；宿主物化时跑
  `cargo build --release`，产物落 `<root>/state/deps/cargo-target/release/tokenizer.dll`（类 Unix 为
  `libtokenizer.so`）。服务启动时按 `CHRONO_PLUGIN_STATE` 上溯定位该产物（回落包内 `target/release/`），
  复制为 `.node` 后进程内 `require`。
- `node_modules/`、`target/`、`*.node` 由 `.worldignore` 排除，走宿主侧依赖缓存（③）。

## schema / policy

`schema/policy.json` 是身份的声明文件，也是组装策略数据：预算余量、各类配额、优先级、
75% 阈值、缓存前缀边界、压缩提示与交错引导文案、多模态降级模板。服务**启动时读取**，
`reload` 帧（数据换代）时重读——热改 = 数据换代 reload，不改代码。

## 测试

```bash
npm test          # TS 协议级 + 单元测试（node --test）
npm run test:rust # Rust 估算器规格向量（cargo test）
node tools/e2e-smoke.mjs   # 宿主装配 E2E（物化 + cargo build + 服务启动 + 协议直连 build）
```

协议与服务帧口径见 `docs/protocol.md`；插件契约见 `docs/plugins.md`。
