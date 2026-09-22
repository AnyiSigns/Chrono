// 服务侧结构化错误：反向调用（host.audit）失败作数据、不抛错、不断通道。

/// 结构化错误：`code` 与协议 / 内核错误码同词表，`message` 人读。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceError {
    pub code: String,
    pub message: String,
}

impl ServiceError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ServiceError {}
