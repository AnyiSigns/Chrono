// 链窗口条目视图：由 `evolve-ledger.read-chain` 回包的 `{def, body}` 重建。
// shadow 只消费轨迹窗口（配对 `trace.eff_log`）；链式回溯 / 投影归一全在 `evolve-ledger`。

use serde_json::Value;

/// 一条轨迹条目：`def` 是条目 def 哈希，`body` 是条目本体。
#[derive(Clone, Debug)]
pub struct TraceRef {
    pub def: Option<String>,
    pub body: Value,
}

impl TraceRef {
    pub fn steps(&self) -> &[Value] {
        self.body
            .get("steps")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
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
        let value = json!([{"def": "t0", "body": {"steps": [{"node_index": 0}]}}]);
        let entries = entries(&value);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].steps().len(), 1);
    }
}
