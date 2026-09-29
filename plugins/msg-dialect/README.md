# msg-dialect（消息方言编解码）

网络链的**消息方言提供方**：把归一化 messages / system / 推理档位·map / 工具 / 缓存断点编成请求体，
并把**非流式整包**回包解析为 `text` / `reasoning`（中立块）/ `tool_calls` / `usage` / `stop_reason`。

- 能力类：`msg-dialect`；方法：`normalize-quirks` / `reasoning-capability` / `encode-tools` /
  `apply-auth` / `build` / `parse-full` / `inline-assets`。
- `pins`：`{"host":"host"}`——`inline-assets` 经 `host.asset.get` 取二进制附件字节。
- 不读投影、不写世界、不自取时钟；无 `state` 数据（`recomputable`）。
- **逐段流式 SSE 解析不在此**：跨插件 `port.call` 是请求 / 响应，不能传流式回调 / `AsyncIterable`，
  故流式解码与 HTTP / SSE 传输留在消费方 `model-protocol`。

## 方法

- `normalize-quirks({quirks?, protocol_override?})` → `{quirks}`：协议默认 + 厂商覆盖归一。
- `reasoning-capability({provider?, protocol?, impl?, profile?})` → `{capability}`：显式档案 >
  厂商覆盖 > SDK 默认 > 协议默认 > 保守默认。
- `encode-tools({tools, protocol})` → `{tools}`：中性声明按协议编成 function 工具；原生项透传。
- `apply-auth({url, quirks, secret})` → `{url, headers}`：按 `auth_style` 生成鉴权。
- `build({quirks, provider, base_url?, model, messages, params?, secret?, stream?, tools?, tool_choice?, cache?, capability_profile?})`
  → `{kind:'http', protocol, url, headers, body}` 或 `{kind:'sdk', protocol:'sdk', params}`。
- `parse-full({quirks, provider, model, json})` → `{text, reasoning?, reasoning_blocks?, tool_calls, usage, stop_reason?}`。
- `inline-assets({messages, protocol})` → `{messages}`：`asset:<sha256>` 占位符经 `host.asset.get`
  换成内联字节（data URL / base64 块）；失败 / 超限降级文本引用。

## 运行

```sh
npm test                 # node --test
```

## `.worldignore`

排除 `test/`；`plugin.json` / `package.json` / `README.md` / `schema/` / `execute/` 随源码入世。
