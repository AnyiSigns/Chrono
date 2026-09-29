// `tokenizer` 服务进程协议面：方法分派（encode / chunk）；帧编解码 / 控制帧 / 线程派发走 plugin-sdk。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需输入全由调用方随 bag 传入。

use serde_json::{json, Value};

use plugin_sdk::{CallEnv, ServiceError, ServiceHandler, ServiceSpec};

use crate::chunk;
use crate::tokenizer;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "tokenizer";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 2] = ["encode", "chunk"];

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

/// 处理 `call`：能力类 / 方法 / args 形态门禁 + 方法分派。
pub fn handle_call(method: &str, args: &Value, _env: &CallEnv) -> Result<Value, (String, String)> {
    match method {
        "encode" => handle_encode(args),
        "chunk" => handle_chunk(args),
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

fn parse_text(args: &Value) -> Result<&str, (String, String)> {
    args.get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| ("bad_args".to_string(), "text must be a string".to_string()))
}

fn handle_encode(args: &Value) -> Result<Value, (String, String)> {
    let text = parse_text(args)?;
    let add_special_tokens = args
        .get("add_special_tokens")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let tokenizer =
        tokenizer::shared().map_err(|message| ("tokenizer_load_failed".to_string(), message))?;
    let encoding = tokenizer
        .encode(text, add_special_tokens)
        .map_err(|err| ("tokenize_failed".to_string(), err.to_string()))?;
    let offsets: Vec<[usize; 2]> = encoding
        .get_offsets()
        .iter()
        .map(|(start, end)| [*start, *end])
        .collect();
    Ok(json!({
        "ids": encoding.get_ids(),
        "mask": encoding.get_attention_mask(),
        "offsets": offsets,
    }))
}

fn handle_chunk(args: &Value) -> Result<Value, (String, String)> {
    let text = parse_text(args)?;
    let options = chunk::parse_options(args)?;
    let tokenizer =
        tokenizer::shared().map_err(|message| ("tokenizer_load_failed".to_string(), message))?;
    let chunks = chunk::chunk_text(tokenizer, text, &options)?;
    Ok(Value::Array(chunks))
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
        assert_eq!(value["identity"], "tokenizer");
        assert_eq!(value["implements"], json!(["tokenizer"]));
        assert_eq!(value["methods"]["tokenizer"], json!(["encode", "chunk"]));
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &CallEnv::default()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn encode_rejects_bad_args() {
        assert_eq!(
            handle_call("encode", &json!({}), &CallEnv::default())
                .unwrap_err()
                .0,
            "bad_args"
        );
    }

    #[test]
    fn chunk_rejects_bad_args() {
        assert_eq!(
            handle_call("chunk", &json!({}), &CallEnv::default())
                .unwrap_err()
                .0,
            "bad_args"
        );
        assert_eq!(
            handle_call(
                "chunk",
                &json!({"text": "x", "window": 4, "overlap": 9}),
                &CallEnv::default()
            )
            .unwrap_err()
            .0,
            "bad_args"
        );
    }

    #[test]
    fn encode_returns_ids_mask_offsets() {
        let value = handle_call("encode", &json!({"text": "你好，world"}), &CallEnv::default())
            .unwrap();
        let ids = value["ids"].as_array().unwrap();
        let mask = value["mask"].as_array().unwrap();
        let offsets = value["offsets"].as_array().unwrap();
        assert!(ids.len() > 2);
        assert_eq!(mask.len(), ids.len());
        assert_eq!(offsets.len(), ids.len());
        // 缺省 add_special_tokens=true：后处理固定加 <|startoftext|>(CLS) 与 <|return|>(EOS)。
        assert_eq!(ids[0], 179934);
        assert_eq!(*ids.last().unwrap(), 179938);
        assert_eq!(*mask.first().unwrap(), 1);
    }

    #[test]
    fn encode_can_omit_special_tokens() {
        let value = handle_call(
            "encode",
            &json!({"text": "你好，world", "add_special_tokens": false}),
            &CallEnv::default(),
        )
        .unwrap();
        let ids = value["ids"].as_array().unwrap();
        assert_ne!(ids[0], 179934);
        assert_ne!(*ids.last().unwrap(), 179938);
    }

    #[test]
    fn chunk_returns_codepoint_offsets() {
        let value = handle_call(
            "chunk",
            &json!({"text": "你好，world", "window": 512, "overlap": 64}),
            &CallEnv::default(),
        )
        .unwrap();
        let chunks = value.as_array().unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0]["start"], 0);
        assert_eq!(chunks[0]["end"], "你好，world".chars().count());
        assert_eq!(chunks[0]["text"], "你好，world");
    }
}
