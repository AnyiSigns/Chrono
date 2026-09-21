// 结构化错误：code + 人读 message。服务错误面统一 `{ok:false, error:{code, message}}`，
// sandbox 的 `{ok:false, code, message}` 在此原样搬运（不吞、不改写）。

/// 一次工具调用 / 反向调用的结构化失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub code: String,
    pub message: String,
}

impl ToolError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
