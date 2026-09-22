// 计划值构造：服务无写通道，一切写经 `{"$directives":[…]}` 交宿主落账。
// 批内 `$n`（0 基）指向同批更早子操作的 def 键（宿主内核 `batchDigest` 机械替换），
// 故新 evolution body 的链头可引用同批 put 的条目 def。

use serde_json::{json, Value};

/// 一条 `put` 子操作（内容寻址）。
pub fn put_op(body: Value) -> Value {
    json!({ "op": "put", "args": { "body": body } })
}

/// 一条 `add_gen` 子操作：payload / sig 指向同批更早的 `put`（`$n` 0 基、四字段全必填）。
pub fn add_gen_op(id: &str, index: usize) -> Value {
    json!({ "op": "add_gen", "args": {
        "id": id, "payload": { "$n": index }, "sig": { "$n": index }, "pins": {}
    } })
}

/// 一条原子 `batch` 写 directive。
pub fn batch_directive(ops: Vec<Value>) -> Value {
    json!({ "kind": "write", "request": { "op": "batch", "args": { "ops": ops } } })
}

/// 计划值外壳：`{"$directives":[…]}`。
pub fn plan(directives: Vec<Value>) -> Value {
    json!({ "$directives": directives })
}

/// 链指针：指向同批第 `index` 条 put 的 def 键。
pub fn chain_ref(index: usize) -> Value {
    json!({ "def": { "$n": index } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn add_gen_references_put_index() {
        let op = add_gen_op("evolution", 2);
        assert_eq!(op["op"], "add_gen");
        assert_eq!(op["args"]["id"], "evolution");
        assert_eq!(op["args"]["payload"], json!({ "$n": 2 }));
        assert_eq!(op["args"]["sig"], json!({ "$n": 2 }));
        assert_eq!(op["args"]["pins"], json!({}));
    }

    #[test]
    fn plan_wraps_directives() {
        let value = plan(vec![batch_directive(vec![put_op(json!({"a": 1}))])]);
        assert_eq!(value["$directives"][0]["kind"], "write");
        assert_eq!(value["$directives"][0]["request"]["op"], "batch");
    }
}
