// 插件服务 SDK（Rust 侧）：服务协议壳（帧编解码 / 规范序列化 / 帧循环 / 反向调用通道）。
// 零内核零宿主依赖：规范序列化自带，与宿主线格式（TS `canonical.ts` / `wire.ts`）逐字节一致。
// 插件只写方法实现（`ServiceHandler::call`）与领域逻辑，协议壳由本 SDK 吸收。

mod port;
mod service;
mod wire;

pub use port::{PortLink, DEFAULT_CALL_TIMEOUT_MS};
pub use service::{
    current_call_id, manifest, run_service, set_current_call_id, shared_writer, CallEnv,
    CurrentCallIdGuard, ServiceError, ServiceHandler, ServiceSpec, SharedWriter,
};
pub use wire::{
    canonical_json, encode_frame, log, read_frame, write_frame, MAX_FRAME_BYTES, MAX_JSON_DEPTH,
    SERVICE_PROTOCOL_VERSION,
};
