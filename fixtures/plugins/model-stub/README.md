# model-stub（测试夹具）

确定性 `model` 实现，供离线验收与 CI：**替换真模型服务后调用方零改动**。

- 能力类：`model`；方法：`chat`。
- `pins`：无；命令面：无。
- 启动：`node execute/main.js`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`。
- 成员：仅 `execute`（无 schema、无世界数据）。

## 契约

`chat(bag)` 回确定性结果：对规范化输入取 sha256 前缀作文本，用量按消息字符数推导；
同输入两次调用逐字节一致。先上行一条 `event(topic:"model.delta")`（含 `run` / `thread` / `text` / `done`），
再回 `result` 值：

```jsonc
{ "ok": true, "text": "model-stub:<hash16>", "tool_calls": [],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "model": "…", "protocol": "stub" }
```

不读投影、不写世界、不取时间 / 随机。

> 本包是**夹具，不参与生产 seed**；与真模型服务同声明 `model` 能力类，测试世界**互斥装载**（替换，非共存）。
