# 计划 04 · tool + sandbox 插件

> 前置：`plan-03`（engine）。
> 口径来源：`docs/agent.md` §4 / §7 / §8（G5）；`docs/plugins.md`。
> 本计划 = 加一批插件；**不改**框架代码。

---

## 目标

让 agent 能真正执行命令与改文件：Rust 沙箱跑 `exec`，工具提供 `patch_apply` / `run_tests` / `grep`。

## 前置

`plan-03` 验收全绿。

## 本阶段交付

- `sandbox/rust`：`Cargo.toml` + 源码入世 + `exec` 协议声明；1 执行件。
- `tool/patch_apply`、`tool/run_tests`、`tool/grep`：各含 `executors` 与/或 `terms`（至少一项非空）。
- 端口：`exec`（`run({cmd,cwd,timeout,gid,env})`）、`fs`（`read`/`write`/`list`/`stat`/`apply_patch`，根 = 工作区白名单）。
- 端点注册：「工具名 → 进程 + 方法」进注册表。
- `engine.core` 新世代：`pins` 加入 `tool/*`（一次 `add_gen`，不改装配层）。

## 本阶段口径

- 沙箱：工作区白名单、无网、超时、资源上限；产物路径回写校验（G5）。
- `exec` / `fs` 效果同样入 `EffectAudit`。
- 工具是普通插件；`patch_apply`（工具）与 `fs.apply_patch`（端口方法）不是一回事，调用面分开。
- 执行件不承担校验。

## 出口验收

1. 沙箱真跑一条命令并返回 `{code,stdout,stderr}`；越界路径被拒。
2. 三个工具被 engine 真实调用各一次。
3. 每对 `EffRequest→EffResult` 有 `EffectAudit` def 且被 `ref` 指到。

## 本阶段不做

- 判分 / bench（`plan-09`）、容器、网络命名空间、工具自动生成市场。

## 范围红线

- 不改框架；沙箱不给网络、不给白名单外路径。
- 不把校验写进执行件。

## 单次会话可完成

按 `sandbox/rust` → `exec` → `fs` → 三个 tool → engine 接入 提交；超尺度即再切。
