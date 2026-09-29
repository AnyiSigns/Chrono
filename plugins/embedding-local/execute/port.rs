// 反向调用适配（服务 → 宿主，docs/protocol.md §2.4）：`embedding-local` 自身不做分词，
// 经 `port.call tokenizer.encode` 取 token ids / mask（`needs.tokenizer: one`）。
// 通道编解码 / 登记结算走 plugin-sdk 的 `PortLink`；本模块只留领域适配。
// 失败作数据（ModelError），不抛错、不断通道。

use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::PortLink;

use crate::model::{Encoded, ModelError, TokenizerPort};

/// `tokenizer.encode` 的反向调用后端：成功回 {ids, mask, offsets}，本服务只用 ids / mask。
pub struct RemoteTokenizer {
    link: Arc<PortLink>,
}

impl RemoteTokenizer {
    pub fn new(link: Arc<PortLink>) -> Self {
        Self { link }
    }
}

impl TokenizerPort for RemoteTokenizer {
    fn encode(&self, text: &str, add_special_tokens: bool) -> Result<Encoded, ModelError> {
        let value = self
            .link
            .call(
                "tokenizer",
                "encode",
                json!({ "text": text, "add_special_tokens": add_special_tokens }),
            )
            .map_err(|error| ModelError::new(&error.code, error.message))?;
        Ok(Encoded {
            ids: parse_i64_array(&value, "ids")?,
            mask: parse_i64_array(&value, "mask")?,
        })
    }
}

/// 解析 `tokenizer.encode` 结果里的整数数组字段。
fn parse_i64_array(value: &Value, field: &str) -> Result<Vec<i64>, ModelError> {
    let raw = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| ModelError::new("tokenizer_bad_result", format!("tokenizer.encode returned no {field}")))?;
    let mut out = Vec::with_capacity(raw.len());
    for item in raw {
        let number = item.as_i64().ok_or_else(|| {
            ModelError::new(
                "tokenizer_bad_result",
                format!("tokenizer.encode {field} has a non-integer"),
            )
        })?;
        out.push(number);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_i64_array_reads_integers() {
        assert_eq!(
            parse_i64_array(&json!({"ids": [1, 2, 3]}), "ids").unwrap(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn parse_i64_array_rejects_bad_shape() {
        assert_eq!(
            parse_i64_array(&json!({}), "ids").unwrap_err().code,
            "tokenizer_bad_result"
        );
        assert_eq!(
            parse_i64_array(&json!({"ids": ["x"]}), "ids")
                .unwrap_err()
                .code,
            "tokenizer_bad_result"
        );
    }
}
