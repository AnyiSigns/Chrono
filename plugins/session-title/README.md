# session-title（会话自动标题）

按会话**首条用户消息**，用**用户配置的模型**生成 **不超过 10 字**的标题并**回标题值**。
旁路增强：模型失败 / 超时 / 返回空时确定性兜底，**不报错、不阻塞主回合**；不覆盖用户手动标题（首条判定归调用方入口 term）。

- 身份：`session-title`
- 能力类 / 方法：`session-title` → `generate`
- 命令：无（由调用方回合管道按能力类调 `generate`，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`title.json`）
- `pins`：`model` → `model-protocol`（`model.complete` 非流式单次补全）
- 状态档：`recomputable`（无本地持久状态；模型调用不重放、不缓存）
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）
- 健康探针自述：`session-title.generate`（宿主健康判定走协议级 `probe` / `pong`，本字段仅服务自述）

## 行为

1. 入参（bag）：`{conversation, first_message, vendor, model, params, title_default}` 由调用方入口 term
   读出用户配置后装配传入；服务**不读投影**。
2. 生成：反向调用模型服务的 `model.complete {config, messages, max_tokens}`——**非流式**，不发 `model.delta`，
   避免流式分片被当成助手消息污染消息流。提示词住 `schema/title.json`。
3. 后处理：取首个非空行，去首尾空白 / 引号 / 换行 / 结尾标点，再按 **Unicode 码点**硬截断到 ≤10 字
   （CJK 每字 = 1，不劈代理对）。
4. 兜底（确定性）：模型失败 / 超时 / 返回空 → 取首条用户消息去空白后前 10 字；仍空 → 保留 `title_default`。
5. 返回：`{ok:true, title}`——标题值（非写计划）。标题落盘归调用方 `chat`：它把标题并入传给
   `loop-policy.interpret` 的 session body，由 `session.commit` 在提交消息时一次性写入（**本插件不构造
   `put` / `add_gen`、不写世界本体**）——这样标题与提交同基，不会出现「标题整份写覆盖提交」的竞争。

## 入参（args / bag）

```jsonc
{
  "conversation": "c-1",        // 必填：目标会话 id
  "first_message": "帮我写个排序", // 必填：本回合用户消息文本
  "vendor": "vendor-openai",    // 可选：用户配置的厂商身份名
  "model": "gpt-4o-mini",       // 可选：用户配置的模型 id（本插件不内置模型名）
  "params": { "temperature": 0.3 },
  "title_default": "新对话",     // 可选：最终兜底标题
  "prompt": "…",                // 可选：覆盖 schema 提示词
  "max_chars": 10,              // 可选：覆盖字数上限（钳制 1..10）
  "max_tokens": 64,             // 可选：覆盖 max_tokens
  "timeout_ms": 15000           // 可选：覆盖超时
}
```

- 缺 `conversation` / `first_message` → 结构化 `bad_args`（不跑方法、不落账）。
- 未配置模型（无 `vendor` / `model` / `params`）不报错：直接走兜底。
- 提示词 / 字数上限 / `max_tokens` / 兜底策略 / 超时住 `schema/title.json`；调用方入口 term 读出身份数据后
  可随 args 按次覆盖（热改路径）。

## 结果

- 成功：`{ok:true, title}`——标题值（生成或确定性兜底），由调用方 `chat` 并入 session body 后随提交落盘。
- 缺 `conversation` / `first_message`：结构化 `bad_args`（不跑方法）。
- 模型失败 / 超时 / 返回空：**不报错**，回兜底标题（不阻塞主回合）。

## 边界

- 不做：标题显示（归侧栏 / 顶栏）/ 重命名 UI / 模型实现与韧性（归模型服务）/ 判定是否首条（归调用方入口 term）。
- **不写世界**：标题落盘归调用方 `chat`（并入 session body、随 `session.commit` 落盘）。
- **不覆盖用户手动标题**：首条判定归调用方入口 term；标题只在该判定成立时生成。
- 不内置任何模型名；不取时间 / 随机，同输入同输出。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）；跨插件只走 `port.call`。

## 运行

```sh
npm test                        # 协议级 + 纯函数级测试（node --test）
node tools/e2e-smoke.mjs        # 宿主装配 E2E（pack 依赖链 → seed → 离线投影 + 协议直连假后端）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
