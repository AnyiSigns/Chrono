# toy-react

React 前端验证插件（fixture，仅测试 / 开发用；不进正式世界）。用于验证「插件自带前端、可用
React 等框架」的投递链：依赖安装 → 打包 → 物化目录内产出 → 自带 HTTP 服务投递。

- 身份：`toy-react`
- 能力类：`toy.react`，方法：`ping`
- 依赖 pins：无（独立）
- 启动：`node execute/main.js`（stdio 服务 + 自带 HTTP 服务；stdout 只发协议帧，日志走 stderr）
- 构建：`plugin.json.build` 声明 `npm ci` → `npm run build`（esbuild 打包 `src/app.jsx`）
- 产物落点：`dist/`（物化目录内，被 `import.meta.url` 定位；`.worldignore` 排除，不入 ①）
- 状态档：`recomputable`（③ 可重算）
- 端口：默认 `127.0.0.1:8794`，可用 `CHRONO_UI_PORT_TOY_REACT` 覆盖

浏览器侧入口：`GET /`（`execute/index.html`）加载 `GET /app.js`（`dist/app.js` 构建产物）。
`GET /api/state` 返回服务自述，供探活。
