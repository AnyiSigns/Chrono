# toy-python

非 JS toy 插件（fixture，仅测试 / 开发用；seed 进临时世界，不进正式世界）。

- 身份：`toy-python`
- 能力类：`toy.python`，方法：`echo`
- 依赖 pins：无（独立）
- 启动：`py execute/main.py`（Windows Python Launcher；本机 `python` 是 Store 别名，cmd 解析不到）
  （stdio 服务；stdout 只发协议帧，日志走 stderr）
- 状态档：`recomputable`（③ 可重算）
- `.worldignore`：声明 `__pycache__/` 与 `execute/__pycache__/`，验证非 JS 运行时缓存不入 ①

服务协议最小面（`docs/protocol.md` §二）：4 字节大端长度 + UTF-8 JSON 帧，
`hello`→`manifest`、`call`→`result`/`error`、`probe`→`pong`、`drain`→`bye`、`reload`→`ack`；
stdin EOF / 管道断开即自退出；单帧超 16 MiB 按协议拒绝。
`service-config.json`（测试注入，不进 fixture）可覆写 `callMode`（`silent` / `exit` / `error`）等行为。
