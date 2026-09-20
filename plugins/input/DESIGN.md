# #1 `input`（输入槽）

| 字段 | 内容 |
| --- | --- |
| 编号 / 身份 | 1 / `input` |
| 职责 | 世界里的"用户意图信箱"：**per-thread 键控寄存器**（每线程一个槽）——客户端写、回合读、回合末清 |
| 依赖 | pins 无；`<-` 11（计划写回 idle 清槽）、41（计划写回 idle 清槽，工作区类命令）、17（`model.probe` 清槽，只读命令入口 term 出计划）、32（`approval.decide` 清槽，裁决计划内同批）、48（`question.answer` 清槽）、13（投影读）；另被 14 / 16 / 39 经投影读判分支（非依赖边） |
| 成员 | terms, schema（**数据身份 + 一个纯读 term**；无 execute、无 pins、无 eff）（2026-09-20 修订） |
| 能力类·方法 | 无 |
| 命令 | `input.read`（纯 term，只读；读命令可带 args `{thread?}`，入口 term 直出 `ctx.ids.input.body` 整份 slots，见「写入契约」）（2026-09-20 修订） |
| schema | `schema/slot.schema.json`（单文件平铺 · JSON Schema 白名单子集） |
| 机制 | 见下「包契约 / 数据契约 / 写入 / 清槽 / 读取」 |
| 边界 | 不做：队列 / 重试 / 语义校验 / 历史 / 判定；不起进程、不发 eff（只读命令 `input.read` 由入口 term 读 `ctx` 直出，D8；服务不读投影）（2026-09-20 修订） |
| 验收 | 1) 一次 batch 写入成功且可回放；2) **投影能读到**（读取发生在 #11 / #13 / #14 / #16 / #17 / #39 / #41 / #48 的 eval 内，以及本插件只读命令 `input.read` 的入口 term 内）；3) 回合后该线程槽为 idle 世代，且 idle body 因内容寻址只存一份；4) 空槽 / idle 时 #14 走 idle 分支、#11 不产生业务写；5) 重放一致（含 message / idle 交替）；6) **per-thread 隔离**：A 线程清槽不擦 B 线程的槽（只清本线程键；v1 整值 `put` 下跨线程键非可交换、last-write-wins 为已知限制）（2026-09-20 修订） |
| 状态 | 已定（2026-09-18 细节设计）；未决：文本长度上限、附件数量上限。**版本提升：被提升方** —— #41 `workspace` 要求升一代：新增槽 kind `workspace.add` / `workspace.remove` 与字段 `workspace` / `name` / `path`；#48 `question` 要求加槽 kind `question.answer` 与字段 `answers`（且 #48 需 `+ 1` 读槽）；**#16 `ui-sidebar`（2026-09-19）要求加槽 kind `session.select` / `session.delete` / `session.restore` / `session.branch` 与字段 `conversation` / `message`**；**2026-09-19（threads-design §二）**：body 由单值改 **per-thread 键控** `{slots:{<thread_id>}}`（v1 整值 put 下 last-write-wins，见「并发语义」）；**2026-09-20 修订**：新增只读命令 `input.read`（入口 term 直出整份 slots）与槽 kind `memory.edit`（#17 S12 写类无参命令）；**跨插件登记**：#40（`input.read` 消费者，写槽前读-改-写）、#17（`memory.edit` 槽 kind） |

> 本插件是**数据身份的模板**：#3 `short-memory` / #4–10 `vendor-*` / #36 `skill` 共用同一形态（只有 `schema` 成员、`start` 为空、无 pins / 命令 / eff）；#2 `config` 与本插件（2026-09-20 起新增只读命令 `input.read`）同为数据身份 + 一个纯读 term（`terms` + `schema`）。（2026-09-20 修订）

## 包契约 `plugin.json`

```jsonc
{ "identity": "input",
  "schema": "schema/slot.schema.json",
  "implements": [], "methods": {}, "pins": {},
  "start": "",                       // 空 ≡ 无执行件（数据身份）
  "protocol": "1",
  "restart": {}, "health": {},       // 无服务；字段仍必须在（decl.ts 要求是对象）
  "state": "recomputable",
  "members": [
    { "kind": "term",   "path": "terms/" },
    { "kind": "schema", "path": "schema/" }
  ],
  "commands": [
    { "name": "input.read", "entry": "terms/input.read.json" }   // 只读；读命令可带 args `{thread?}`（2026-09-20 修订）
  ] }
```

## 数据契约 `schema/slot.schema.json`

