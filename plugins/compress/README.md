# compress（压缩引擎：摘要 / 上下文压缩 / 抽取）

压缩引擎（上下文与记忆共用）：`summarize`（会话摘要 → L1）/ `compact`（上下文压缩，达阈触发）/
`extract`（从压缩产物抽 2–3 条 → L2）。`mode` 可纯算法（确定、零 token）或语义（反向调模型服务）。

- 身份：`compress`
- 能力类 / 方法：`compress` → `summarize` / `compact` / `extract`
- 命令：无（无入口 term，省略 `terms/`）
- 成员：`execute`（TS 服务）、`schema`（`compress.json`）
- `pins`：`model` → `model-protocol`（semantic 模式调 `model.chat`）、`embedding` → `embedding`（去重向量化，调 `embedding.embed`）
- 状态档：`recomputable`（无本地持久状态；模型调用不重放、永不缓存）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`compress.summarize`（宿主健康判定走协议级 `probe` / `pong`，本字段仅服务自述）

## 边界

- **只回写计划，不直接写链**：`{$directives:[batch(write put + add_gen), extern(result)]}`。
- **不读投影**：读-改-写所需的 short-memory 整份 body 与 `session_slice`（会话切片）由调用方随 `args` 传入；
  写回合并后的整份 body（不得盲写抹掉其他会话 / 工作区）。
- 不做：检索 / 去重合并与固化 / 向量计算（归各自服务）/ 触发判定（阈值归上下文调配器、准则归编排策略数据）。
- **不删会话消息**：压缩只写短期记忆身份，展示历史独立留存。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 三种压缩

| 方法 | 输入 | 产出 | 写入 |
| --- | --- | --- | --- |
| `summarize` | 结构化摘要字段（agent 工具 args 直带）或 `session_slice` 派生 + 现有 L1 | 结构化摘要（goal / decisions / facts / open_questions / files / next_steps） | L1（`sessions[C]`，更新 `covered_upto` / `expires_at`） |
| `compact` | 同 `summarize`，另需工作区 id | 压缩后的摘要（同 L1 结构） | L1（同 `summarize`）**并触发 `extract`** 写 L2 |
| `extract` | 压缩产物（`summary` 或扁平字段） | 2–3 条高价值项 | L2（`workspaces[W].summary.facts`，去重合并） |

- **`covered_upto` 来源**：由调用方入口 term 从会话投影（链头 / prev 链）算出、随 `args.covered_upto` 传入；
  缺省保留现有值。`expires_at = at + 24h`，`at` 取自调用帧 `env.now`（服务不自取时钟）。
- **结构化产出（不解析自由文本）**：agent 被提示压缩后经记忆工具调用本插件，工具 args 直接带结构化字段；
  `semantic` 模式也返回同结构（由模型服务出 JSON，本插件解析）。
- **`mode`**：`algorithmic`（结构化字段优先、缺失字段由切片按句派生，完全确定、零 token）/
  `semantic`（反向调 `model.chat`，需调用方随 `args.model_config` 传入连接实例；模型调用不重放）。
- **去重**：新条目与现有条目比对（文本 + 向量余弦；向量经反向调用向量化服务取得）。
  向量后端缺失或调用失败时回落**精确文本去重**（去重是尽力而为，权威重去重归记忆维护服务）。
  `dedup` 字段语义：`"vector"` 表示本次去重中**至少有一次**判定实际走了向量余弦
  （列表字段逐字段判定，`compact` 再合并 L1 / L2 两次）；仅当所有判定都回落精确文本时才为 `"text"`。
- **写计划形状**：`put(合并后的 short-memory body)` + `add_gen(id:"short-memory")`，包在一条原子 `batch` 里。

## 入参（`args` / bag）

```jsonc
{
  "memory": { /* short-memory 身份整份 body（读-改-写基准，必填） */ },
  "conversation": "c-1",           // L1 会话 id（summarize / compact 必填）
  "workspace": "w-1",              // L2 工作区 id（compact / extract 必填）
  "covered_upto": "msg-...",       // 已压缩边界（调用方从会话投影算出）
  "session_slice": [{ "role": "user", "content": "…" }],
  "mode": "algorithmic",           // algorithmic | semantic
  "goal": "…",                     // 结构化摘要字段（工具 args 直带）
  "decisions": [], "facts": [], "open_questions": [], "files": [], "next_steps": [],
  "summary": { /* extract 亦可直接给压缩产物 */ },
  "target_length": 280,            // 目标长度（码点）：一致作用于 goal 与各列表字段（无论来源）
  "dedup_threshold": 0.9,          // 去重阈值（余弦）
  "extract_items": 3,              // 抽取条数：任意 ≥1 整数，钳制到 2..3
  "embedding_model": "granite-97m",
  "model_config": { /* semantic 模式：连接实例，原样透传给 model.chat */ }
}
```

- 形态非法 → 结构化 `bad_args`（不跑方法、不落账）。
- `extract` 候选不足 2 条 → 结构化错误 `insufficient_content`；候选全为已有条目的重复 →
  只回 `extern`（`reason:"all_duplicate"`），不产空写计划。

## 结果

- 成功：`{$directives:[…]}`，其中 `extern.payload` 含 `{ok:true, kind, items?, summary?, dedup, …}`。
- 失败（作数据，不炸本轮）：`{ok:false, error:{code, message}}`。错误码：
  `model_config_required` / `model_unavailable` / `semantic_empty` / `semantic_parse_failed` /
  `insufficient_content` / `model_call_failed`（模型回包非对象）；
  其余为**模型服务原码透传**——模型协议词表（`model_auth_failed` / `model_rate_limited` / `model_bad_request` /
  `model_server_error` / `model_timeout` / `model_stream_broken` / `model_network_error` / `model_unsupported`）
  以及通道 / 形态码 `bad_args` / `transport_failed`。

## 工具绑定

经记忆工具绑定暴露为 `memory.compress`（工具名 / 参数语义 / 四要素对齐工具注册表口径）：
参数 = `mode` + 结构化摘要字段（`goal` / `decisions` / `facts` / `open_questions` / `files` / `next_steps`）
+ `covered_upto`；只返回写计划、不直接写链。

## schema

`schema/compress.json` 是身份自述 / 数据契约：`mode` / `target_length` / `dedup_threshold` /
`extract_items`（≥1，钳制到 2..3）/ `embedding_model` 的默认值，以及三方法入参 / 结果形状。
**达阈触发阈值不住本 schema**（触发判定归上下文调配器）；本插件只按调用执行，不判定该不该压。
顶层 `method_timeouts` 为 `semantic` 路径留出大上限。

## 运行

```sh
npm test                        # 协议级 + 逻辑级测试（node --test；真实模型用例缺 .env 时优雅跳过）
node tools/e2e-smoke.mjs        # 宿主装配 E2E（pack 依赖链 → seed → 离线投影 + 协议直连假后端）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
