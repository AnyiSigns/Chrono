# context-window（上下文调配器）

插件化 agent 运行时的**上下文调配器**：在召回写 bag 之后、调模型之前，把候选上下文组装成
一次模型调用可用的消息列。它是**只读派生视图**——组装结果只决定发给模型的内容，
永不回写会话、永不删消息。

- 身份：`context-window`
- 能力类 / 方法：`context` → `build`
- 命令：无
- 成员：`execute`（TS 服务）、`schema`（`policy.json`）
- 状态档：`recomputable`（③ 可重算；无本地持久状态）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧）
- pins：无（一切输入随 bag 由调用方入口 term 装配传入；服务不读投影）
- `needs`：`token-estimate`（one）、`budget`（one）——token 计数与预算建模经反向 `port.call` 取数

## 组装流水线

```
候选汇集 → L1 TTL 过滤 → 结构化 → 去重 → 配对修复 → 预算建模（budget）+ 批量 token 计数（token-estimate）
→ 配额分配 → 降级阶梯 → 前缀缓存排序 → 配对自检 → 方言格式化 → 分节明细 / 组装清单事件 → 交错引导
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
- **预算** = `context_window - max_output - 余量`（余量比例住 policy），建模由 `budget.model` 提供方算得，
  本插件把生效 policy 数值随调用下传（单一真源在本插件）；返回的每来源配额上限供配额分配使用。
  只有 P0（系统提示 + 工具 schema）本身超窗才 `budget_impossible` 并指名过大元素；`budget ≤ 0` 返回 `budget_exceeded`。
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
  无检查点时 T2 回落一行。配对不变量不受影响。**口径说明**：上下文投影（步日志）不产 `meta.error`——协议级
  错误以 `step.result.tool_results` 的 `ok:false` 逐字回灌（本轮 T0 / 历史按工具结果老化）；本节分层保留给
  自身携带 `meta.error` 的记录（旧式 / 合成），非步日志投影产物。
- **方言格式化**：`openai-chat` / `openai-responses` / `anthropic-messages`；多模态按模型
  `modalities.input` 编 content parts，不支持该模态时降级为文本引用并标 `modality_dropped`。
  被支持的二进制附件只产出**资产占位符**（`asset:<sha256>` URL / `{type:'asset',sha256,mime}` 源）——
  字节由 `model-protocol` 发请求前经 `host.asset.get` 内联（本插件保持纯投影、不触字节）。
- **token 校准**：真实 `prompt_tokens`（随 `bag.usage` 传入）经 `budget.observe` 维护每模型校正系数；
  系数状态落 `budget` 身份的 `CHRONO_PLUGIN_STATE/calibration.json`（③ 可重算）。快路径计数（含老化 / 压缩 /
  截断等改写路径）按系数缩放；无 `bag.usage` 时只累积估算、系数保持 1。
- **分节明细**：`manifest.sections` 给出 `{system, tools, rules, l2, checkpoint, history_text,
tool_calls, tool_results, reasoning, input, hints}` 的逐节 token。
- **组装清单**：每次组装发一条 `context.assembled` 事件（经宿主透传，不落账、不进世界）；
  `run` / `thread` 取自协议帧 `env`。
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

| 键                  | 形状                                                                                                                                          | 说明                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`             | `string \| { content?, parts?, attachments?, at? }`                                                                                           | 本轮用户消息；可解析附件 `text` 内联，二进制只留资产引用                                                                                                                      |
| `system_prompt`     | `string`                                                                                                                                      | 系统提示（稳定前缀）                                                                                                                                                          |
| `workspace_root`    | `string`                                                                                                                                      | 执行根：非空时注入环境节（工作目录 / 平台 / 命令解释器）；缺失不注入                                                                                                          |
| `tools`             | `[{ name, description?, schema? }]`                                                                                                           | 工具 schema（稳定前缀；每工具一条）                                                                                                                                           |
| `memories`          | `{ l2?, prev_l1?, l1? }`                                                                                                                      | 记忆切片；条目 = `{ summary, covered_upto?, expires_at?, at? }`                                                                                                               |
| `skills`            | `[{ name?, id?, content? }]`                                                                                                                  | 技能片段                                                                                                                                                                      |
| `recall`            | `[{ entry?, id?, content?, score? }]`                                                                                                         | L3 召回（按 `score` 降序截断）                                                                                                                                                |
| `session`           | `{ turns?, head?, refs? }`                                                                                                                    | 历史真源：`turns[].steps`（回合步日志，模型形状）；`refs` / `head` 不再用于还原历史                                                                                           |
| `turn_id`           | `string`                                                                                                                                      | 本轮回合身份：本轮用户消息不投影（`input` 权威），本轮其余记录标 `source='tool'`（排 input 之后、保留恒 T0）；缺失时不猜测，全部按历史投影                                    |
| `style`             | `string \| { text? }`                                                                                                                         | 风格片段                                                                                                                                                                      |
| `extra_messages`    | `[…]`                                                                                                                                         | **已忽略**（同回合进度改由 `session.turns[].steps` 投影派生）；保留键仅为兼容生产者，可下线                                                                                   |
| `thresholds`        | `{ large_artifact_bytes?: number, oversized_user_chars?: number }`                                                                            | 可选阈值覆盖（扁平 map，由 loop-policy 随 bag 下传解析后的整份 thresholds）；`large_artifact_bytes` 非正数缺省时用本包 policy 默认，`oversized_user_chars` 允许 0（关闭例外） |
| `usage`             | `{ prompt_tokens?, cached_tokens?, cache_read_input_tokens?, prompt_cache_hit_tokens?, cache_creation_input_tokens?, completion_tokens?, … }` | 上一次模型调用的真实用量；用于校准 token 估算（缺省不校准）                                                                                                                   |
| `config`            | `{ model?, context_window?, max_output?, sdk?, protocol?, quirks?, modalities? }`                                                             | 模型档案与厂商方言                                                                                                                                                            |
| `thread_kind`       | `main \| subagent \| group \| workflow`                                                                                                       | 线程口径（缺省 `main`）                                                                                                                                                       |
| `parent_checkpoint` | `checkpoint` 步记录（`{ summary, … }`）或裸 `summary`                                                                                         | subagent：父检查点；仅结构化检查点注入，优先于 `parent_summaries`                                                                                                             |
| `parent_summaries`  | `[{ summary, … }]`                                                                                                                            | subagent：父会话摘要（无 `parent_checkpoint` 时的回落）                                                                                                                       |
| `task_prompt`       | `string`                                                                                                                                      | subagent：父 agent 任务提示词                                                                                                                                                 |
| `inbox_unread`      | `[{ seq?, kind?, body?, from?, at? }]`                                                                                                        | 本线程未读收件箱（**所有线程口径**）：按数组声明序（调用方按 `seq` 升序）逐条注入，`[收件箱 kind · 来自 from]\nbody`                                                          |
| `persona` / `topic` | `string`                                                                                                                                      | group：本轮发言者人格 / 圆桌议题                                                                                                                                              |

