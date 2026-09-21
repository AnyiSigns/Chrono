// 路径形态校验与「区内 / 区外」机械归类（本插件独有职责的声明面）。
// 只做词法规范化（`.` / `..`），**不直接触盘**：realpath / 符号链接解析 / 强制点唯一在 sandbox.fsop。
// 归类结果只用于声明 `caps.fs.*`（区内 `workspace` / 区外 `full`）；越界与升级由 sandbox / guard 判。

use crate::error::ToolError;

/// 一次路径解析结果：`path` 原样转发给 sandbox，`inside` 是机械归类。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub path: String,
    pub inside: bool,
}

/// 形态非法（空串 / NUL / 控制字符 / 平台非法字符 / Windows 保留设备名 / ADS / 尾随点或空格）
/// → `bad_path`，机械拒、不触盘。口径与 sandbox 一致或更严；不误伤合法绝对路径与 `..`。
pub fn validate_form(path: &str) -> Result<(), ToolError> {
    if path.trim().is_empty() {
        return Err(ToolError::new("bad_path", "empty path"));
    }
    if path.contains('\0') {
        return Err(ToolError::new("bad_path", "NUL in path"));
    }
    if path.chars().any(char::is_control) {
        return Err(ToolError::new("bad_path", "control character in path"));
    }
    if let Some(character) = illegal_char(path) {
        return Err(ToolError::new(
            "bad_path",
            format!("illegal character {character:?} in path"),
        ));
    }
    reject_reserved_names(path)?;
    reject_trailing_dot_or_space(path)?;
    Ok(())
}

/// 去掉 Windows verbatim 前缀 `\\?\` / `//?/`（含 `UNC\`），使前缀里的 `?` 不被当成非法字符。
fn strip_verbatim(path: &str) -> &str {
    let rest = match path.strip_prefix(r"\\?\") {
        Some(rest) => rest,
        None => match path.strip_prefix("//?/") {
            Some(rest) => rest,
            None => return path,
        },
    };
    for prefix in [r"UNC\", "UNC/", r"unc\", "unc/"] {
        if let Some(inner) = rest.strip_prefix(prefix) {
            return inner;
        }
    }
    rest
}

/// Windows 禁用字符 `< > " | ? *`；`:` 只允许盘符（`X:` / `X:\`），其余即 ADS（`file:stream`）。
fn illegal_char(path: &str) -> Option<char> {
    let body = strip_verbatim(path);
    let chars: Vec<char> = body.chars().collect();
    for (index, character) in chars.iter().enumerate() {
        if matches!(*character, '<' | '>' | '"' | '|' | '?' | '*') {
            return Some(*character);
        }
        if *character == ':' && !is_drive_colon(&chars, index) {
            return Some(*character);
        }
    }
    None
}

/// `:` 位于盘符处：首字符为字母、`:` 紧跟其后，且后面是分隔符或已到串尾。
fn is_drive_colon(chars: &[char], index: usize) -> bool {
    index == 1
        && chars[0].is_ascii_alphabetic()
        && (chars.len() == 2 || matches!(chars[2], '/' | '\\'))
}

/// Windows 保留设备名（`CON` / `PRN` / `AUX` / `NUL` / `COM1-9` / `LPT1-9`，带扩展名同拒）。
fn reject_reserved_names(path: &str) -> Result<(), ToolError> {
    for segment in strip_verbatim(path).split(['/', '\\']) {
        if segment.is_empty() || segment == "." || segment == ".." {
            continue;
        }
        let stem = segment.split('.').next().unwrap_or("");
        if is_reserved_name(stem) {
            return Err(ToolError::new(
                "bad_path",
                format!("reserved device name {segment:?}"),
            ));
        }
    }
    Ok(())
}

