# sandbox-policy（档位与授权判定）

沙箱链最底层的**判定提供方**（Rust）：解析四档 fs/net 映射表（`auto` / `severe` / `review` / `deny`）
与工具声明 `caps` 的钳制，给出「声明 ∩ 当前档」后的实际放行范围；并校验 / 消费一次性 `caps.grant`。
本插件**只判定、不执行**：不 spawn 进程、不碰文件系统，判定结果随调用返回，由执行方
（`sandbox-exec` / `sandbox-fs`）就地强制。

- 能力类：`sandbox-policy`；方法：`resolve`（纯判定）/ `consume`（一次性 grant 消费）。
- 命令：无。`pins`：无（判定所需世界数据全由调用方随 bag 传入）。
- 启动：`node execute/launch.mjs`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。
- 状态档：`recomputable`（grant 消费记录驻进程内存，重启即清，符合一次性语义）。
- 实现语言：Rust（源码 + `Cargo.toml` 入世，`target/` 与二进制走宿主侧依赖缓存）。
- 方法级超时：schema 顶层 `method_timeouts` 声明 `sandbox-policy.resolve` / `sandbox-policy.consume`
  各 5000ms（低于上层 `sandbox.exec` 的 130000，嵌套超时严格收敛）。
- 审计脱敏：`sandbox-policy.consume` 的 `grant` 为能力凭据，入审计前脱敏。

## 方法契约

### `resolve(args)`

```jsonc
{ "tier": "severe", "caps": { "fs": { "read": "full", "write": "full" }, "net": "all" },
  "sandbox_tiers": { /* 档位映射数据世代 body，可缺省回落内建 */ } }
```

返回 `{ tier, deny_tier, impl, docker_image, policy_net, net_within_tier, fs_read, fs_write, caps }`：

- 四档映射表住调用方随 bag 传入的 `sandbox_tiers`（数据世代 body）；缺省用内建兜底（与
  `tools/default-body.json` 同形）。
- 未知 / 缺失档 fail-closed：`deny_tier:true`、`fs_read` / `fs_write` 为 `none`。
- `fs_read` / `fs_write` 为「声明 `caps.fs.*` ∩ 当前档范围」后的实际放行范围。
- `net_within_tier` 为声明 net 是否在档位范围内；越档由执行方回 `net_denied`（判定不拒绝，只标注）。
- `caps` 为钳制后的资源上限。

### `consume(args)`

```jsonc
{ "grant": { "call_id": "…", "tier": "severe", "expires": 123.4, "fs": { "read": "workspace" },
  "op": "read", "paths": ["src/a.rs"], "net": "none" }, "tier": "severe", "now": 100.0 }
```

返回 `{ ok, fs_read?, fs_write?, net?, code? }`：档位一致、未过期、未消费过才 `ok:true` 并回放宽范围；
同一 `call_id` 第二次出现即拒（不可重放为常设权限）。`deny` 档不放宽，`paths` 空视为**不适用**，
未显式声明的维度不额外放宽。

## 判定与强制的分工

判定（本插件）与强制（`sandbox-exec` / `sandbox-fs`）分离：本插件输出纯数据判定，执行方在
热路径就地取用，不把每次 fs / net 访问做成反调判定服务。

## 运行

```sh
npm test    # Windows：cargo test
```

## `.worldignore`

声明 `target/`（构建产物）、`tools/`（本地工具）、`test/` 不入世界；`plugin.json` / `package.json` /
`Cargo.toml` / `README.md` / `schema/` / `execute/` 随源码入世。
