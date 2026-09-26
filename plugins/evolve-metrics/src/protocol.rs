// `evolve-metrics` 服务进程协议面：方法分派（aggregate / sweep / shadow / record）；
// 帧编解码 / 控制帧 / 线程派发 / 反向调用应答结算走 plugin-sdk。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 bag 传入。

use std::io::{Read, Write};
use std::sync::Arc;

use serde_json::Value;

use plugin_sdk::{PortLink, ServiceError, ServiceHandler, ServiceSpec, SharedWriter};

use crate::aggregate;
use crate::port::{AuditSource, EventSink, RemoteAudit, WriterEventSink};
use crate::record;
use crate::shadow;
use crate::state::{FileStateStore, StateStore};
use crate::sweep;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "evolve-metrics";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 4] = ["aggregate", "sweep", "shadow", "record"];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: IDENTITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务运行期依赖：上行事件、历史审计读面、③ 缓存。
pub struct ServiceCtx {
    pub events: Arc<dyn EventSink>,
    pub audit: Arc<dyn AuditSource>,
    pub state: Arc<dyn StateStore>,
}

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    plugin_sdk::manifest(&SPEC)
}

/// 处理 `call`：能力类门禁 + 方法分派。
pub fn handle_call(
    method: &str,
    args: &Value,
    env: &Value,
    ctx: &ServiceCtx,
) -> Result<Value, (String, String)> {
    match method {
        "aggregate" => aggregate::run(args, env, ctx.events.as_ref(), ctx.state.as_ref()),
        "sweep" => sweep::run(args, env),
        "shadow" => shadow::run(args, env, ctx.audit.as_ref()),
        "record" => record::run(args, env),
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

/// 调用处理器：领域依赖 + 反向调用通道（应答结算 / 关闭收口）。
struct Handler {
    ctx: Arc<ServiceCtx>,
    link: Arc<PortLink>,
}

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError> {
        handle_call(method, args, env, &self.ctx).map_err(ServiceError::from)
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
    let link = Arc::new(PortLink::new(Arc::clone(&shared), "evolve-metrics"));
    let ctx = Arc::new(ServiceCtx {
        events: Arc::new(WriterEventSink::new(Arc::clone(&shared))),
        audit: Arc::new(RemoteAudit::new(Arc::clone(&link))),
        state: Arc::new(FileStateStore::from_env()),
    });
    run_loop_with(reader, shared, link, ctx);
}

/// 帧循环主体；依赖可注入（生产为真实通道，测试注入捕获 sink / 静态审计 / 内存缓存）。
fn run_loop_with<R: Read>(reader: R, shared: SharedWriter, link: Arc<PortLink>, ctx: Arc<ServiceCtx>) {
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { ctx, link });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{CapturingEventSink, StaticAudit};
    use crate::state::MemoryStateStore;
    use serde_json::json;

    fn test_ctx() -> ServiceCtx {
        ServiceCtx {
            events: Arc::new(CapturingEventSink::new()),
            audit: Arc::new(StaticAudit::new(Vec::new())),
            state: Arc::new(MemoryStateStore::new()),
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
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &json!({}), &test_ctx()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn aggregate_call_returns_evidence_and_plan() {
        let bag = json!({
            "trace_entries": [{"kind":"trace","run":"r1","workspace_id":"w1","outcome":"refused",
                "refused_at":{"node_index":1,"code":"capability_mismatch","attributable_to":"graph"}}],
            "thresholds": {"failure_cluster_n": 1},
            "evolution": {"version":1,"trace":{"tail":null,"count":0},
                "evidence":{"tail":null,"count":0},"proposals":{"tail":null,"count":0},
                "verdicts":{"tail":null,"count":0}}
        });
        let value = handle_call("aggregate", &bag, &json!({"now": 5}), &test_ctx()).unwrap();
        assert_eq!(value["evidence"].as_array().unwrap().len(), 1);
        assert_eq!(value["evidence"][0]["class"], "failure_cluster");
        assert!(!value["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn empty_trace_returns_empty_set() {
        let value = handle_call("aggregate", &json!({}), &json!({}), &test_ctx()).unwrap();
        assert!(value["evidence"].as_array().unwrap().is_empty());
        assert!(value["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn record_call_returns_evidence_id_and_plan() {
        let bag = json!({
            "user_message_def": {"def": "msg-hash"},
            "workspace_id": "w1",
            "evolution": {"version":1,"trace":{"tail":null,"count":0},
                "evidence":{"tail":null,"count":0},"proposals":{"tail":null,"count":0},
                "verdicts":{"tail":null,"count":0}}
        });
        let value = handle_call("record", &bag, &json!({"run": "r9"}), &test_ctx()).unwrap();
        assert!(value["evidence_id"].as_str().unwrap().starts_with("ev-"));
        assert!(!value["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn record_without_user_message_is_bad_args() {
        let err = handle_call("record", &json!({"workspace_id": "w1"}), &json!({}), &test_ctx())
            .unwrap_err();
        assert_eq!(err.0, "bad_args");
    }
}
