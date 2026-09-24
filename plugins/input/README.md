# input（输入槽）

世界里的「用户意图信箱」：**per-thread 键控寄存器**。每个线程一个槽，客户端写、回合读、回合末清。
本包是**数据身份**：只有 `schema` 与一个纯读 term，无服务进程、无 pins、无 eff。

## 身份与数据

- 身份：`input`
- body 形状：`{ slots: { "<thread_id>": <槽 body> } }`；线程键缺省 `_main`。
- 槽 body 单值平铺，`kind` 判别（`chat.message` / `session.new` / `session.select` /
  `session.rename` / `session.delete` / `session.restore` / `session.branch` / `model.probe` /
  `approval.decide` / `question.answer` / `workspace.add` / `workspace.remove` / `memory.edit` / `idle`）；
  各 kind 的字段见 `schema/slot.schema.json`。
- 形态校验归写入端（宿主不校验身份数据）。
- 默认 body：`{ "slots": {} }`，见 `tools/default-body.json`。

## 提供哪些命令

- `input.read`（只读，纯 term）：入口 term 直出投影里的整份 input 身份视图
  （`ctx.ids.input`，含 `active` / `gens` / `body` / `pins` / `refs`）。调用方取 `body` 为槽本体，
  取 `active` 作写 `add_gen` 时的 `expect_active`（两次往返的陈旧读据此条件拒写）。
  - args：可选 `{ thread?: string }`，只做声明校验；**本命令不按 thread 过滤**，取用留给调用方。
  - 不触发 eff、不推进链。

## 怎么起

无服务：`start` 为空，宿主不起进程。入世后投影即可读。

## 状态档

`state: "recomputable"`（③ 可重算）。

## 写入与清槽

- 写 = 读-改-写该线程键：先 `input.read` 读回整份 slots，覆盖目标线程键后整份 `put` + `add_gen`。
- 清槽 = 把目标线程键置为 `{ kind: "idle" }`，其余键不动；`idle` 槽 body 恒定，命中内容寻址的幂等短路。
- 不擦其他线程键。

## 默认 body 预置（可复现）

- `tools/default-body.json`：默认 body（`{ "slots": {} }`）。
- `tools/seed-default-body.mjs`：宿主已 `start` 时，读默认 body 并提交一条数据世代写入
  （`put` + `add_gen`）。`start.mjs` 首启对尚无数据世代的身份自动执行；本身份必须预置，
  否则客户端读-改-写槽时会读到代码世代回落 body 而拒写（`not_loaded`）。

```
node plugins/input/tools/seed-default-body.mjs --root <宿主根目录>
```

等价地，也可用 `boot run` 手动提交一条数据世代写入
（把 `<root>` 换成宿主根目录，`<head>` 换成 `boot status` 报出的链头哈希）：

```
node packages/boot/main.ts run "[{\"kind\":\"write\",\"request\":{\"id\":\"input-default\",\"op\":\"batch\",\"target\":{\"expect_pos\":\"<head>\"},\"args\":{\"ops\":[{\"op\":\"put\",\"args\":{\"body\":{\"slots\":{}}}},{\"op\":\"add_gen\",\"args\":{\"id\":\"input\",\"payload\":{\"$n\":0},\"sig\":{\"$n\":0},\"pins\":{}}}]},\"by\":\"seed-default\"}}]" --root <root>
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `terms/`）随源码入世。
