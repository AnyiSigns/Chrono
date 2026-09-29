//! `tokenizer` 原生子组件（napi 原生扩展）：唯一 token 计数实现。
//!
//! TS 服务进程内加载本扩展；native 缺失 / 加载失败 ⇒ 服务启动即失败，绝不回落 JS 计数
//! （两份实现必然漂移，破坏「预算 / 75% 阈值 / 同输入同输出」）。
//! 手写最小 JS binding：不依赖 `@napi-rs/cli`，`.node` 直接由 TS 侧 `require`。

mod estimator;

use napi_derive::napi;

/// 按 v1 估算器规格计数（确定、同输入同输出）。
#[napi(js_name = "countText")]
pub fn count_text(text: String) -> u32 {
    u32::try_from(estimator::count_text(&text)).unwrap_or(u32::MAX)
}

/// 估算器规格版本；接缝替换真 tokenizer 时随之变更。
#[napi(js_name = "estimatorVersion")]
pub fn estimator_version() -> String {
    "v1".to_string()
}

/// 「其余码点」的分桶大小（供 TS 侧自述 / 诊断）。
#[napi(js_name = "otherBucket")]
pub fn other_bucket() -> u32 {
    u32::try_from(estimator::OTHER_BUCKET).unwrap_or(u32::MAX)
}
