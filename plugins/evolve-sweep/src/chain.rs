// 链窗口条目视图：由 `evolve-ledger.read-chain` 回包的 `{def, body}` 重建。
// 本插件不读投影、不做链解析——链式回溯 / retained 边界 / 投影归一全在 `evolve-ledger`。

use serde_json::Value;

/// 一条链条目：`def` 是条目 def 哈希（引用溯源用），`body` 是条目本体。
#[derive(Clone, Debug)]
pub struct TraceRef {
    pub def: Option<String>,
    pub body: Value,
}

impl TraceRef {
    pub fn id(&self) -> String {
        self.body.get("id").and_then(Value::as_str).unwrap_or("").to_string()
    }
}

/// 从 `read-chain` 回包的条目数组重建窗口条目。
pub fn entries(value: &Value) -> Vec<TraceRef> {
    value
        .as_array()
        .map(|items| items.iter().map(from_item).collect())
        .unwrap_or_default()
}

fn from_item(item: &Value) -> TraceRef {
    TraceRef {
        def: item.get("def").and_then(Value::as_str).map(str::to_string),
        body: item.get("body").cloned().unwrap_or(Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn entries_rebuild_from_line_form() {
        let value = json!([{"def": "e0", "body": {"id": "ev-0"}}]);
        let entries = entries(&value);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].def.as_deref(), Some("e0"));
        assert_eq!(entries[0].id(), "ev-0");
    }
}
