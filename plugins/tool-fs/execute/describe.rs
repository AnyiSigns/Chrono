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
        "intent": "读取文本文件内容，可按行窗口取片段，或批量读取目录下匹配的多个文件。",
        "when_to_use": "需要查看文件内容、快速预览开头，或为精确替换确认上下文时；跨多个同类文件（如某目录下所有配置）批量查看时。",
        "param_semantics": {
            "path": "文件路径（单文件），或批量模式下的目录基准：相对路径以工作区根目录为基准，也可用绝对路径（可能先要你确认）。",
            "pattern": "批量模式开关：给出即把 path 视为目录，读取匹配该 glob 的文件（如 *.py、**/*.ts；支持 {a,b} 分组）。",
            "offset": "起始行号（0 基）；缺省 0。续读时用上一次结果的 next_offset。批量下对每个文件生效。",
            "start_line": "起始行号（1 基、含）；给出时覆盖 offset。与 end_line 组成闭区间。批量下对每个文件生效。",
            "end_line": "结束行号（1 基、含）；给出时改由行范围决定窗口。须 >= start_line。批量下对每个文件生效。",
            "limit": "读取的最大行数；缺省 2000，超出即按窗口截断。批量下对每个文件生效。",
            "preview": "只看文件开头一小段（缺省 50 行），用于快速预览。",
            "format": "读取编码：utf8（缺省，按文本）；base64 或 hex 按原始字节读出并编码，二进制文件也可读（仅单文件，行窗与预览不适用）。",
            "max_files": "批量模式最多读取的文件数；缺省 20，超出即截断并给 warning。",
            "ignore": "批量模式下跳过的名字或路径；缺省用内置忽略规则。"
        },
        "boundaries": "只读文件：单文件可分页续读或按起止行取范围，批量按目录与文件模式汇总多个文件；二进制文件默认不返回（批量下跳过并计入 warning），也可按编码读取原始字节；找文件用 glob、找内容用 grep、改文件用 edit。",
        "description": "读取文件内容，可预览、按行窗口或行范围续读，用编码读取二进制，或批量读取目录下多个文件。",
        "argsSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "pattern": { "type": "string", "minLength": 1 },
                "offset": { "type": "integer", "minimum": 0 },
                "start_line": { "type": "integer", "minimum": 1 },
                "end_line": { "type": "integer", "minimum": 1 },
                "limit": { "type": "integer", "minimum": 1 },
                "preview": { "type": "boolean" },
                "format": { "type": "string", "enum": ["utf8", "base64", "hex"] },
                "max_files": { "type": "integer", "minimum": 1 },
                "ignore": { "type": "array", "items": { "type": "string" } }
            },
            "required": ["path"],
            "additionalProperties": false
        },
        "caps": caps("workspace", "none"),
        "idempotent": false,
        "render": {
            "form": "card",
            "label": "read",
            "summary": "{path}{?  · {pattern}}{?  · offset {offset}}{?  · limit {limit}}",
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
        "boundaries": "只改一个文本文件，不做正则替换、不整目录改；替换目标必须唯一命中；新建时不会覆盖已存在文件；二进制文件不接受。",
        "description": "精确替换或新建文本文件。",
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
        "intent": "按文件名模式查找文件。",
        "when_to_use": "知道文件名 / 后缀但不知道具体位置，需要先列出候选文件；或想查看某目录下有哪些文件与子目录、确认目录层级时。",
        "param_semantics": {
            "pattern": "文件名匹配模式，如 **/*.rs；不跨目录用 *，跨目录用 **；可用大括号分组，如 *.{rs,toml}。",
            "path": "从哪个目录开始找；缺省工作区根目录，也可用绝对路径（可能先要你确认）。",
            "depth": "最大深度：只看相对起始目录不超过几层的项；1 表示只看直接子项。",
            "min_depth": "最小深度：只看相对起始目录至少几层的项，与 depth 组成区间。",
            "tree": "是否以目录层级形式展示结果。",
            "ignore": "搜索时跳过的名字或路径；缺省用内置忽略规则。",
            "exclude": "额外排除的名字或路径模式（如 .next、__pycache__）；叠加在 ignore 之上，命中目录整棵剪枝。",
            "limit": "最多返回多少条；超出的不返回。"
        },
        "boundaries": "只按文件名查找、只读；不读内容（找内容用 grep），不改文件。",
        "description": "按文件名模式列出文件，可选择目录层级视图，或额外排除指定名字 / 路径。",
        "argsSchema": {
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "minLength": 1 },
                "path": { "type": "string" },
                "depth": { "type": "integer", "minimum": 1 },
                "min_depth": { "type": "integer", "minimum": 1 },
                "tree": { "type": "boolean" },
                "ignore": { "type": "array", "items": { "type": "string" } },
                "exclude": { "type": "array", "items": { "type": "string" } },
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
            "detail": { "kind": "tree" }
        }
    })
}