**per-thread 键控（2026-09-19，threads-design §二）**：body 不再是单个槽，而是 `{ slots: { "<thread_id|_main>": <槽 body> } }`；每线程写自己的键、读自己的键 ⇒ A 线程清槽不擦 B 线程；**v1 整份 body 读-改-写共享一个链头，不同键并非可交换、last-write-wins（见「并发语义」）**。槽 body 本身仍按下列平铺形态。（2026-09-20 修订）

单文件平铺：白名单子集**没有 `oneOf` / `$ref`**，判别联合表达不了，故用「`required: ["kind"]` + `kind` 枚举 + 平铺各 kind 字段」；形态校验归**写入端**，宿主 v1 不校验身份数据。

```json
{
  "title": "input slot（用户意图信箱 · per-thread）",
  "description": "per-thread 键控寄存器：body = {slots:{<thread_id>}}；客户端整值写入该线程键，回合读取，由消费该槽的写类命令的终局计划以 idle 世代清该键（#11 / #17 / #32 / #41 / #48）。",
  "type": "object",
  "required": ["slots"],
  "additionalProperties": true,
  "properties": {
    "slots": { "type": "object",
      "description": "键 = thread_id（缺省 `_main`）；值 = 槽 body（下列平铺形态）" }
  }
}
// 槽 body（slots 的值，单值平铺）：
{
  "required": ["kind"],
  "properties": {
    "kind": { "enum": ["chat.message", "session.new", "session.select", "session.rename", "session.delete", "session.restore", "session.branch", "model.probe", "approval.decide", "question.answer", "workspace.add", "workspace.remove", "memory.edit", "idle"] },
    "text": { "type": "string", "description": "kind=chat.message" },
    "attachments": { "type": "array", "items": { "type": "object" },
      "description": "kind=chat.message；**与 #11 消息附件同形**：{ kind:'image'|'file'|'video'|'audio', name, source:{kind:'asset',sha256,mime,size}|{kind:'ext',url}, text? }。字节走资产面、世界只存 source 引用；`text` 仅可解析格式（纯文本 / md / 代码 / json / csv）内联文本（#40 写入、#13 组装用），不可解析格式缺省。形态校验在写入端" },
    "conversation": { "type": "string", "description": "目标会话 id；缺键 = 当前会话（kind=session.select / session.delete / session.restore / session.branch 的目标）" },
    "workspace_id": { "type": "string", "description": "kind=session.new；新会话所属工作区 id" },
    "title": { "type": "string", "description": "kind=session.rename" },
    "message": { "type": "string", "description": "kind=session.branch；源消息 id（以它为父链分叉）" },
    "workspace": { "type": "string", "description": "工作区 id：kind=workspace.add 为新建工作区的客户端生成 id；kind=workspace.remove 为目标 id" },
    "name": { "type": "string", "description": "kind=workspace.add；缺键 = 取 basename(path)" },
    "path": { "type": "string", "description": "kind=workspace.add；绝对路径，#41 按 realpath 校验 / 去重" },
    "url": { "type": "string", "description": "kind=model.probe" },
    "protocol": { "enum": ["openai-chat", "openai-responses", "anthropic-messages"], "description": "kind=model.probe；自定义厂商的三基础协议" },
    "auth_ref": { "type": "object", "required": ["kind", "name"], "additionalProperties": true,
      "properties": { "kind": { "enum": ["local", "env"] }, "name": { "type": "string" } },
      "description": "kind=model.probe；只存引用，不存密钥本体（本体住宿主侧用户本地文件 / 进程环境，见 #24）" },
    "id": { "type": "string", "description": "kind=approval.decide：待审批项 id；kind=question.answer：待作答问题队列项 id；kind=memory.edit：目标记忆条目 id" },
    "verdict": { "enum": ["accept", "deny"], "description": "kind=approval.decide" },
    "answers": { "type": "array", "items": { "type": "object" },
      "description": "kind=question.answer；作答内容（按问题顺序的 {question_id, selected[], custom?}），#48 消费" },
    "action": { "enum": ["update", "delete", "pin"], "description": "kind=memory.edit（#17 S12，2026-09-20 修订）" },
    "layer": { "enum": ["l1", "l2", "l3"], "description": "kind=memory.edit；记忆层级" },
    "patch": { "type": "object", "additionalProperties": true, "description": "kind=memory.edit；更新内容（action=update 时）" }
  }
}
```

## 写入契约（客户端经入站面 `submit`）

