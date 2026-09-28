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
候选汇集 → L1 TTL 过滤 → 结构化 → 去重 → 配对修复 → 预算建模 + token 计数 → 配额分配
→ 降级阶梯 → 前缀缓存排序 → 配对自检 → 方言格式化 → 分节明细 / 组装清单事件 → 75% 压缩提示 → 交错引导
```

- **候选来源**：本轮用户消息 / 系统提示 / 环境节 / 工具 schema / L2 / 上一会话 L1 / 本会话 L1 /
  技能 / L3 召回 / 历史 / 风格。
- **环境节**：`bag.workspace_root` 非空时，紧跟系统提示注入**一条**稳定 system 消息（工作目录 /
  操作系统 / 命令解释器），文案住 `policy.messages.environment`（占位 `{workspace_root}` / `{platform}`）。
  无工作目录不注入（不虚报根）；文案不含内部标识符，避免污染模型推理；与系统提示同属稳定前缀（`source='prompt'`，
  计入 `sections.system` 与 `sources.prompt`）。
- **去重**：规范化后完全一致只留最新；跨来源时历史是事实源，丢记忆副本（召回 / 摘要副本）。
- **跨回合工具回灌**：历史消息 `parts` 里的工具卡（`type:'tool'`）提升为 assistant `tool_calls`
  （调用逐字）+ 结果消息；结果按机械规则老化（资源身份 / 规模 / 截断尾部）并带可展开句柄。
  推理块跨回合默认丢弃。`extra_messages` 里 assistant 的 top-level `reasoning` 按厂商中立块回灌。
- **附件分层**：本轮附件（`source='input'`）按方言原样内联；历史附件在近期（T1）与陈旧（T2）
  层级统一折叠为「文本描述 + 句柄」（`aged` / `attachment` / `mime` / `sha256` / `handle`），
  不再每回合重复内联（图片重复计费与缓存失效的根因）。
- **大产物阈值**：结果字节数达到 `retention.large_artifact_bytes`（可被 `bag.thresholds.large_artifact_bytes`
  覆盖）时，无论层级都以「摘要 + 句柄」表示而非内联；`manifest.degraded` 记 `age_large_artifacts`。
- **配对不变量**：每个 `tool_call` 必须有配对结果；无结果（老化裁掉 / 中断）合成
  `{ok:false,error:'interrupted'}` 占位。`extra_messages` 与历史工具调用均为 atomic 组（调用 + 结果同进同出）。
- **预算** = `context_window - max_output - 余量`（余量比例住 policy）。只有 P0（系统提示 + 工具 schema）
  本身超窗才 `budget_impossible` 并指名过大元素；`budget ≤ 0` 返回 `budget_exceeded`。
- **预算来源可见**：`manifest.budget_origin` 为 `profile`（档案给出）或 `default`（档案缺失回落 policy
  默认）；缺失时另标 `profile_missing`，调用方可据此提示补档，不再静默按小窗口裁剪。
- **配额**：L2 / L1 分别按 `quota.l2` / `quota.l1` 截断；技能 / 召回 / 风格按配额截断；
  未用额度下滚给历史（新 → 旧，atomic 组整组进出）。
- **降级阶梯**：超预算按序降级而非失败：老化工具结果 → 丢推理 → 压缩（当前装配侧不可用，登记跳过）
  → 丢检查点之外的老回合 → 截断本轮输入首尾（显式标记）。`manifest.degraded` 记录实际生效的梯级。
- **前缀缓存排序**：稳定前缀 = 系统提示 → 工具 schema → L2（工作区记忆）；其后历史 → L1 → 技能 → 召回 → 风格；
  本轮输入在最后。工具按名排序、JSON 键序稳定，前缀里不含时间戳 / token 计数 / 当前时间。
- **缓存提示（`value.cache`）**：稳定前缀非空时产出厂商中立提示 `{system?, tools?, key}`——`key` 是静态前缀的
  稳定哈希（供 `prompt_cache_key`），`system` / `tools` 标记可缓存段，`breakpoints` 只标前缀内非 system 角色消息下标。
  前缀为空时不产出；系统角色消息含前缀外易变切片（如 L1）时不标 `system`，避免把易变内容标进缓存。纯 bag 函数、逐字节确定。
- **超大用户粘贴例外**：用户消息逐层逐字（意图的基准事实，不压），唯一例外是超大粘贴——全文仍由 session 保存，
  上下文投影只给首尾 + 可还原句柄 + 显式标记（`{aged:true,kind:'user_paste',handle,omitted_chars,head,tail}`）。
  阈值住 `retention.oversized_user_chars`，可被 `bag.thresholds.oversized_user_chars` 覆盖；0 = 关闭。
- **系统错误分层（`meta.error`）**：T0 逐字（模型需要知道失败了）、T1 一行、T2+ 蒸馏进检查点 `errors_to_avoid`；
  无检查点时 T2 回落一行。配对不变量不受影响。
- **方言格式化**：`openai-chat` / `openai-responses` / `anthropic-messages`；多模态按模型
  `modalities.input` 编 content parts，不支持该模态时降级为文本引用并标 `modality_dropped`。
- **token 校准**：真实 `prompt_tokens`（随 `bag.usage` 传入）用于维护每模型校正系数；校正状态落
  `CHRONO_PLUGIN_STATE/calibration.json`（③ 可重算）。快路径计数（含老化 / 压缩 / 截断等改写路径）按系数缩放；
  无 `bag.usage` 时只累积估算、系数保持 1。
- **分节明细**：`manifest.sections` 给出 `{system, tools, rules, l2, checkpoint, history_text,
  tool_calls, tool_results, reasoning, input, hints}` 的逐节 token。
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
  "cache": { "system": true, "tools": true, "key": "ctx-…" },
  "manifest": { /* 同 context.assembled 事件载荷 */ } }

// 结构化错误（非崩溃，由上层按策略处理）
{ "ok": false, "code": "budget_impossible" | "budget_exceeded" | "pairing_violation", "message": "…",
  "budget": 0, "used": 0, "manifest": { /* … */ } }
```

