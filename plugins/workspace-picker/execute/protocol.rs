// `workspace-picker` 服务进程协议面：方法分派；帧编解码 / 控制帧 / 线程派发走 plugin-sdk。
// 纯 OS 集成原语：`pick` 打开系统目录选择器，`reveal` 在文件管理器打开给定路径；无世界写通道，
// 最近打开记本机 ③（`CHRONO_PLUGIN_STATE/recent.json`），丢失只影响便利性。

use std::io::{Read, Write};

use serde_json::{json, Value};

use plugin_sdk::{CallEnv, ServiceError, ServiceHandler, ServiceSpec};

use crate::pick;
use crate::platform::{SystemOpener, SystemPicker};
use crate::recent;
use crate::reveal;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "workspace-picker";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：无世界数据，仅本机 ③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 2] = ["pick", "reveal"];

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

/// `reveal` 目标路径：按 `args.workspace` id 在调用方随 `args.workspaces` 传入的清单里解析。
/// 本服务无 `needs`、不持清单；路径真源仍是 owner 清单，只是由调用方随请求带入。
fn reveal_path(args: &Value) -> Result<String, (String, String)> {
    let id = args
        .get("workspace")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ("bad_args".to_string(), "reveal requires a workspace id".to_string()))?;
    let workspaces = args.get("workspaces").and_then(Value::as_array).ok_or_else(|| {
        (
            "bad_args".to_string(),
            "reveal requires the workspace list".to_string(),
        )
    })?;
    workspaces
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|item| item.get("path").and_then(Value::as_str))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            (
                "bad_args".to_string(),
                "reveal requires a workspace id resolvable in the list".to_string(),
            )
        })
}

/// 处理 `call`：方法分派 + 结构化错误码。纯动作，不写存储。
pub fn handle_call(method: &str, args: &Value, _env: &CallEnv) -> Result<Value, (String, String)> {
    let state = recent::state_dir();
    match method {
        "pick" => pick::pick_value(&SystemPicker, state.as_deref()),
        "reveal" => {
            let path = reveal_path(args)?;
            Ok(reveal::reveal_value(&SystemOpener, &path, state.as_deref()))
        }
        other => Err(("unknown_method".to_string(), format!("unknown method {other}"))),
    }
}

/// 调用处理器：解析调用帧 `env`，领域错误映射为协议错误。
struct Handler;

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError> {
        let env = CallEnv::parse_value(env);
        handle_call(method, args, &env).map_err(ServiceError::from)
    }
}

/// 服务入口：帧循环由 SDK 起（`call` 独立线程执行，控制帧不被阻塞）。
pub fn run_loop<R: Read, W: Write + Send + 'static>(reader: R, writer: W) {
    let shared = plugin_sdk::shared_writer(writer);
    plugin_sdk::run_service(&SPEC, reader, shared, Handler);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "workspace-picker");
        assert_eq!(value["implements"], json!(["workspace-picker"]));
        assert_eq!(value["methods"]["workspace-picker"], json!(["pick", "reveal"]));
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &CallEnv::default()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn reveal_without_workspace_id_is_bad_args() {
        let err = handle_call(
            "reveal",
            &json!({ "workspaces": [] }),
            &CallEnv::default(),
        )
        .unwrap_err();
        assert_eq!(err.0, "bad_args");
    }

    #[test]
    fn reveal_without_list_is_bad_args() {
        let err = handle_call("reveal", &json!({ "workspace": "w1" }), &CallEnv::default())
            .unwrap_err();
        assert_eq!(err.0, "bad_args");
    }

    #[test]
    fn reveal_path_resolves_from_caller_list() {
        let workspaces = vec![
            json!({ "id": "w1", "path": "C:\\ws" }),
            json!({ "id": "w2", "path": "C:\\other" }),
        ];
        let args = json!({ "workspace": "w2", "workspaces": workspaces });
        assert_eq!(reveal_path(&args).unwrap(), "C:\\other");
    }

    #[test]
    fn reveal_path_unknown_id_is_bad_args() {
        let args = json!({ "workspace": "ghost", "workspaces": [{ "id": "w1", "path": "C:\\ws" }] });
        assert_eq!(reveal_path(&args).unwrap_err().0, "bad_args");
    }
}
