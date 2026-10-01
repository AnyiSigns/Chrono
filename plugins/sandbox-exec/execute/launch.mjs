// 启动器：经 SDK `launchNative` 定位宿主依赖恢复产出的 Rust 二进制，以 stdio 直通拉起并透传退出码。
// 宿主以 CHRONO_PLUGIN_STATE=<root>/state/plugins/<id> 注入；cargo 产物落
// <root>/state/deps/cargo-target/release/（上溯两级 = <root>/state）。找不到再回落包内 target/release/。
// 插件侧零 npm 依赖：plugin-sdk 由宿主准备阶段链入物化树。
import { launchNative } from 'plugin-sdk'

launchNative({ binary: 'sandbox-exec', logPrefix: 'sandbox-exec' })
