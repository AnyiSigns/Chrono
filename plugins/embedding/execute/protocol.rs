// `embedding` 服务进程协议面：方法分派（embed）；帧编解码 / 控制帧 / 线程派发 /
// 反向调用应答结算走 plugin-sdk。stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：
// 所需输入全由调用方随 bag 传入；向量化经反向 `port.call embedding-provider.embed`（带 provider）。

use std::sync::Arc;

use serde_json::Value;

use plugin_sdk::{PortLink, ServiceError, ServiceHandler, ServiceSpec, SharedWriter};

use crate::selector::{Selector, SelectorError, CAPABILITY};

/// 身份名 = 对外能力类名（门面保留原公开面）。
pub const IDENTITY: &str = "embedding";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 1] = ["embed"];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: IDENTITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 处理 `embed`：解析 texts / model，选提供方后带 `provider` 反向调用其 `embed`。
pub fn handle_embed(
    args: &Value,
    selector: &Selector,
) -> Result<Value, SelectorError> {
    let raw_texts = args.get("texts").and_then(Value::as_array).ok_or_else(|| {
        SelectorError::new("bad_args", "texts must be an array")
    })?;
    let mut texts = Vec::with_capacity(raw_texts.len());
    for item in raw_texts {
        let text = item
            .as_str()
            .ok_or_else(|| SelectorError::new("bad_args", "texts items must be strings"))?;
        texts.push(text.to_string());
    }
    let requested = args.get("model").and_then(Value::as_str);
    let selected = selector.resolve(requested)?;
    selector.embed(&selected, &texts)
}

/// 调用处理器：反向调用通道（`embedding-provider.*` 发起 + 应答结算 / 关闭收口）。
struct Handler {
    link: Arc<PortLink>,
    selector: Arc<Selector>,
}

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, _env: &Value) -> Result<Value, ServiceError> {
        match method {
            "embed" => handle_embed(args, &self.selector)
                .map_err(|error| ServiceError::new(error.code, error.message)),
            other => Err(ServiceError::new(
                "unknown_method",
                format!("unknown method {other}"),
            )),
        }
    }

    fn intercept(&self, frame: &Value) -> bool {
        self.link.settle(frame)
    }

    fn on_close(&self) {
        self.link.fail_all("transport_failed");
    }
}

/// 服务入口：帧循环由 SDK 起（`call` 独立线程执行，控制帧不被阻塞）。
/// `embedding-provider` 成员表由宿主按世界能力索引注入（stdio 走 `CHRONO_PLUGIN_MANY_NEEDS`）。
pub fn run_loop<R: std::io::Read, W: std::io::Write + Send + 'static>(reader: R, writer: W) {
    let shared: SharedWriter = plugin_sdk::shared_writer(writer);
    let link = Arc::new(PortLink::new(Arc::clone(&shared), "embedding"));
    let members = plugin_sdk::many_needs_from_env()
        .and_then(|mut table| table.remove(CAPABILITY))
        .unwrap_or_default();
    let selector = Arc::new(Selector::new(Arc::clone(&link), members));
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { link, selector });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifest_matches_declaration() {
        let value = plugin_sdk::manifest(&SPEC);
        assert_eq!(value["identity"], "embedding");
        assert_eq!(value["implements"], json!(["embedding"]));
        assert_eq!(value["methods"]["embedding"], json!(["embed"]));
        assert_eq!(value["state"], "recomputable");
    }
}
