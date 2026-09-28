// 工具面自述（`tool-fs.describe` 的输出）：五个工具 + 描述四要素 + argsSchema + caps + render 描述符。
// 形状对齐「`tool` 端口契约」：四要素必填非空、`param_semantics` 覆盖必填参数、
// `caps` 对象形含 `fs.read`；render 形状对齐「工具卡渲染」。

use serde_json::{json, Value};

use crate::defaults;

/// 一次回报本插件暴露的全部工具。
pub fn describe() -> Value {
    json!({ "tools": tools() })
}

fn tools() -> Vec<Value> {
    vec![read_tool(), edit_tool(), glob_tool(), grep_tool(), stat_tool()]
}

/// 工具 caps：区内/区外读或写声明，net 显式关闭（字符串 scope）；资源上限与 schema defaults 同形。
fn caps(read: &str, write: &str) -> Value {
    json!({
        "fs": { "read": read, "write": write },
        "net": "none",
        "timeout_ms": defaults::DEFAULT_TIMEOUT_MS,
        "mem_mb": defaults::DEFAULT_MEM_MB,
        "output_max": defaults::DEFAULT_OUTPUT_MAX,
        "procs_max": defaults::DEFAULT_PROCS_MAX,
    })
}

fn read_tool() -> Value {
    json!({
        "name": "read",
        "intent": "读取一个文本文件的内容，可按行窗口取片段。",
        "when_to_use": "需要查看文件内容、为精确替换确认上下文，或定位某段代码时。",
        "param_semantics": {
            "path": "文件路径：相对路径以工作区根目录为基准，也可用绝对路径（可能先要你确认）。",
            "offset": "起始行号（0 基）；缺省 0。续读时用上一次结果的 next_offset。",
            "limit": "读取的最大行数；缺省 2000，超出即按窗口截断。"
        },
        "boundaries": "只读单个文本文件；要续读时按返回的 next_offset 继续取；二进制回 binary_unsupported；找文件用 glob、找内容用 grep、改文件用 edit。",
        "description": "读文本文件（支持行窗口）；返回 {text, total_lines, start_line, end_line, lines_returned, has_more, next_offset, content_truncated, truncated}。",
        "argsSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "offset": { "type": "integer", "minimum": 0 },
                "limit": { "type": "integer", "minimum": 1 }
            },
            "required": ["path"],
            "additionalProperties": false
        },
        "caps": caps("workspace", "none"),
        "idempotent": false,
        "render": {
            "form": "card",
            "label": "read",
            "summary": "{path}{?  · offset {offset}}{?  · limit {limit}}",
            "tone": "ghost",
            "detail": { "kind": "code" }
        }
    })
}

fn edit_tool() -> Value {
    json!({
        "name": "edit",
        "intent": "对文件做精确替换；old 为空时新建文件。",
        "when_to_use": "需要修改文件内容、或创建一个新文件时。",
        "param_semantics": {
            "path": "文件路径：相对路径以工作区根目录为基准，也可用绝对路径（可能先要你确认）。",
            "old": "要被替换的原文；必须唯一命中（replace_all 为 true 时全部替换）。空串表示新建分支。",
            "new": "替换后的新文；新建分支下为新文件的初始内容。",
            "replace_all": "是否替换全部命中；缺省 false（old 非唯一即 edit_conflict）。"
        },
        "boundaries": "只改一个文本文件，不做正则替换、不整目录改；old 未命中或非唯一回 edit_conflict，二进制回 binary_unsupported。新建时若文件已存在则回 edit_conflict，不会覆盖。",
        "description": "精确替换或新建文本文件；返回 {replaced, bytes_written, added, removed, patch}（新建含 created）。",
        "argsSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "old": { "type": "string" },
                "new": { "type": "string" },
                "replace_all": { "type": "boolean" }
            },
            "required": ["path", "old", "new"],
            "additionalProperties": false
        },
        "caps": caps("workspace", "workspace"),
        "idempotent": false,
        "render": {
            "form": "card",
            "label": "edit",
            "summary": "{path}{?  +{result.added} -{result.removed}}",
            "tone": "plain",
            "detail": { "kind": "diff" }
        }
    })
}

