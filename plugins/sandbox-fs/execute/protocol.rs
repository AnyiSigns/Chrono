// `sandbox-fs` 服务进程协议面：结构化文件操作 `fsop`（六 op）的强制执行。
// 档位判定由 `sandbox-policy.resolve` 注入（bag.resolved）；缺省回落内建同源判定。
// 强制点在本插件：realpath 解析 + 与 workspace_root 前缀比对后执行；帧循环走 plugin-sdk。

use serde_json::{json, Value};

use plugin_sdk::{CallEnv, ServiceError, ServiceHandler, ServiceSpec};

use crate::fsop;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "sandbox-fs";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 2] = ["fsop", "capabilities"];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: IDENTITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    plugin_sdk::manifest(&SPEC)
}

/// 处理 `call`。
pub fn handle_call(method: &str, args: &Value, env: &CallEnv) -> Result<Value, (String, String)> {
    match method {
        "capabilities" => Ok(capabilities()),
        "fsop" => Ok(fsop::fsop(args, env.now)),
        other => Err(("unknown_method".to_string(), format!("unknown method {other}"))),
    }
}

/// 本插件的能力自述部分：文本匹配口径（casefold 表 Unicode 版本）。
pub fn capabilities() -> Value {
    json!({
        "text": { "casefold": { "unicode": crate::casefold_table::UNICODE_VERSION } }
    })
}

/// 调用处理器。
struct Handler;

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError> {
        let env = CallEnv::parse_value(env);
        handle_call(method, args, &env).map_err(ServiceError::from)
    }
}

/// 服务入口：帧循环由 SDK 起。
pub fn run_loop<R: std::io::Read, W: std::io::Write + Send + 'static>(reader: R, writer: W) {
    let shared = plugin_sdk::shared_writer(writer);
    plugin_sdk::run_service(&SPEC, reader, shared, Handler);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "sandbox-fs");
        assert_eq!(value["implements"], json!(["sandbox-fs"]));
        assert_eq!(value["methods"]["sandbox-fs"], json!(["fsop", "capabilities"]));
    }

    #[test]
    fn capabilities_reports_casefold_version() {
        let value = capabilities();
        assert!(value["text"]["casefold"]["unicode"].is_string());
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &CallEnv::default()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }
}
