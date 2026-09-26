// `workspace` 服务进程协议面：方法分派；帧编解码 / 控制帧 / 线程派发走 plugin-sdk。
// stdout 只发协议帧，日志走 stderr。清单已出世界：住自有持久存储（store.rs），本服务读写自有存储，
// 不再构造世界写计划；输入槽清理由调用方（ui-sidebar）经 input 服务承担。

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use plugin_sdk::{CallEnv, ServiceError, ServiceHandler, ServiceSpec};

use crate::body::{self, RealFs};
use crate::pick;
use crate::platform::{SystemOpener, SystemPicker};
use crate::recent;
use crate::reveal;
use crate::store::Store;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "workspace";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：清单出世界，落 ④ 不可重算。
pub const STATE: &str = "durable";

const METHODS: [&str; 6] = ["list", "read", "pick", "add", "remove", "reveal"];

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

/// `reveal` 目标路径：只按 `args.workspace` id 在自有存储的清单里解析。
/// 不接受未校验的 `args.path`——契约只声明 `{workspace}`，路径真源是 owner 清单。
fn reveal_path(workspaces: &[Value], args: &Value) -> Result<String, (String, String)> {
    let id = args
        .get("workspace")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ("bad_args".to_string(), "reveal requires a workspace id".to_string()))?;
    body::workspace_path(workspaces, id).ok_or_else(|| {
        (
            "bad_args".to_string(),
            "reveal requires a workspace id resolvable in the owner list".to_string(),
        )
    })
}

/// 处理 `call`：方法分派 + 结构化错误码。写类方法即时落自有存储（边跑边追加）。
pub fn handle_call(
    method: &str,
    args: &Value,
    env: &CallEnv,
    store: &mut Store,
) -> Result<Value, (String, String)> {
    let state = recent::state_dir();
    match method {
        "list" => Ok(body::list_value(&store.workspaces(), &RealFs)),
        "read" => Ok(store.body().clone()),
        "pick" => pick::pick_value(&SystemPicker, state.as_deref()),
        "add" => {
            let (list, payload) = body::add_value(&RealFs, args, &store.workspaces())?;
            store.write(env.run.as_deref(), json!({ "version": 1, "workspaces": list }));
            Ok(payload)
        }
        "remove" => {
            let (list, payload) = body::remove_value(args, &store.workspaces())?;
            store.write(env.run.as_deref(), json!({ "version": 1, "workspaces": list }));
            Ok(payload)
        }
        "reveal" => {
            let path = reveal_path(&store.workspaces(), args)?;
            Ok(reveal::reveal_value(&SystemOpener, &path, state.as_deref()))
        }
        other => Err(("unknown_method".to_string(), format!("unknown method {other}"))),
    }
}

/// 调用处理器：解析调用帧 `env`，领域错误映射为协议错误。
struct Handler {
    store: Arc<Mutex<Store>>,
}

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError> {
        let env = CallEnv::parse_value(env);
        let Ok(mut guard) = self.store.lock() else {
            return Err(ServiceError::new("internal", "store lock poisoned"));
        };
        handle_call(method, args, &env, &mut guard).map_err(ServiceError::from)
    }
}

/// 服务入口：帧循环由 SDK 起（`call` 独立线程执行，控制帧不被阻塞）。
pub fn run_loop<R: Read, W: Write + Send + 'static>(reader: R, writer: W) {
    let shared = plugin_sdk::shared_writer(writer);
    let store = Arc::new(Mutex::new(Store::open()));
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { store });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_store() -> Store {
        Store::memory(json!({
            "version": 1,
            "workspaces": [ { "id": "w1", "name": "One", "path": "C:\\ws" } ],
        }))
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "workspace");
        assert_eq!(value["implements"], json!(["workspace"]));
        assert_eq!(
            value["methods"]["workspace"],
            json!(["list", "read", "pick", "add", "remove", "reveal"])
        );
        assert_eq!(value["state"], "durable");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let mut store = memory_store();
        let err = handle_call("nope", &json!({}), &CallEnv::default(), &mut store).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn read_returns_owner_body() {
        let mut store = memory_store();
        let value = handle_call("read", &json!({}), &CallEnv::default(), &mut store).unwrap();
        assert_eq!(value["workspaces"][0]["id"], "w1");
    }

    #[test]
    fn add_writes_store() {
        let mut store = Store::memory(json!({ "version": 1, "workspaces": [] }));
        let target = std::env::temp_dir().join(format!("chrono-ws-proto-{}", std::process::id()));
        std::fs::create_dir_all(&target).unwrap();
        let args = json!({ "slot": { "kind": "workspace.add", "workspace": "w9", "path": target.to_string_lossy() } });
        let value = handle_call("add", &args, &CallEnv::default(), &mut store).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(store.workspaces()[0]["id"], "w9");
        let _ = std::fs::remove_dir_all(&target);
    }

    #[test]
    fn remove_writes_store() {
        let mut store = memory_store();
        let args = json!({ "slot": { "kind": "workspace.remove", "workspace": "w1" } });
        let value = handle_call("remove", &args, &CallEnv::default(), &mut store).unwrap();
        assert_eq!(value["removed"], true);
        assert!(store.workspaces().is_empty());
    }

    #[test]
    fn reveal_without_resolvable_workspace_is_bad_args() {
        let mut store = memory_store();
        let err = handle_call("reveal", &json!({"workspace": "w"}), &CallEnv::default(), &mut store)
            .unwrap_err();
        assert_eq!(err.0, "bad_args");
        // 未校验的 args.path 不再被接受。
        let err = handle_call(
            "reveal",
            &json!({"workspace": "w", "path": "C:\\anywhere"}),
            &CallEnv::default(),
            &mut store,
        )
        .unwrap_err();
        assert_eq!(err.0, "bad_args");
    }

    #[test]
    fn reveal_path_resolves_from_owner_list() {
        let workspaces = vec![json!({ "id": "w1", "path": "C:\\ws" })];
        assert_eq!(reveal_path(&workspaces, &json!({ "workspace": "w1" })).unwrap(), "C:\\ws");
    }
}