fn glob_tool() -> Value {
    json!({
        "name": "glob",
        "intent": "按文件名模式在工作区内（或指定基准目录）查找文件。",
        "when_to_use": "知道文件名 / 后缀但不知道具体位置，需要先列出候选文件时。",
        "param_semantics": {
            "pattern": "文件名 glob 模式，如 **/*.rs；不跨目录用 *，跨目录用 **。",
            "path": "搜索基准目录；缺省工作区根目录，相对路径以工作区根目录为基准，也可用绝对路径（可能先要你确认）。",
            "ignore": "忽略模式表；缺省用内置忽略规则。",
            "limit": "返回条数上限；缺省 200，超限标记 truncated。"
        },
        "boundaries": "只按文件名找文件、返回相对路径；不读内容（找内容用 grep），不改文件。",
        "description": "按 glob 模式列文件；返回 {paths, truncated}。",
        "argsSchema": {
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "minLength": 1 },
                "path": { "type": "string" },
                "ignore": { "type": "array", "items": { "type": "string" } },
                "limit": { "type": "integer", "minimum": 1 }
            },
            "required": ["pattern"],
            "additionalProperties": false
        },
        "caps": caps("workspace", "none"),
        "idempotent": false,
        "render": {
            "form": "card",
            "label": "glob",
            "summary": "{pattern}{?  · in {path}}{?  · limit {limit}}",
            "tone": "ghost",
            "detail": { "kind": "paths" }
        }
    })
}

fn grep_tool() -> Value {
    json!({
        "name": "grep",
        "intent": "在文件内容里按普通文本或正则表达式查找命中行。",
        "when_to_use": "知道一段文本 / 符号名，需要定位它出现在哪些文件与行时。",
        "param_semantics": {
            "pattern": "要查找的文本；缺省按普通文本匹配，需要正则表达式时用 mode 指定。",
            "mode": "匹配模式：literal 按普通文本、regex 按正则表达式；缺省 literal。",
            "ignore_case": "是否忽略大小写（对带变音符号的字符不做规范化，组合形与分解形不互相匹配）；缺省 false。",
            "files_only": "只回报命中文件：每文件一条（首个命中的行号/文本 + count 命中数）；缺省 false。",
            "before": "每条命中附带的前置上下文行数（0–20）；缺省 0，仅回报文件时忽略。",
            "after": "每条命中附带的后置上下文行数（0–20）；缺省 0，仅回报文件时忽略。",
            "glob": "只在这些文件名模式下搜索，如 *.rs。",
            "path": "搜索基准目录；缺省工作区根目录，相对路径以工作区根目录为基准，也可用绝对路径（可能先要你确认）。",
            "ignore": "忽略模式表；缺省用内置忽略规则。",
            "limit": "命中条数上限（files_only 下为文件数上限）；缺省 200，超限标记 truncated。"
        },
        "boundaries": concat!(
            "只读搜索、返回命中行 {path, line, text}（可选 before/after 上下文；files_only 时每文件一条并带 count）；",
            "不做替换（改文件用 edit），不按文件名找文件用 glob。",
            "选择正则模式时，本工具的正则不支持交替 | / 分组 () / 重复 {…} / \\d 等类简写，命中这些结构会报参数错误，",
            "改用普通文本模式或简化模式即可。"
        ),
        "description": "按模式搜内容（literal / regex，可选忽略大小写/仅文件/上下文）；返回 {matches, truncated, skipped}。",
        "argsSchema": {
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "minLength": 1 },
                "mode": { "type": "string", "enum": ["literal", "regex"] },
                "ignore_case": { "type": "boolean" },
                "files_only": { "type": "boolean" },
                "before": { "type": "integer", "minimum": 0, "maximum": 20 },
                "after": { "type": "integer", "minimum": 0, "maximum": 20 },
                "glob": { "type": "string" },
                "path": { "type": "string" },
                "ignore": { "type": "array", "items": { "type": "string" } },
                "limit": { "type": "integer", "minimum": 1 }
            },
            "required": ["pattern"],
            "additionalProperties": false
        },
        "caps": caps("workspace", "none"),
        "idempotent": false,
        "render": {
            "form": "card",
            "label": "grep",
            "summary": "{pattern}{?  · {glob}}{?  · in {path}}{?  · limit {limit}}",
            "tone": "ghost",
            "detail": { "kind": "matches" }
        }
    })
}