fn grep_tool() -> Value {
    json!({
        "name": "grep",
        "intent": "在文件内容里查找命中行。",
        "when_to_use": "知道一段文本 / 符号名，需要定位它出现在哪些文件与行时。",
        "param_semantics": {
            "pattern": "要查找的文本；默认按普通文本匹配。",
            "mode": "按普通文本还是正则表达式匹配；缺省时含明显正则写法的模式按正则处理。",
            "ignore_case": "是否忽略大小写。",
            "files_only": "是否只回报命中的文件、不逐行列出行。",
            "all": "附加模式数组：命中行须同时满足 pattern 与每个附加模式（AND）。",
            "any": "附加模式数组：命中行满足 pattern 或其中任一即可（OR）；与 all 叠加时先 OR 后 AND。",
            "stats": "只回审计聚合（命中文件数 / 命中总数），不逐条回行、不受 limit 截断。",
            "binary": "是否把二进制文件纳入搜索：按原始字节 / Latin-1 解释（ASCII 模式安全），命中条目带 binary 标记；缺省仍跳过二进制。",
            "before": "命中行前附带几行上下文。",
            "after": "命中行后附带几行上下文。",
            "glob": "只在匹配这些文件名模式的文件里搜索，如 *.rs；可用大括号分组，如 *.{py,yml}。",
            "path": "从哪个目录开始搜；缺省工作区根目录，也可用绝对路径（可能先要你确认）。",
            "ignore": "搜索时跳过的名字或路径；缺省用内置忽略规则。",
            "limit": "最多回报多少条命中。"
        },
        "boundaries": concat!(
            "只读搜索，回报命中的文件与行，可附带上下文；",
            "不做替换（改文件用 edit），不按文件名找文件用 glob。"
        ),
        "description": "在文件内容里搜索命中行，可忽略大小写、只回报文件或附带上下文。",
        "argsSchema": {
            "type": "object",
            "properties": {
                "pattern": { "type": "string", "minLength": 1 },
                "mode": { "type": "string", "enum": ["literal", "regex"] },
                "ignore_case": { "type": "boolean" },
                "files_only": { "type": "boolean" },
                "all": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                "any": { "type": "array", "items": { "type": "string", "minLength": 1 } },
                "stats": { "type": "boolean" },
                "binary": { "type": "boolean" },
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
        "intent": "查询路径的存在性、类型、大小与修改时间（只读）；支持单路径、批量路径与目录子树聚合。",
        "when_to_use": "需要判断文件 / 目录是否存在、是否目录、大小，或比较修改时间新旧（如找最近改动）时；批量元信息审计（如某目录下所有源文件的大小与时间），或目录子树总大小与最老 / 最新时间时。",
        "param_semantics": {
            "path": "文件 / 目录路径（单个），或批量模式下的目录基准：相对路径以工作区根目录为基准，也可用绝对路径（可能先要你确认）；路径里含 glob 元字符（如 src/**/*.py）时自动按批量处理。",
            "pattern": "批量模式开关：给出即把 path 视为目录，查询匹配该 glob 的路径（如 *.py、**/*.ts；支持 {a,b} 分组）。",
            "recursive": "目录且为 true 时，额外回整棵子树的聚合（文件 / 目录数、总大小、最老与最新 mtime）。",
            "max_files": "批量模式最多查询的路径数；缺省 200，超出即截断并给 warning。",
            "ignore": "批量模式下跳过的名字或路径；缺省用内置忽略规则。",
            "sort_by": "批量结果的排序键：name（字典序）/ mtime / size；缺省 name。",
            "order": "排序方向：asc / desc；缺省 mtime、size 为 desc，name 为 asc。",
            "min_size": "批量过滤：仅保留大小不小于该字节数的项。",
            "max_size": "批量过滤：仅保留大小不大于该字节数的项。",
            "min_mtime": "批量过滤：仅保留修改时间不早于该毫秒时间戳的项。",
            "max_mtime": "批量过滤：仅保留修改时间不晚于该毫秒时间戳的项。"
        },
        "boundaries": "只查元信息，不读内容（用 read）、不改文件；批量按目录与文件模式查询，或对目录做子树聚合；列文件名仍以 glob 为主。",
        "description": "查询单路径或批量路径的存在性、类型、大小与修改时间，目录可做子树聚合。",
        "argsSchema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "minLength": 1 },
                "pattern": { "type": "string", "minLength": 1 },
                "recursive": { "type": "boolean" },
                "max_files": { "type": "integer", "minimum": 1 },
                "ignore": { "type": "array", "items": { "type": "string" } },
                "sort_by": { "type": "string", "enum": ["name", "mtime", "size"] },
                "order": { "type": "string", "enum": ["asc", "desc"] },
                "min_size": { "type": "integer", "minimum": 0 },
                "max_size": { "type": "integer", "minimum": 0 },
                "min_mtime": { "type": "integer", "minimum": 0 },
                "max_mtime": { "type": "integer", "minimum": 0 }
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
            "{path}{?  · {pattern}}{?  · offset {offset}}{?  · limit {limit}}"
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
            json!({ "kind": "tree" })
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
