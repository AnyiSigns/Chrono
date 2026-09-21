// 大小 / 行窗口 / 忽略表缺省（与 `schema/tool-fs.json` 的 defaults 同形，测试保证一致）。
// 忽略表正式住本身份数据世代 body（bag.ignore）；此处只是「三者都缺省」时的机械兜底。

/// 单次输出上限（字节）：超过即截断并标记 truncated（标记，非错）。
pub const DEFAULT_OUTPUT_MAX: u64 = 1_048_576;
/// 调用超时缺省（ms），转发给 sandbox 作为资源上限。
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// 内存上限缺省（MB）。
pub const DEFAULT_MEM_MB: u64 = 1024;
/// 进程数上限缺省：文件工具不派生子进程。
pub const DEFAULT_PROCS_MAX: u64 = 1;
/// `read` 行窗口缺省（行数）。
pub const DEFAULT_READ_LIMIT: u64 = 2000;
/// `glob` 结果条数缺省。
pub const DEFAULT_LIST_LIMIT: u64 = 200;
/// `grep` 命中条数缺省。
pub const DEFAULT_GREP_LIMIT: u64 = 100;

/// 忽略表兜底：与 `schema/tool-fs.json` 的 `default_ignore` 一致。
pub const DEFAULT_IGNORE: [&str; 5] = [".git", "node_modules", "target", "__pycache__", ".venv"];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn schema_defaults_match_code() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/schema/tool-fs.json");
        let text = std::fs::read_to_string(path).expect("schema/tool-fs.json");
        let schema: Value = serde_json::from_str(&text).unwrap();
        let defaults = &schema["properties"]["defaults"]["properties"];
        assert_eq!(defaults["read_limit"]["default"], DEFAULT_READ_LIMIT);
        assert_eq!(defaults["list_limit"]["default"], DEFAULT_LIST_LIMIT);
        assert_eq!(defaults["grep_limit"]["default"], DEFAULT_GREP_LIMIT);
        assert_eq!(defaults["output_max"]["default"], DEFAULT_OUTPUT_MAX);
        assert_eq!(defaults["timeout_ms"]["default"], DEFAULT_TIMEOUT_MS);
        assert_eq!(defaults["mem_mb"]["default"], DEFAULT_MEM_MB);
        assert_eq!(defaults["procs_max"]["default"], DEFAULT_PROCS_MAX);
        let ignore: Vec<&str> = schema["properties"]["default_ignore"]["default"]
            .as_array()
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        assert_eq!(ignore, DEFAULT_IGNORE.to_vec());
    }
}