fn is_reserved_name(stem: &str) -> bool {
    let upper = stem.trim_end_matches(['.', ' ']).to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ if upper.chars().count() == 4 => {
            let prefix: String = upper.chars().take(3).collect();
            let digit = upper.chars().nth(3);
            matches!(prefix.as_str(), "COM" | "LPT") && matches!(digit, Some('1'..='9'))
        }
        _ => false,
    }
}

/// Windows 文件名 / 目录名不得以点或空格结尾（`.` / `..` 段除外）。
fn reject_trailing_dot_or_space(path: &str) -> Result<(), ToolError> {
    for segment in strip_verbatim(path).split(['/', '\\']) {
        if segment.is_empty() || segment == "." || segment == ".." {
            continue;
        }
        if segment.ends_with('.') || segment.ends_with(' ') {
            return Err(ToolError::new(
                "bad_path",
                format!("segment ends with dot or space: {segment:?}"),
            ));
        }
    }
    Ok(())
}

/// 归类目标：相对路径以 `workspace_root` 为基准；绝对路径含区外。
/// 相对路径缺 `workspace_root` → `workspace_missing`；绝对路径不需要 `workspace_root`。
pub fn classify(path: &str, workspace_root: Option<&str>) -> Result<Target, ToolError> {
    validate_form(path)?;
    let root = workspace_root.filter(|value| !value.trim().is_empty());
    if is_absolute(path) {
        let inside = match root {
            Some(root) => starts_with(&normalize(path), &normalize(root)),
            None => false,
        };
        return Ok(Target {
            path: path.to_string(),
            inside,
        });
    }
    let Some(root) = root else {
        return Err(ToolError::new(
            "workspace_missing",
            "relative path requires workspace_root",
        ));
    };
    validate_form(root)?;
    // 相对路径里未被抵消的 `..` 会逃出工作区 → 区外。
    let inside = !normalize(path).iter().any(|segment| segment == "..");
    Ok(Target {
        path: path.to_string(),
        inside,
    })
}

/// 声明用范围串：区内 `workspace` / 区外 `full`。
pub fn scope_for(inside: bool) -> &'static str {
    if inside {
        "workspace"
    } else {
        "full"
    }
}

/// 绝对路径：POSIX 根、Windows 盘符或 UNC。
fn is_absolute(path: &str) -> bool {
    let bytes: Vec<char> = path.chars().collect();
    if bytes
        .first()
        .map(|c| *c == '/' || *c == '\\')
        .unwrap_or(false)
    {
        return true;
    }
    bytes.len() >= 2 && bytes[1] == ':' && bytes[0].is_ascii_alphabetic()
}

/// 词法规范化：按 `/` 与 `\` 切段，消掉 `.`、抵消 `..`；盘符 / UNC 段原样保留。
fn normalize(path: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for segment in path.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                if out.last().map(|last| last != "..").unwrap_or(false) {
                    out.pop();
                } else {
                    out.push("..".to_string());
                }
            }
            other => out.push(other.to_string()),
        }
    }
    out
}

/// 归一后的键：Windows 大小写不敏感、分隔符统一为 `/`。
fn key(segment: &str) -> String {
    if cfg!(windows) {
        segment.to_lowercase()
    } else {
        segment.to_string()
    }
}

