// `embedding-local` 服务进程协议面：方法分派（embed / describe-models）；帧编解码 / 控制帧 /
// 线程派发 / 反向调用应答结算走 plugin-sdk。stdout 只发协议帧，日志走 stderr；服务不读投影、
// 无写通道：所需输入全由调用方随 bag 传入；分词经反向调用 `tokenizer.encode`。

use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::{CallEnv, PortLink, ServiceError, ServiceHandler, ServiceSpec, SharedWriter};

use crate::model::{self, TokenizerPort};
use crate::port::RemoteTokenizer;

/// 身份名（提供方）；能力类由扩展点拥有方 `embedding` 声明为 `embedding-provider`。
pub const IDENTITY: &str = "embedding-local";
/// 本提供方接入的扩展类名。
pub const CAPABILITY: &str = "embedding-provider";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 2] = ["embed", "describe-models"];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: CAPABILITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    plugin_sdk::manifest(&SPEC)
}

/// 处理 `call`：能力类 / 方法 / args 形态门禁 + 方法分派。
pub fn handle_call(
    method: &str,
    args: &Value,
    _env: &CallEnv,
    tokenizer: &dyn TokenizerPort,
) -> Result<Value, (String, String)> {
    match method {
        "embed" => handle_embed(args, tokenizer),
        "describe-models" => Ok(describe_models()),
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

/// 本提供方支持的模型清单（供门面 `embedding` 按 model 选成员）。
fn describe_models() -> Value {
    json!({
        "models": [{ "model": model::MODEL_ID, "dim": model::DIM }],
    })
}

fn handle_embed(args: &Value, tokenizer: &dyn TokenizerPort) -> Result<Value, (String, String)> {
    let requested_model = args
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(model::MODEL_ID);
    if requested_model != model::MODEL_ID {
        return Err((
            "unknown_model".to_string(),
            format!("unknown model {requested_model}"),
        ));
    }
    let raw_texts = args
        .get("texts")
        .and_then(Value::as_array)
        .ok_or_else(|| ("bad_args".to_string(), "texts must be an array".to_string()))?;
    let mut texts = Vec::with_capacity(raw_texts.len());
    for item in raw_texts {
        let text = item.as_str().ok_or_else(|| {
            (
                "bad_args".to_string(),
                "texts items must be strings".to_string(),
            )
        })?;
        texts.push(text.to_string());
    }
    let engine = model::engine().map_err(|error| (error.code, error.message))?;
    let vectors = engine
        .embed(&texts, tokenizer)
        .map_err(|error| (error.code, error.message))?;
    Ok(json!({
        "model": model::MODEL_ID,
        "dim": model::DIM,
        "vectors": vectors,
    }))
}

/// 调用处理器：反向调用通道（`tokenizer.encode` 发起 + 应答结算 / 关闭收口）。
struct Handler {
    link: Arc<PortLink>,
}

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError> {
        let tokenizer = RemoteTokenizer::new(Arc::clone(&self.link));
        let env = CallEnv::parse_value(env);
        handle_call(method, args, &env, &tokenizer).map_err(ServiceError::from)
    }

    fn intercept(&self, frame: &Value) -> bool {
        self.link.settle(frame)
    }

    fn on_close(&self) {
        self.link.fail_all("transport_failed");
    }
}

/// 服务入口：帧循环由 SDK 起（`call` 独立线程执行，控制帧不被阻塞）。
pub fn run_loop<R: std::io::Read, W: std::io::Write + Send + 'static>(reader: R, writer: W) {
    let shared: SharedWriter = plugin_sdk::shared_writer(writer);
    let link = Arc::new(PortLink::new(Arc::clone(&shared), "embedding-local"));
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { link });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::test_tokenizer;

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "embedding-local");
        assert_eq!(value["implements"], json!(["embedding-provider"]));
        assert_eq!(
            value["methods"]["embedding-provider"],
            json!(["embed", "describe-models"])
        );
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn describe_models_lists_granite() {
        let value = describe_models();
        assert_eq!(value["models"][0]["model"], "granite-97m");
        assert_eq!(value["models"][0]["dim"], 384);
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call(
            "nope",
            &json!({}),
            &CallEnv::default(),
            test_tokenizer(),
        )
        .unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn embed_rejects_bad_args_and_unknown_model() {
        assert_eq!(
            handle_call(
                "embed",
                &json!({"texts": "nope"}),
                &CallEnv::default(),
                test_tokenizer()
            )
            .unwrap_err()
            .0,
            "bad_args"
        );
        assert_eq!(
            handle_call(
                "embed",
                &json!({"texts": ["hi"], "model": "other"}),
                &CallEnv::default(),
                test_tokenizer()
            )
            .unwrap_err()
            .0,
            "unknown_model"
        );
    }

    #[test]
    fn embed_returns_model_dim_and_vectors() {
        let value = handle_call(
            "embed",
            &json!({"texts": ["hello", "你好"]}),
            &CallEnv::default(),
            test_tokenizer(),
        )
        .unwrap();
        assert_eq!(value["model"], "granite-97m");
        assert_eq!(value["dim"], 384);
        assert_eq!(value["vectors"].as_array().unwrap().len(), 2);
        assert_eq!(value["vectors"][0].as_array().unwrap().len(), 384);
    }
}
