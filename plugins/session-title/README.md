# session-title（会话自动标题）

按会话**首条用户消息**，用**用户配置的模型**生成 **不超过 10 字**的标题，写入会话身份的 `title`。
旁路增强：模型失败 / 超时 / 返回空时确定性兜底，**不报错、不阻塞主回合**；不覆盖用户手动标题（首条判定归调用方入口 term）。

- 身份：`session-title`
- 能力类 / 方法：`session-title` → `generate`
- 命令：无（由调用方回合管道按能力类调 `generate`，不暴露命令面）
- 成员：`execute`（TS 服务）、`schema`（`title.json`）
- `pins`：`model` → `model-protocol`（`model.complete` 非流式单次补全）、`session` → `session`（`set_title`）
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
5. 写入：反向调用会话服务的 `set_title {conversation, title}`，把其返回的写计划（`$directives`）**原样上提**，
   由调用方入口 term 机械合并进顶层。本插件不构造 `put` / `add_gen`、不写世界本体。

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

- 成功：`{$directives:[…]}`——即会话服务 `set_title` 返回的写计划，**原样上提**，本插件不改写。
- 会话调用失败（未就绪 / 超时 / 未返回计划）：`{$directives:[extern({ok:false, error})]}`（无写、不炸本轮）。

## 边界

- 不做：标题显示（归侧栏 / 顶栏）/ 重命名 UI / 模型实现与韧性（归模型服务）/ 判定是否首条（归调用方入口 term）。
- **不覆盖用户手动标题**：首条判定归调用方入口 term；会话服务的 `set_title` 无条件写入。
- 不内置任何模型名；不取时间 / 随机，同输入同输出。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）；跨插件只走 `port.call`。

## 运行

```sh
npm test                        # 协议级 + 纯函数级测试（node --test）
node tools/e2e-smoke.mjs        # 宿主装配 E2E（pack 依赖链 → seed → 离线投影 + 协议直连假后端）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
