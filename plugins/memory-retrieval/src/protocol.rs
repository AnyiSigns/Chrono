// `memory-retrieval` 服务进程协议面：方法分派（search）；帧编解码 / 控制帧 / 线程派发 /
// 反向调用应答结算走 plugin-sdk。stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：
// 所需世界数据全由调用方随 bag 传入；反向调用 embedding / memory / query-plan / rerank 四个 pin。

use std::io::{Read, Write};
use std::sync::Arc;

use serde_json::Value;

use plugin_sdk::{PortLink, ServiceError, ServiceHandler, ServiceSpec, SharedWriter};

use crate::port::{
    EmbeddingPort, MemoryPort, Ports, QueryPlanPort, RemoteEmbedding, RemoteMemory,
    RemoteQueryPlan, RemoteRerank, RerankPort,
};
use crate::retrieve;
use crate::state::{FileStateStore, StateStore};

/// 身份名。
pub const IDENTITY: &str = "memory-retrieval";
/// 能力类名（= 方法声明的能力类）。
pub const CAPABILITY: &str = "retrieval";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 1] = ["search"];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: CAPABILITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务运行期依赖：四个反向调用面 + ③ 查询向量缓存。
pub struct ServiceCtx {
    pub embedding: Arc<dyn EmbeddingPort>,
    pub memory: Arc<dyn MemoryPort>,
    pub query_plan: Arc<dyn QueryPlanPort>,
    pub rerank: Arc<dyn RerankPort>,
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
        "search" => {
            let ports = Ports {
                embedding: ctx.embedding.as_ref(),
                memory: ctx.memory.as_ref(),
                query_plan: ctx.query_plan.as_ref(),
                rerank: ctx.rerank.as_ref(),
            };
            retrieve::run(args, env, &ports, ctx.state.as_ref())
        }
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
    let link = Arc::new(PortLink::new(Arc::clone(&shared), "memory-retrieval"));
    let ctx = Arc::new(ServiceCtx {
        embedding: Arc::new(RemoteEmbedding::new(Arc::clone(&link))),
        memory: Arc::new(RemoteMemory::new(Arc::clone(&link))),
        query_plan: Arc::new(RemoteQueryPlan::new(Arc::clone(&link))),
        rerank: Arc::new(RemoteRerank::new(Arc::clone(&link))),
        state: Arc::new(FileStateStore::from_env()),
    });
    run_loop_with(reader, shared, link, ctx);
}

/// 帧循环主体；依赖可注入（生产为真实通道，测试注入假实现 / 内存缓存）。
fn run_loop_with<R: Read>(reader: R, shared: SharedWriter, link: Arc<PortLink>, ctx: Arc<ServiceCtx>) {
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { ctx, link });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{FakeEmbedding, FakeMemory, FakeQueryPlan, FakeRerank};
    use crate::state::MemoryStateStore;
    use serde_json::json;
    use std::collections::BTreeMap;

    fn test_ctx() -> ServiceCtx {
        ServiceCtx {
            embedding: Arc::new(FakeEmbedding::new(4)),
            memory: Arc::new(FakeMemory::new(Vec::new(), BTreeMap::new())),
            query_plan: Arc::new(FakeQueryPlan),
            rerank: Arc::new(FakeRerank),
            state: Arc::new(MemoryStateStore::new()),
        }
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "memory-retrieval");
        assert_eq!(value["implements"], json!(["retrieval"]));
        assert_eq!(value["methods"]["retrieval"], json!(["search"]));
        assert_eq!(value["state"], "recomputable");
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &json!({}), &test_ctx()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn search_call_returns_empty_recall() {
        let value =
            handle_call("search", &json!({"query": "note"}), &json!({}), &test_ctx()).unwrap();
        assert_eq!(value["kind"], "search");
        assert!(value["recall"].as_array().unwrap().is_empty());
    }
}
