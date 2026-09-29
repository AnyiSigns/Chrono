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
    pub fn workspace_id(&self) -> String {
        string_of(&self.body, "workspace_id")
    }

    pub fn outcome(&self) -> String {
        string_of(&self.body, "outcome")
    }

    pub fn run(&self) -> String {
        string_of(&self.body, "run")
    }

    pub fn id(&self) -> String {
        string_of(&self.body, "id")
    }

    pub fn steps(&self) -> &[Value] {
        self.body
            .get("steps")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn refused_at(&self) -> Option<&Value> {
        self.body.get("refused_at").filter(|value| !value.is_null())
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

fn string_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn entries_rebuild_from_line_form() {
        let value = json!([
            {"def": "t0", "body": {"run": "r1", "outcome": "done"}},
            {"def": null, "body": {"run": "r2", "outcome": "refused"}}
        ]);
        let entries = entries(&value);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].def.as_deref(), Some("t0"));
        assert_eq!(entries[0].run(), "r1");
        assert_eq!(entries[1].outcome(), "refused");
        assert!(entries[1].refused_at().is_none());
    }
}
