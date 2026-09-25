# guard（工具调用语义门）

工具调用语义门：**纯函数**逐 call 出 `allow` / `escalate` / `deny`。
`escalate` = 工作区外 / 危险操作，需要弹卡；`deny` = 未声明能力 / 明确禁止的调用。
本插件只判、不执行、不等待：fs 范围强制与 realpath 权威在沙箱；审批 UI 与等待在编排 / 审批面。

- 能力类：`guard`；方法：`judge`。
- 命令：无。`pins`：无。`+`（投影读）：无——`tier` / `workspace_root` / `guard_rules` 由调用方入口 term 读出后随 bag 传入。
- 状态档：`recomputable`（无状态；`judge` 不发起 eff、不等待、不取时间、不用随机，同输入同输出）。
- 启动：`node execute/main.ts`（宿主 spawn，stdio 协议帧；日志走 stderr；stdin EOF 即自退出）。

## `judge(bag)` 入参

```jsonc
{
  "calls": [ { "port": "tool-fs", "tool": "read", "args": { "path": "a.txt" }, "path": "a.txt" } ],
  "tier": "severe",              // auto / severe / review / deny；缺省或未知按 fail-closed（升级全开）
  "workspace_root": "C:\\ws",     // 词法预判基准；realpath 权威在沙箱
  "guard_rules": { /* 本身份数据世代 body；缺省用内建机械兜底 */ }
}
```

- `calls` 缺省 = 空数组；非数组 → 结构化 `bad_args`。
- 路径取自 `call.path`（顶层）与 `call.args.path` / `call.args.paths`（键名由规则声明）。
- 外部 MCP 服务器名取自 `call.server` 或 `call.args.server`。

## `judge` 返回形状

```jsonc
{
  "decisions": [
    { "index": 0, "port": "tool-fs", "tool": "read",
      "verdict": "escalate", "reason": "outside_workspace", "rule": "C:\\other\\a.txt" }
  ],
  "summary": { "allow": 0, "escalate": 1, "deny": 0 }
}
```

- `decisions` 与 `calls` **同序**；`index` = call 下标；`port` / `tool` 原样回带（非法 call 回空串）。
- `verdict` ∈ `allow` / `escalate` / `deny`；`reason` 取自固定词表（机械可测）；
  `rule` 仅在 escalate / deny 时出现（危险模式 id / mcp 服务器名 / 结构写键 / 越界路径）。

| `reason` | 含义 |
| --- | --- |
| `allowed` | 放行（含档位关掉升级后的直落）。 |
| `outside_workspace` | 词法预判：路径落在 `workspace_root` 之外（读也升级）。 |
| `dangerous_pattern` | 命中危险操作模式（`rule` = 模式 id）。 |
| `mcp_untrusted` | 外部 MCP 工具，服务器未经 `confirmed && trusted`（`rule` = 服务器名 / 工具名）。 |
| `structural_write` | 结构写高危（`rule` = `port.tool`）。 |
| `net_outside_tier` | 工具声明的 `caps.net` 超出当前档 net 范围（`rule` = 声明范围 none/limited/all）。 |
| `undeclared_capability` | `port` 不在规则的能力白名单内。 |
| `forbidden_call` | `(port, tool)` 在明确禁止清单内。 |
| `bad_call` | call 形态非法（非对象 / `port` 或 `tool` 缺失）。 |

判定优先级（先命中先定）：`deny`（形态 / 禁止 / 白名单）→ 结构写 → 外部 MCP → 危险模式 → 工作区外 → net 越档 → `allow`。

## 默认启发式与档位

- **工作区外（词法预判）**：写 / 删除 / 重命名落在 `workspace_root` 之外 → `escalate`；**读也一并升级**。
  纯词法归一（统一分隔符、消 `.` / `..`、盘符小写），不触盘、不解引用。
- **危险操作模式**：递归删除、提权 / 改权限、管道下载后执行、改注册表 / 系统服务、格式化 / 分区、
  持久化改环境变量 → `escalate`（模式清单住规则数据）。
- **外部 MCP**：`port = mcp` 的工具默认 `escalate`；规则里 `confirmed && trusted` 的服务器例外。
- **net 越档**：调用方（编排层 `gateBag`）把每个 call 声明的 `caps.net` 与当前档 net 范围随 `calls[].net` /
  `bag.tier_net` 传入，本插件只做序比较（none < limited < all）与裁决：声明超出档位范围 → `escalate`
  （`net` 段可关 / 改裁决）。批准后由编排层签发一次性 `caps.grant`（`op:"exec"` + `net`）放行本次；
  真正的强制面在 sandbox / 工具自身。`auto` 档 net=all 本就不越档。
- **结构写高危**：`(plugin-admin, plugin.write)` 与 `(orchestration-admin, orchestration.propose)` → `escalate`。
- **档位开关**（`guard_rules.tiers`）：`auto` 档直落（结构写 / 危险模式 / 工作区外 / net 越档不弹卡），
  但 **MCP 在 `auto` 档也 `escalate`**；`severe` / `review` / `deny` 升级全开。
  缺省 / 未知档位按 fail-closed（升级全开）。

## 规则数据（本身份数据世代 body）

规则**不住 schema**（schema 出生即冻结），住**本身份数据世代 body**：`bag.guard_rules` 由调用方入口 term
读投影 `ids.guard.body` 后随 bag 传入；热改 = 数据换代（`put` + `add_gen`，进程不动）。
`bag.guard_rules` 缺省（未 seed）时用**内建机械兜底**（`execute/rules.ts`，与 `tools/default-body.json` 同形）。

- 每条规则自带 `verdict`（`escalate` / `deny` / `allow`），判定取规则数据；改规则即改判定。
- `tools/default-body.json`：默认启发式的结构化形态（工作区外判据 / 危险模式清单 / mcp 默认 / 结构写清单 / 档位开关）。
- `tools/seed-default-body.mjs`：宿主已 `start` 时，读默认 body 并提交一条数据世代写入（`put` + `add_gen`）。可重复执行。

```sh
node plugins/guard/tools/seed-default-body.mjs --root <宿主根目录>
```

## 边界

- 不做 fs 范围强制 / realpath 权威判定（归沙箱）；两判不一致时沙箱 fail-closed 拒绝。
- 不做审批 UI、不等待审批、不执行 `deny`；`escalate` 后的入队 / 裁决 / 续跑归编排与审批面。
- 服务不 import 宿主与内核，运行时零依赖（只用 Node 内置模块）。

## 运行

```sh
npm test                                  # 协议级测试（node --test）
node tools/e2e-smoke.mjs                  # 数据世代 E2E（pack → seed → start → seed body → stop → verify/replay → 离线投影）
```

## `.worldignore`

声明 `test/` 与 `tools/` 不入世界；其余（`plugin.json` / `package.json` / `README.md` /
`schema/` / `execute/`）随源码入世。