**线程口径**：`main` 全切片；`subagent` 去掉「上一会话 L1」并**不组装父消息历史**，上下文 = 任务
（`task_prompt`）+ 父检查点（`parent_checkpoint`，无则回落 `parent_summaries`）+ `inbox_unread`；
`group` 用群聊 transcript（带发言者名）替换历史切片，并加人格与议题；
`workflow` 不组装消息历史。
`inbox_unread` 不过滤线程：四个线程口径都按同一形状注入（子代理模型调用绕开本服务时由 loop-policy 自行渲染同形消息）。

`covered_upto` 是组装边界：只注入它**之后**的消息；对不上历史（失效）则丢弃该 L1 并标 `l1_invalid`。
`expires_at ≤ env.now` 的条目读侧过滤、不注入：**L1 标 `l1_expired`、L2 标 `l2_expired`**（按来源区分，不复用）。

## 协议与内存口径（写死）

- **坏帧即退出**：解码器遇坏 JSON / 超长帧（协议损坏）时记 stderr 并 `exit(1)`——与原生服务同口径，
  让宿主 fail-closed 隔离该服务；不在坏缓冲区上反复抛错。
- **缓存有界**：token 计数缓存与规范化缓存按 LRU 近似（Map 插入序）设上限 `CACHE_MAX_ENTRIES`，
  超限淘汰最久未用条目，防长驻服务内存随会话单调增长。

## 反向调用（`needs`）

token 计数与预算建模已下沉为提供方，本插件只编排与传数：

- `token-estimate.count`（批量 `texts[] → counts[]`）：装配按「发现 → 批量补齐」迭代——同步跑一遍装配，
  收集本轮未命中的文本，**一次**批量 `count` 补齐缓存，直到某遍零未命中即为确定结果。热路径一轮装配只发一次
  批量调用，**绝不逐条远程调用**；`text.ts` 的 `def 键 → tokens` 与文本级 LRU 缓存跨装配复用，同文本不重复计数。
  截断降级路径在固定字符网格上取齐候选计数（仍是单次批量），候选计数单调，越限即停。
- `budget.model` / `budget.factor` / `budget.observe`：预算建模、每模型系数、以真实用量更新 EWMA。
- 反向调用等待上限严格大于提供方声明（多一跳严格嵌套超时），且小于 `context.build` 的 120s。
- 提供方缺失 / 出错时反向调用作结构化错误返回；隔离与热跟随由宿主按能力槽完成。

## schema / policy

`schema/policy.json` 是身份的声明文件，也是组装策略数据：预算余量、各类配额、优先级、
缓存前缀边界、降级阶梯文案（输入截断标记）、环境节模板、交错引导文案、多模态降级模板，
以及宿主消费的 `method_timeouts`（`context.build` 覆盖 30s 缺省）。服务**启动时读取**，
`reload` 帧（数据换代）时重读——热改 = 数据换代 reload，不改代码。

## 测试

```bash
npm test   # TS 协议级 + 单元测试（node --test；协议测试以假后端应答反向调用）
```

token 计数与预算建模的真实行为由 `token-estimate` / `budget` 各自插件测试覆盖；本插件测试只覆盖
「消费方编排 + 端口契约形状」。宿主装配 E2E 见 `tools/e2e-smoke.mjs`（不入本包测试）。

协议与服务帧口径见 `docs/protocol.md`；插件契约见 `docs/plugins.md`。