fn stat_tool() -> Value {
    json!({
        "name": "stat",
        "intent": "查询单个路径的存在性、类型、大小与修改时间（只读）。",
        "when_to_use": "需要判断文件 / 目录是否存在、是否目录、大小，或比较修改时间新旧（如找最近改动）时。",
        "param_semantics": {
            "path": "文件 / 目录路径：相对路径以工作区根目录为基准，也可用绝对路径（可能先要你确认）。"
        },
        "boundaries": "只读单个路径的元信息；不读内容（用 read）、不列目录（用 glob）、不改文件。mtime 取自文件系统。",
        "description": "查询路径元信息；返回 {exists, is_dir, size, mtime}。",
        "argsSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "minLength": 1 }
            },
            "required": ["path"],
            "additionalProperties": false
        },
        "caps": caps("workspace", "none"),
        "idempotent": false,
        "render": {
            "form": "card",
            "label": "stat",
            "summary": "{path}",
            "tone": "ghost",
            "detail": { "kind": "json" }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const ELEMENTS: [&str; 4] = ["intent", "when_to_use", "param_semantics", "boundaries"];
    const EXPECTED: [&str; 5] = ["read", "edit", "glob", "grep", "stat"];

    fn tools() -> Vec<Value> {
        describe()["tools"].as_array().cloned().unwrap_or_default()
    }

    #[test]
    fn reports_tools_in_order() {
        let names: Vec<String> = tools()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_string))
            .collect();
        assert_eq!(names, EXPECTED.to_vec());
    }

    #[test]
    fn four_elements_non_empty_and_cover_required_args() {
        for tool in tools() {
            let name = tool["name"].as_str().unwrap();
            for element in ELEMENTS {
                let present = if element == "param_semantics" {
                    tool[element]
                        .as_object()
                        .map(|map| !map.is_empty())
                        .unwrap_or(false)
                } else {
                    !tool[element].as_str().unwrap_or("").trim().is_empty()
                };
                assert!(present, "{name} 缺少 {element}");
            }
            let semantics = tool["param_semantics"].as_object().unwrap();
            let required = tool["argsSchema"]["required"].as_array().unwrap();
            for key in required {
                let key = key.as_str().unwrap();
                assert!(
                    semantics.contains_key(key),
                    "{name} 的 param_semantics 未覆盖 {key}"
                );
            }
        }
    }

    #[test]
    fn caps_declare_fs_read_and_idempotent_is_false() {
        for tool in tools() {
            let name = tool["name"].as_str().unwrap();
            assert!(
                tool["caps"]["fs"]["read"].is_string(),
                "{name} 的 caps 缺 fs.read"
            );
            assert_eq!(tool["idempotent"], false, "{name} 应为非幂等");
        }
    }

    #[test]
    fn render_descriptors_match_design() {
        let by_name: std::collections::HashMap<String, Value> = tools()
            .into_iter()
            .map(|tool| (tool["name"].as_str().unwrap().to_string(), tool))
            .collect();
        assert_eq!(by_name["read"]["render"]["form"], "card");
        assert_eq!(
            by_name["read"]["render"]["summary"],
            "{path}{?  · offset {offset}}{?  · limit {limit}}"
        );
        assert_eq!(by_name["read"]["render"]["tone"], "ghost");
        assert_eq!(
            by_name["read"]["render"]["detail"],
            json!({ "kind": "code" })
        );
        assert_eq!(by_name["edit"]["render"]["form"], "card");
        assert_eq!(
            by_name["edit"]["render"]["summary"],
            "{path}{?  +{result.added} -{result.removed}}"
        );
        // detail 是渲染器载荷（裸 kind）：数据由渲染器按 kind 从结果取，不写 `{result.*}` 模板。
        assert_eq!(
            by_name["edit"]["render"]["detail"],
            json!({ "kind": "diff" })
        );
        assert_eq!(by_name["glob"]["render"]["tone"], "ghost");
        assert_eq!(
            by_name["glob"]["render"]["summary"],
            "{pattern}{?  · in {path}}{?  · limit {limit}}"
        );
        assert_eq!(
            by_name["glob"]["render"]["detail"],
            json!({ "kind": "paths" })
        );
        assert_eq!(by_name["grep"]["render"]["tone"], "ghost");
        assert_eq!(
            by_name["grep"]["render"]["summary"],
            "{pattern}{?  · {glob}}{?  · in {path}}{?  · limit {limit}}"
        );
        assert_eq!(
            by_name["grep"]["render"]["detail"],
            json!({ "kind": "matches" })
        );
        assert_eq!(by_name["stat"]["render"]["tone"], "ghost");
        assert_eq!(
            by_name["stat"]["render"]["detail"],
            json!({ "kind": "json" })
        );
    }

    #[test]
    fn args_schema_uses_whitelist_subset_only() {
        let allowed: BTreeSet<&str> = [
            "type",
            "properties",
            "required",
            "additionalProperties",
            "items",
            "enum",
            "const",
            "minimum",
            "maximum",
            "minItems",
            "maxItems",
            "minLength",
            "maxLength",
            "title",
            "description",
            "default",
            "examples",
        ]
        .into_iter()
        .collect();
        fn check_schema(schema: &Value, allowed: &BTreeSet<&str>, path: &str) {
            let object = schema.as_object().expect("schema 必须是对象");
            for (key, child) in object {
                assert!(
                    allowed.contains(key.as_str()),
                    "白名单外关键词 {path}.{key}"
                );
                match key.as_str() {
                    "properties" => {
                        for (name, sub) in child.as_object().expect("properties 必须是对象") {
                            check_schema(sub, allowed, &format!("{path}.properties.{name}"));
                        }
                    }
                    "items" => check_schema(child, allowed, &format!("{path}.items")),
                    _ => {}
                }
            }
        }
        for tool in tools() {
            check_schema(&tool["argsSchema"], &allowed, "argsSchema");
        }
    }
}