## bag 字段契约

服务不读投影；调用方入口 term 读 `ctx` 后把下列键装进 bag（缺键即视为无该来源）：

| 键 | 形状 | 说明 |
| --- | --- | --- |
| `input` | `string \| { content?, parts?, attachments?, at? }` | 本轮用户消息；可解析附件 `text` 内联，二进制只留资产引用 |
| `system_prompt` | `string` | 系统提示（稳定前缀） |
| `workspace_root` | `string` | 执行根：非空时注入环境节（工作目录 / 平台 / 命令解释器）；缺失不注入 |
| `tools` | `[{ name, description?, schema? }]` | 工具 schema（稳定前缀；每工具一条） |
| `memories` | `{ l2?, prev_l1?, l1? }` | 记忆切片；条目 = `{ summary, covered_upto?, expires_at?, at? }` |
| `skills` | `[{ name?, id?, content? }]` | 技能片段 |
| `recall` | `[{ entry?, id?, content?, score? }]` | L3 召回（按 `score` 降序截断） |
| `session` | `{ head?, refs? }` | 历史候选：`refs` = `{ <def 哈希>: <消息体> }`，沿 `prev` 还原链 |
| `style` | `string \| { text? }` | 风格片段 |
| `extra_messages` | `[{ role?, content?, tool_call_id?, tool_calls?, reasoning? }]` | 同回合 iter 间产物（assistant 承接帧 / 工具结果 / verify 报告 / 提问答案）；追加到消息尾部（source=`tool`，排在本轮输入之后；按历史额度可裁）。`tool_calls` 为中性形状，由协议层编形；`reasoning` 为厂商中立块，原样上提 |
| `thresholds` | `{ large_artifact_bytes?: number, oversized_user_chars?: number }` | 可选阈值覆盖（扁平 map，由 loop-policy 随 bag 下传解析后的整份 thresholds）；`large_artifact_bytes` 非正数缺省时用本包 policy 默认，`oversized_user_chars` 允许 0（关闭例外） |
| `usage` | `{ prompt_tokens?, cached_tokens?, cache_read_input_tokens?, prompt_cache_hit_tokens?, cache_creation_input_tokens?, completion_tokens?, … }` | 上一次模型调用的真实用量；用于校准 token 估算（缺省不校准） |
| `config` | `{ model?, context_window?, max_output?, sdk?, protocol?, quirks?, modalities? }` | 模型档案与厂商方言 |
| `thread_kind` | `main \| subagent \| group \| workflow` | 线程口径（缺省 `main`） |
| `parent_checkpoint` | `checkpoint` 步记录（`{ summary, … }`）或裸 `summary` | subagent：父检查点；仅结构化检查点注入，优先于 `parent_summaries` |
| `parent_summaries` | `[{ summary, … }]` | subagent：父会话摘要（无 `parent_checkpoint` 时的回落） |
| `task_prompt` | `string` | subagent：父 agent 任务提示词 |
| `inbox_unread` | `[{ kind?, body?, from?, at? }]` | subagent：本线程未读消息 |
| `persona` / `topic` | `string` | group：本轮发言者人格 / 圆桌议题 |

**线程口径**：`main` 全切片；`subagent` 去掉「上一会话 L1」并**不组装父消息历史**，上下文 = 任务
（`task_prompt`）+ 父检查点（`parent_checkpoint`，无则回落 `parent_summaries`）+ `inbox_unread`；
`group` 用群聊 transcript（带发言者名）替换历史切片，并加人格与议题；
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
75% 阈值、缓存前缀边界、降级阶梯文案（输入截断标记）、环境节模板、压缩提示与交错引导文案、多模态降级模板，
以及宿主消费的 `method_timeouts`（`context.build` 覆盖 30s 缺省）。服务**启动时读取**，
`reload` 帧（数据换代）时重读——热改 = 数据换代 reload，不改代码。

## 测试

```bash
npm test          # TS 协议级 + 单元测试（node --test）
npm run test:rust # Rust 估算器规格向量（cargo test）
node tools/e2e-smoke.mjs   # 宿主装配 E2E（物化 + cargo build + 服务启动 + 协议直连 build）
```

协议与服务帧口径见 `docs/protocol.md`；插件契约见 `docs/plugins.md`。
