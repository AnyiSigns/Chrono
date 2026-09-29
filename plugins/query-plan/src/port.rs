// 反向调用通道（服务 → 宿主）与依赖抽象：model.chat。
// 通道编解码 / 登记结算走 plugin-sdk 的 `PortLink`；本模块只留领域适配。
// 反向调用失败作数据、不抛错、不断通道；单测 / 集成测试用可注入的假实现替换真实通道。

use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::PortLink;

use crate::error::ServiceError;

/// 模型面（model.chat）：多查询子查询生成（默认关）。
pub trait ModelPort: Send + Sync {
    fn chat(&self, args: Value) -> Result<Value, ServiceError>;
}

/// 查询规划的依赖集合。
pub struct Ports<'a> {
    pub model: &'a dyn ModelPort,
}

/// 反向调用错误码词表与领域错误同源：原样搬运，不吞、不改写。
fn service_error(error: plugin_sdk::ServiceError) -> ServiceError {
    ServiceError::new(&error.code, error.message)
}

/// 经反向调用 `model.chat` 做多查询生成。
pub struct RemoteModel {
    link: Arc<PortLink>,
}

impl RemoteModel {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl ModelPort for RemoteModel {
    fn chat(&self, args: Value) -> Result<Value, ServiceError> {
        self.link.call("model", "chat", args).map_err(service_error)
    }
}

/// 调用 model.chat 取文本回复。
pub fn chat_text(
    ports: &Ports<'_>,
    model_config: &Value,
    prompt: &str,
) -> Result<String, ServiceError> {
    let args = json!({
        "config": model_config,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let value = ports.model.chat(args)?;
    Ok(value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

/// 假模型：测试用。`chat` 固定回 `text`。
pub struct FakeModel {
    pub text: String,
}

impl FakeModel {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }
}

impl ModelPort for FakeModel {
    fn chat(&self, _args: Value) -> Result<Value, ServiceError> {
        Ok(json!({ "text": self.text }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_model_returns_fixed_text() {
        let fake = FakeModel::new("[\"a\"]");
        let ports = Ports { model: &fake };
        let text = chat_text(&ports, &json!({}), "prompt").unwrap();
        assert_eq!(text, "[\"a\"]");
    }
}