```jsonc
{ kind:'write', request:{ id, op:'batch', target:{ expect_pos: <head> }, args:{ ops:[
  { op:'put',     args:{ body: /* 新 body = 旧 slots 覆盖该 thread_id 键后的整份 {slots:{…}}（读-改-写） */ } },
  { op:'add_gen', args:{ id:'input', payload:{ $n:0 }, pins:{}, sig:{ $n:0 } } }
]}}}
```

- **写 = 读-改-写该线程键**：客户端（#40 等写槽方）写槽前先调**只读命令 `input.read`**（读命令可带 args `{thread?}`；入口 term 直出 `ctx.ids.input.body` 整份 slots）读回，覆盖 `<thread_id>` 键为新的槽 body，整份 `put`（2026-09-20 修订）。**服务侧清槽的整份 body 来自 #14 / #16 入口 term 的轮首 ctx**（权威，§1.14「bag 装配总表」）。
- `add_gen` 四字段全必填且 `payload` / `sig` 必须 64-hex（写入契约，见 `docs/kernel.md` 提交批口径）；`sig` 取同一定义键，与种子入世同形（见 `docs/host.md` 入世口径）。（2026-09-20 修订：不再引宿主源码行号）
- 占位符 `{"$n":0}` 只能指向本批内更早的 `put`；重放存替换前 args。
- 附件形态在**写入端**校验（#40）；字节本身走 **资产面**（入站 `asset.put` → `{kind:'asset',sha256,mime,size}`），**世界只存引用**。校验规则会在 #40 与 #11 各实现一份（白名单无 `$ref`，无法共享）——已知重复。

## 清槽契约（消费方的计划内，同一批）

```jsonc
// 清该线程键 = 读-改-写：把 slots[<thread_id>] 置为 {kind:'idle'}，其余键不动
{ op:'put',     args:{ body:{ slots:{ ...其余键, "<thread_id>": { kind:'idle' } } } } },
{ op:'add_gen', args:{ id:'input', payload:{ $n:k }, pins:{}, sig:{ $n:k } } }
```

- **只清本线程键**：A 线程清槽不擦 B 线程（per-thread 隔离，验收 6）。
- **不用 `set_active(input, null)`**：它与 `retire` 在审计里同义，"槽空闲"与"身份下线"分不开；且 §五 退役口径会带来隔离语义混淆。
- `idle` 的槽 body 恒定 ⇒ **仅当整份 body 与既有 def 一致时**该 `put` 才命中 `dup` 短路、**不新增 def**；只多一条 gen entry（2026-09-20 修订）。

## 读取契约

- 投影取 `ctx.ids.input.body.slots[<thread_id>]`（缺省键 `_main`）；`slot.kind === "idle"` 即空闲。
- **写回者 = 消费该槽的写类命令的终局计划**（不限于 #11）：#11 清 `chat.message` / `session.new` / **`session.select`** / `session.rename` / **`session.delete` / `session.restore` / `session.branch`**；#41 清 `workspace.add` / `workspace.remove`；**#17 的 `model.discover` 入口 term 清 `model.probe`**（只读命令，入口 term 直接返回含清槽的 `$directives`）；**#17 S12 `memory.edit` 清 `memory.edit`**（写类无参命令，2026-09-20 修订）；**#32 清 `approval.decide`**；**#48 清 `question.answer`**（裁决 / 作答计划内同批清槽，故 #32/#48 需 `+ 1` 读槽）。**无论成败都要清槽**，否则残留槽会让下一回合 #11 判定「非法槽 kind」。
- 读判据共八处：**#11**（槽 kind 分支）、**#13**（拼 messages）、**#14**（空槽幂等）、**#16 / #17 / #39 / #41 / #48**（各自命令入口 term 读槽 kind）。

## 并发语义（2026-09-20 修订）

- 槽是 **per-thread 键控寄存器**：每线程写自己的键、整值 `put` 覆盖（`input.read` 读回后 read-modify-write 整份 body）。
- **v1 诚实口径**：同一前端进程内**同线程键写者唯一**（#40 待发队列串行：`run.finished` 后自动发下一条），故同键无并发写。
- **跨线程键「可交换」在 v1 整值 `put` 下不成立**：整份 body 读-改-写共享一个链头，不同线程键的写入仍会互相 **last-write-wins**（登记为已知限制；H12 v1 共享 body 读-改-写、CAS 不触发）。
- **跨客户端并发写为已知限制**：多前端各写各的槽时 last-write-wins。
- 框架**不支持"插话"**：一次 run 锚定世代、`ctx` 轮首构造，中途写入对本次 eval 不可见；只存在"排队 → 下一回合消费"。
- 已知限制：刷新 / 重启丢待发队列（UI 显示"待发 N 条"）；多前端各排各的。
