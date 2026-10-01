// 反向调用通道（服务 → 宿主，docs/protocol.md §2.4）与 fsop 后端抽象。
// 通道编解码 / 登记结算走 plugin-sdk 的 `PortLink`；本模块只留 fsop 领域适配：
// 本插件所有触盘经 `port.call` 到 `sandbox.fsop`，失败作数据（ToolError），不抛错、不断通道。
// 单测用可注入的假后端替换真实通道。

use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::{PortLink, ServiceError};

use crate::error::ToolError;

/// 触盘后端抽象：生产环境是反向调用 `sandbox.fsop`，单测注入假后端。
pub trait FsopBackend: Send + Sync {
    fn fsop(&self, bag: &Value) -> Result<Value, ToolError>;

    /// `host.asset.put`：把字节（base64）内容寻址存到宿主资产区，回引用 `{kind,sha256,mime,size}`。
    /// 缺省不可用（无 host 端口的测试后端）；需要资产写的用例覆写。
    fn asset_put(&self, _mime: &str, _bytes_base64: &str) -> Result<Value, ToolError> {
        Err(ToolError::new(
            "asset_unsupported",
            "asset channel unavailable",
        ))
    }
}

/// `sandbox.fsop` 的反向调用后端。
pub struct RemoteFsop {
    link: Arc<PortLink>,
}

impl RemoteFsop {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl FsopBackend for RemoteFsop {
    fn fsop(&self, bag: &Value) -> Result<Value, ToolError> {
        let value = self
            .link
            .call("sandbox", "fsop", bag.clone())
            .map_err(service_error_to_tool)?;
        parse_fsop_response(&value)
    }

    fn asset_put(&self, mime: &str, bytes_base64: &str) -> Result<Value, ToolError> {
        let value = self
            .link
            .call(
                "host",
                "asset.put",
                json!({ "mime": mime, "bytes": bytes_base64 }),
            )
            .map_err(service_error_to_tool)?;
        Ok(unwrap_endpoint_value(value))
    }
}

/// 宿主保留能力端点返回可能是 `{ok:true, value}` 包装或裸值；统一取内层（资产引用本身无 `value` 键）。
fn unwrap_endpoint_value(value: Value) -> Value {
    if value.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        if let Some(inner) = value.get("value") {
            return inner.clone();
        }
    }
    value
}

/// 反向调用错误码词表与工具错误同源：原样搬运，不吞、不改写。
fn service_error_to_tool(error: ServiceError) -> ToolError {
    ToolError::new(error.code, error.message)
}

/// fsop 方法值 `{ok:true, op, result}` / `{ok:false, code, message}` → 结果或结构化错误。
pub fn parse_fsop_response(value: &Value) -> Result<Value, ToolError> {
    if value.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
    Err(ToolError::new(
        value
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("tool_failed"),
        value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("fsop failed"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_fsop_response_passthrough() {
        let ok = parse_fsop_response(&json!({"ok": true, "result": {"paths": []}})).unwrap();
        assert_eq!(ok["paths"], json!([]));
        let denied = parse_fsop_response(&json!({
            "ok": false, "code": "fs_denied", "message": "outside",
        }))
        .unwrap_err();
        assert_eq!(denied.code, "fs_denied");
        assert_eq!(denied.message, "outside");
    }
}