fn starts_with(target: &[String], root: &[String]) -> bool {
    if target.len() < root.len() {
        return false;
    }
    target
        .iter()
        .zip(root.iter())
        .all(|(left, right)| key(left) == key(right))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_forms() {
        assert_eq!(classify("", Some("C:\\ws")).unwrap_err().code, "bad_path");
        assert_eq!(classify("  ", Some("C:\\ws")).unwrap_err().code, "bad_path");
        assert_eq!(
            classify("a\0b", Some("C:\\ws")).unwrap_err().code,
            "bad_path"
        );
        assert_eq!(
            classify("a\u{1}b", Some("C:\\ws")).unwrap_err().code,
            "bad_path"
        );
    }

    #[test]
    fn rejects_platform_illegal_and_ads_forms() {
        for path in [
            "C:\\ws\\a?b",
            "C:\\ws\\a*b",
            "C:\\ws\\a<b",
            "C:\\ws\\a>b",
            "C:\\ws\\a|b",
            "C:\\ws\\a\"b",
            "C:\\ws\\file:stream", // ADS
            "a:b",
        ] {
            assert_eq!(
                classify(path, Some("C:\\ws")).unwrap_err().code,
                "bad_path",
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_windows_reserved_names() {
        for path in [
            "C:\\ws\\CON",
            "C:\\ws\\con.txt",
            "C:\\ws\\nested\\PRN",
            "C:\\ws\\AUX",
            "C:\\ws\\NUL",
            "C:\\ws\\COM1",
            "C:\\ws\\lpt9.log",
            "CON",
        ] {
            assert_eq!(
                classify(path, Some("C:\\ws")).unwrap_err().code,
                "bad_path",
                "{path}"
            );
        }
        // 非保留名（含 COM0 / LPT10）照常归类。
        assert!(classify("C:\\ws\\COM0", Some("C:\\ws")).is_ok());
        assert!(classify("C:\\ws\\LPT10", Some("C:\\ws")).is_ok());
    }

    #[test]
    fn rejects_trailing_dot_or_space() {
        assert_eq!(
            classify("C:\\ws\\name.", Some("C:\\ws")).unwrap_err().code,
            "bad_path"
        );
        assert_eq!(
            classify("C:\\ws\\name ", Some("C:\\ws")).unwrap_err().code,
            "bad_path"
        );
        assert_eq!(
            classify("C:\\ws\\dir.\\file", Some("C:\\ws"))
                .unwrap_err()
                .code,
            "bad_path"
        );
    }

    #[test]
    fn legal_absolute_relative_and_verbatim_paths_pass() {
        assert!(classify("C:\\ws\\src\\main.rs", Some("C:\\ws")).is_ok());
        assert!(classify("C:\\other\\a.txt", Some("C:\\ws")).is_ok());
        assert!(classify("src/../lib/a.rs", Some("C:\\ws")).is_ok());
        assert!(classify("..\\secret.txt", Some("C:\\ws")).is_ok());
        assert!(classify("C:\\ws\\", Some("C:\\ws")).is_ok());
        // verbatim 前缀里的 `?` 不算非法字符。
        assert!(classify("\\\\?\\C:\\ws\\a.txt", Some("C:\\ws")).is_ok());
    }

    #[test]
    fn relative_paths_basis_workspace_root() {
        let inside = classify("src/main.rs", Some("C:\\ws")).unwrap();
        assert!(inside.inside);
        assert_eq!(inside.path, "src/main.rs");
        let normalized = classify("src/../lib/a.rs", Some("C:\\ws")).unwrap();
        assert!(normalized.inside);
        let escaping = classify("../secret.txt", Some("C:\\ws")).unwrap();
        assert!(!escaping.inside);
        let deep = classify("../../etc/passwd", Some("C:\\ws")).unwrap();
        assert!(!deep.inside);
    }

    #[test]
    fn relative_without_root_is_workspace_missing() {
        assert_eq!(
            classify("a.txt", None).unwrap_err().code,
            "workspace_missing"
        );
        assert_eq!(
            classify("a.txt", Some("   ")).unwrap_err().code,
            "workspace_missing"
        );
    }

    #[test]
    fn absolute_paths_include_outside() {
        let inside = classify("C:\\ws\\a.txt", Some("C:\\ws")).unwrap();
        assert!(inside.inside);
        let outside = classify("C:\\other\\a.txt", Some("C:\\ws")).unwrap();
        assert!(!outside.inside);
        // 绝对路径不需要 workspace_root。
        let rootless = classify("C:\\other\\a.txt", None).unwrap();
        assert!(!rootless.inside);
    }

    #[test]
    fn scope_strings() {
        assert_eq!(scope_for(true), "workspace");
        assert_eq!(scope_for(false), "full");
    }
}
