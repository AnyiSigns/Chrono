// 新建文件的 unified diff 合成：`fsop.replace` 已自算 `added` / `removed` / `patch` 并原样透传，
// 只有新建（`fsop.write`）分支需要本插件补一份「空文件 → new」的对比。

/// 新建文件的差异摘要。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffSummary {
    pub added: usize,
    pub removed: usize,
    pub patch: String,
}

/// 对「新建」合成 `added` / `removed` / `patch`：全部行都是新增。
pub fn added_file(new: &str) -> DiffSummary {
    let lines = split_lines(new);
    let added = lines.len();
    let mut patch = String::new();
    if added > 0 {
        patch.push_str(&format!("@@ -0,0 +1,{added} @@\n"));
        for line in &lines {
            patch.push('+');
            patch.push_str(line);
            patch.push('\n');
        }
    }
    DiffSummary {
        added,
        removed: 0,
        patch,
    }
}

/// 行切分：与 sandbox 口径一致（去 `\r`、不保留末尾空行）。
fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect();
    if lines.last().map(String::is_empty).unwrap_or(false) {
        lines.pop();
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_file_counts_all_lines_as_added() {
        let diff = added_file("one\ntwo\nthree");
        assert_eq!(diff.added, 3);
        assert_eq!(diff.removed, 0);
        assert!(diff.patch.starts_with("@@ -0,0 +1,3 @@\n"));
        assert!(diff.patch.contains("+one"));
        assert!(diff.patch.contains("+three"));
    }

    #[test]
    fn empty_file_has_empty_patch() {
        let diff = added_file("");
        assert_eq!(diff.added, 0);
        assert_eq!(diff.patch, "");
    }

    #[test]
    fn crlf_is_normalized() {
        let diff = added_file("a\r\nb\r\n");
        assert_eq!(diff.added, 2);
        assert!(diff.patch.contains("+a\n"));
    }
}
