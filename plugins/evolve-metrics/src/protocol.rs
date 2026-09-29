// `evolve-metrics` 服务进程协议面：四方法门禁 + 委派（aggregate / record → evolve-evidence；
// sweep → evolve-sweep；shadow → evolve-shadow）。帧编解码 / 控制帧 / 线程派发 / 反向调用应答结算走 plugin-sdk。
// stdout 只发协议帧，日志走 stderr；门面不读投影、无写通道：一切输入随调用 args 传入。

use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use plugin_sdk::{
    PortLink, ServiceError as SdkError, ServiceHandler, ServiceSpec, SharedWriter,
};

use crate::port::{Providers, RemoteProviders};

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "evolve-metrics";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算（门面无自有状态；基线缓存随 `evolve-evidence`）。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 4] = ["aggregate", "sweep", "shadow", "record"];

/// 门面反向调用等待上限：须严格大于下游提供方声明的 `method_timeouts`（含嵌套台账一跳）。
const FORWARD_TIMEOUT_MS: u64 = 200_000;

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: IDENTITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务运行期依赖：提供方调用面。
pub struct ServiceCtx {
    pub providers: Arc<dyn Providers>,
}

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    plugin_sdk::manifest(&SPEC)
}

/// 方法 → (提供方能力类, 提供方方法)。
fn route(method: &str) -> Option<(&'static str, &'static str)> {
    match method {
        "aggregate" => Some(("evolve-evidence", "aggregate")),
        "record" => Some(("evolve-evidence", "record")),
        "sweep" => Some(("evolve-sweep", "sweep")),
        "shadow" => Some(("evolve-shadow", "shadow")),
        _ => None,
    }
}

/// 处理 `call`：能力类门禁 + 委派。
pub fn handle_call(
    method: &str,
    args: &Value,
    env: &Value,
    ctx: &ServiceCtx,
) -> Result<Value, (String, String)> {
    let Some((capability, provider_method)) = route(method) else {
        return Err((
            "unknown_method".to_string(),
            format!("unknown method {method}"),
        ));
    };
    // 反向 port.call 不携带调用帧 env：门面把帧 env 注入 bag.__env，供提供方取 run / thread / now。
    let mut forwarded = args.clone();
    if let Some(object) = forwarded.as_object_mut() {
        object.insert("__env".to_string(), env.clone());
    }
    ctx.providers
        .call(capability, provider_method, &forwarded)
        .map_err(|error| (error.code, error.message))
}

/// 调用处理器：反向调用通道（应答结算 / 关闭收口）。
struct Handler {
    ctx: Arc<ServiceCtx>,
    link: Arc<PortLink>,
}

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, SdkError> {
        handle_call(method, args, env, &self.ctx).map_err(SdkError::from)
    }

    fn intercept(&self, frame: &Value) -> bool {
        self.link.settle(frame)
    }

    fn on_close(&self) {
        self.link.fail_all("transport_failed");
    }
}

/// 服务入口：帧循环由 SDK 起（`call` 独立线程执行，控制帧不被阻塞）。
pub fn run_loop<R: Read, W: Write + Send + 'static>(reader: R, writer: W) {
    let shared: SharedWriter = plugin_sdk::shared_writer(writer);
    let link = Arc::new(PortLink::with_timeout(
        Arc::clone(&shared),
        "evolve-metrics",
        Duration::from_millis(FORWARD_TIMEOUT_MS),
    ));
    let ctx = Arc::new(ServiceCtx {
        providers: Arc::new(RemoteProviders::new(Arc::clone(&link))),
    });
    run_loop_with(reader, shared, link, ctx);
}

/// 帧循环主体；依赖可注入（测试注入捕获提供方）。
fn run_loop_with<R: Read>(reader: R, shared: SharedWriter, link: Arc<PortLink>, ctx: Arc<ServiceCtx>) {
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { ctx, link });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    /// 捕获提供方：记录委派目标与入参，回预设值。
    struct CapturingProviders {
        last: Mutex<Option<(String, String, Value)>>,
        value: Value,
    }

    impl CapturingProviders {
        fn new(value: Value) -> Self {
            Self {
                last: Mutex::new(None),
                value,
            }
        }
    }

    impl Providers for CapturingProviders {
        fn call(&self, capability: &str, method: &str, args: &Value) -> Result<Value, crate::error::ServiceError> {
            *self.last.lock().unwrap() = Some((capability.to_string(), method.to_string(), args.clone()));
            Ok(self.value.clone())
        }
    }

    fn ctx(value: Value) -> ServiceCtx {
        ServiceCtx {
            providers: Arc::new(CapturingProviders::new(value)),
        }
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "evolve-metrics");
        assert_eq!(value["implements"], json!(["evolve-metrics"]));
        assert_eq!(
            value["methods"]["evolve-metrics"],
            json!(["aggregate", "sweep", "shadow", "record"])
        );
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn routes_each_method_to_its_provider() {
        for (method, capability) in [
            ("aggregate", "evolve-evidence"),
            ("record", "evolve-evidence"),
            ("sweep", "evolve-sweep"),
            ("shadow", "evolve-shadow"),
        ] {
            let providers = Arc::new(CapturingProviders::new(json!({"ok": true})));
            let ctx = ServiceCtx { providers: providers.clone() };
            let value = handle_call(method, &json!({"n": 1}), &json!({"run": "r1"}), &ctx).unwrap();
            assert_eq!(value["ok"], true);
            let last = providers.last.lock().unwrap().clone().unwrap();
            assert_eq!(last.0, capability);
            assert_eq!(last.1, method);
        }
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &json!({}), &ctx(json!({}))).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn forwards_frame_env_into_bag() {
        let providers = Arc::new(CapturingProviders::new(json!({"ok": true})));
        let ctx = ServiceCtx { providers: providers.clone() };
        let _ = handle_call("shadow", &json!({"audit": []}), &json!({"run": "r9"}), &ctx).unwrap();
        let last = providers.last.lock().unwrap().clone().unwrap();
        assert_eq!(last.0, "evolve-shadow");
        assert_eq!(last.1, "shadow");
        assert_eq!(last.2["__env"]["run"], "r9");
        assert_eq!(last.2["audit"], json!([]));
    }
}
