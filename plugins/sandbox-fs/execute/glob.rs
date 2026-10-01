// 匹配器：`list` / `grep` 的 glob 过滤与 `grep` 的简易正则。
// 无外部依赖、确定性（纯函数，不取时间、不用随机）；`/` 为路径分隔符。

/// glob 匹配：支持 `*`（不跨 `/`）、`**`（跨 `/`）、`?`、`[...]`（可 `!`/`^` 取反、`a-z` 范围）
/// 与 `{a,b,c}` 大括号分组（含嵌套与整数区间 `{1..3}`，见 `brace_group`）。
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let text: Vec<char> = text.chars().collect();
    glob_here(&pattern, 0, &text, 0)
}

fn glob_here(pattern: &[char], mut pi: usize, text: &[char], mut ti: usize) -> bool {
    while pi < pattern.len() {
        match pattern[pi] {
            '*' => {
                let double = pi + 1 < pattern.len() && pattern[pi + 1] == '*';
                let mut rest = if double { pi + 2 } else { pi + 1 };
                if double && rest < pattern.len() && pattern[rest] == '/' {
                    // `**/` 允许匹配零级目录
                    if glob_here(pattern, rest + 1, text, ti) {
                        return true;
                    }
                    rest += 1;
                }
                let mut k = ti;
                loop {
                    if glob_here(pattern, rest, text, k) {
                        return true;
                    }
                    if k >= text.len() {
                        return false;
                    }
                    if !double && text[k] == '/' {
                        return false;
                    }
                    k += 1;
                }
            }
            '?' => {
                if ti >= text.len() || text[ti] == '/' {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
            '[' => {
                if ti >= text.len() {
                    return false;
                }
                let (matched, next) = match_class(pattern, pi, text[ti]);
                if !matched {
                    return false;
                }
                pi = next;
                ti += 1;
            }
            '{' => match brace_group(pattern, pi) {
                // `{a,b}` / `{1..3}`：逐候选「候选 + 后续模式」整段匹配（候选可再含分组，递归展开）。
                Some((alternatives, after)) => {
                    let rest = &pattern[after..];
                    return alternatives.iter().any(|alternative| {
                        let mut combined = Vec::with_capacity(alternative.len() + rest.len());
                        combined.extend_from_slice(alternative);
                        combined.extend_from_slice(rest);
                        glob_here(&combined, 0, text, ti)
                    });
                }
                // 不构成分组（未闭合 / 无逗号且非区间）：按字面 `{` 处理。
                None => {
                    if ti >= text.len() || text[ti] != '{' {
                        return false;
                    }
                    pi += 1;
                    ti += 1;
                }
            },
            literal => {
                if ti >= text.len() || text[ti] != literal {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
        }
    }
    ti == text.len()
}

/// 解析 `[...]`：返回（是否命中字符，`]` 之后的模式下标）。未闭合按字面 `[` 处理。
fn match_class(pattern: &[char], start: usize, target: char) -> (bool, usize) {
    let mut index = start + 1;
    let mut negated = false;
    if index < pattern.len() && (pattern[index] == '!' || pattern[index] == '^') {
        negated = true;
        index += 1;
    }
    let mut matched = false;
    let mut first = true;
    while index < pattern.len() {
        if pattern[index] == ']' && !first {
            return (matched != negated, index + 1);
        }
        first = false;
        let low = pattern[index];
        if index + 2 < pattern.len() && pattern[index + 1] == '-' && pattern[index + 2] != ']' {
            let high = pattern[index + 2];
            if low <= target && target <= high {
                matched = true;
            }
            index += 3;
            continue;
        }
        if low == target {
            matched = true;
        }
        index += 1;
    }
    (false, start + 1)
}

/// 整数区间 `{1..3}` 的最大展开长度；超出即视为非分组（按字面处理），避免病态模式撑爆候选集。
const MAX_BRACE_RANGE: i64 = 256;

/// 解析一个 `{...}` 分组：返回（候选列表，`}` 之后的下标）。不构成分组时返回 `None`（按字面 `{` 处理）。
/// 支持 `a,b,c` 顶层逗号交替（候选内可再嵌套 `{...}`）与整数区间 `1..3`（含边界、可降序）。
fn brace_group(pattern: &[char], start: usize) -> Option<(Vec<Vec<char>>, usize)> {
    let mut depth = 0usize;
    let mut close = None;
    let mut index = start;
    while index < pattern.len() {
        match pattern[index] {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(index);
                    break;
                }
            }
            _ => {}
        }
        index += 1;
    }
    let close = close?;
    let alternatives = brace_alternatives(&pattern[start + 1..close])?;
    Some((alternatives, close + 1))
}

/// 组内候选：优先按顶层逗号切分；无顶层逗号时尝试整数区间 `A..B`；都不是则 `None`。
fn brace_alternatives(inner: &[char]) -> Option<Vec<Vec<char>>> {
    let mut parts: Vec<Vec<char>> = Vec::new();
    let mut current: Vec<char> = Vec::new();
    let mut depth = 0usize;
    let mut saw_comma = false;
    for &ch in inner {
        match ch {
            '{' => {
                depth += 1;
                current.push(ch);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            ',' if depth == 0 => {
                saw_comma = true;
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
    }
    if saw_comma {
        parts.push(current);
        return Some(parts);
    }
    let text: String = inner.iter().collect();
    let (low, high) = text.split_once("..")?;
    let low: i64 = low.trim().parse().ok()?;
    let high: i64 = high.trim().parse().ok()?;
    let count = (high - low).abs() + 1;
    if count > MAX_BRACE_RANGE {
        return None;
    }
    let step: i64 = if high >= low { 1 } else { -1 };
    let mut out = Vec::with_capacity(count as usize);
    let mut value = low;
    loop {
        out.push(value.to_string().chars().collect());
        if value == high {
            break;
        }
        value += step;
    }
    Some(out)
}

/// 校验模式是否为合法正则；`Some(reason)` 表示语法错误。
/// 调用方在正则模式下先校验：不合法即显式报错，**不得**静默退化按字面匹配。
/// 支持：字面、`.`、`*`/`+`/`?`/`{n}`/`{n,}`/`{n,m}`、`^`/`$`、`[...]` 类、分组 `(...)`、
/// 交替 `|`、转义元字符、类简写 `\d`/`\D`/`\w`/`\W`/`\s`/`\S` 与 `\n`/`\t`/`\r`。
/// 不支持：反向引用、环视、非贪婪量词；未知转义 / 悬空量词 / 未闭合分组或类即报错。
pub fn regex_unsupported(pattern: &str) -> Option<String> {
    match parse(pattern) {
        Ok(_) => None,
        Err(error) => Some(error),
    }
}

/// 字面模式下、结果为空时的诊断：模式恰好落在「像正则」的形态。
/// 返回提示文案（说明这是字面搜索、以及如何改走正则）；纯文本模式返回 `None`，不打扰。
pub fn literal_empty_hint(pattern: &str) -> Option<String> {
    if !looks_like_regex(pattern) {
        return None;
    }
    Some("no matches; pattern looks like a regex — pass mode:\"regex\" if you meant regex.".to_string())
}

/// 强正则意图判定（供缺省 `mode` 自动选择）：只认几乎不会出现在普通文本里的信号——
/// 交替 `|`、类简写/转义元字符、`{数字` 重复——避免把 `fn main()` / `if (x)` / `[error]`
/// 这类常见代码误判成正则。Windows 路径（盘符 + 反斜杠）不按正则解读。
pub fn regex_intent(pattern: &str) -> bool {
    if pattern.contains(':') && pattern.contains('\\') {
        return false;
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '|' => return true,
            '{' => {
                if chars.get(index + 1).is_some_and(|next| next.is_ascii_digit()) {
                    return true;
                }
            }
            '\\' => {
                index += 1;
                if index >= chars.len() {
                    break;
                }
                if matches!(
                    chars[index],
                    'd' | 'D' | 'w' | 'W' | 's' | 'S' | '|' | '(' | ')' | '{' | '}' | '[' | ']'
                ) {
                    return true;
                }
            }
            _ => {}
        }
        index += 1;
    }
    false
}

/// 「像正则」判定（供 literal 空结果提示）：出现结构性正则元字符（交替 / 分组 / 重复 /
/// 类简写 / 转义元字符）即真。Windows 路径不按正则解读；`.`/`*`/`[` 等常见字面符号不算。
pub fn looks_like_regex(pattern: &str) -> bool {
    if pattern.contains(':') && pattern.contains('\\') {
        return false;
    }
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '|' | '(' | ')' | '{' | '}' => return true,
            '\\' => {
                index += 1;
                if index >= chars.len() {
                    break;
                }
                if matches!(
                    chars[index],
                    'd' | 'D' | 'w' | 'W' | 's' | 'S' | '|' | '(' | ')' | '{' | '}' | '[' | ']'
                ) {
                    return true;
                }
            }
            _ => {}
        }
        index += 1;
    }
    false
}

/// 简易正则匹配（手写、无依赖、确定性）：交替 / 分组 / 量词 / 锚点 / 字符类 / 类简写。
/// 语法不合法时退化为字面匹配（调用方在 regex 模式下已先经 `regex_unsupported` 校验）。
pub fn regex_search(pattern: &str, text: &str) -> bool {
    let Ok(ast) = parse(pattern) else {
        return text.contains(pattern);
    };
    let chars: Vec<char> = text.chars().collect();
    for start in 0..=chars.len() {
        if !ends(&ast, &chars, start).is_empty() {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone)]
enum Ast {
    Empty,
    Char(char),
    Any,
    Class { negated: bool, items: Vec<(char, char)> },
    Start,
    End,
    Seq(Vec<Ast>),
    Alt(Vec<Ast>),
    Repeat { inner: Box<Ast>, min: usize, max: Option<usize> },
}

/// 解析为 AST；`Err(reason)` 为语法错误（`regex_unsupported` 复用同一口径）。
fn parse(pattern: &str) -> Result<Ast, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut parser = Parser { chars: &chars, pos: 0 };
    let ast = parser.parse_alt()?;
    if parser.pos != parser.chars.len() {
        return Err(format!("unexpected `{}`", parser.chars[parser.pos]));
    }
    Ok(ast)
}

struct Parser<'a> {
    chars: &'a [char],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    /// `alt := seq ('|' seq)*`
    fn parse_alt(&mut self) -> Result<Ast, String> {
        let mut branches = vec![self.parse_seq()?];
        while self.peek() == Some('|') {
            self.pos += 1;
            branches.push(self.parse_seq()?);
        }
        if branches.len() == 1 {
            Ok(branches.pop().unwrap())
        } else {
            Ok(Ast::Alt(branches))
        }
    }

    /// `seq := term*`；到 `|` / `)` / 结尾停。
    fn parse_seq(&mut self) -> Result<Ast, String> {
        let mut nodes = Vec::new();
        while let Some(ch) = self.peek() {
            if ch == '|' || ch == ')' {
                break;
            }
            nodes.push(self.parse_term()?);
        }
        if nodes.is_empty() {
            Ok(Ast::Empty)
        } else if nodes.len() == 1 {
            Ok(nodes.pop().unwrap())
        } else {
            Ok(Ast::Seq(nodes))
        }
    }

    /// `term := atom quant?`
    fn parse_term(&mut self) -> Result<Ast, String> {
        let atom = self.parse_atom()?;
        let quant = match self.peek() {
            Some('*') => {
                self.pos += 1;
                Some((0, None))
            }
            Some('+') => {
                self.pos += 1;
                Some((1, None))
            }
            Some('?') => {
                self.pos += 1;
                Some((0, Some(1)))
            }
            Some('{') => self.try_parse_braces()?,
            _ => None,
        };
        match quant {
            Some((min, max)) => Ok(Ast::Repeat { inner: Box::new(atom), min, max }),
            None => Ok(atom),
        }
    }

    /// 解析 `{n}` / `{n,}` / `{n,m}`；不是合法重复时把 `{` 留给 `parse_atom` 当字面。
    fn try_parse_braces(&mut self) -> Result<Option<(usize, Option<usize>)>, String> {
        let save = self.pos;
        self.pos += 1; // 吃掉 '{'
        let Some((min, after_min)) = self.read_number() else {
            self.pos = save;
            return Ok(None);
        };
        self.pos = after_min;
        if self.peek() == Some('}') {
            self.pos += 1;
            return Ok(Some((min, Some(min))));
        }
        if self.peek() == Some(',') {
            self.pos += 1;
            if self.peek() == Some('}') {
                self.pos += 1;
                return Ok(Some((min, None)));
            }
            if let Some((max, after_max)) = self.read_number() {
                self.pos = after_max;
                if self.peek() == Some('}') {
                    self.pos += 1;
                    if max < min {
                        return Err(format!("repetition {{{min},{max}}} has max < min"));
                    }
                    return Ok(Some((min, Some(max))));
                }
            }
        }
        self.pos = save;
        Ok(None)
    }

    fn read_number(&self) -> Option<(usize, usize)> {
        let start = self.pos;
        let mut index = start;
        while index < self.chars.len() && self.chars[index].is_ascii_digit() {
            index += 1;
        }
        if index == start {
            return None;
        }
        let text: String = self.chars[start..index].iter().collect();
        Some((text.parse::<usize>().ok()?, index))
    }

    fn parse_atom(&mut self) -> Result<Ast, String> {
        let ch = self.peek().ok_or_else(|| "unexpected end of pattern".to_string())?;
        match ch {
            '(' => {
                self.pos += 1;
                let inner = self.parse_alt()?;
                if self.peek() != Some(')') {
                    return Err("unclosed group `(`".to_string());
                }
                self.pos += 1;
                Ok(inner)
            }
            '[' => {
                let (ast, next) = parse_class(self.chars, self.pos)
                    .ok_or_else(|| "unclosed character class `[`".to_string())?;
                self.pos = next;
                Ok(ast)
            }
            '.' => {
                self.pos += 1;
                Ok(Ast::Any)
            }
            '^' => {
                self.pos += 1;
                Ok(Ast::Start)
            }
            '$' => {
                self.pos += 1;
                Ok(Ast::End)
            }
            '\\' => {
                self.pos += 1;
                let escaped = self.peek().ok_or_else(|| "trailing backslash `\\`".to_string())?;
                self.pos += 1;
                escape_atom(escaped)
            }
            '*' | '+' | '?' => Err(format!("quantifier `{ch}` has nothing to repeat")),
            _ => {
                self.pos += 1;
                Ok(Ast::Char(ch))
            }
        }
    }
}

/// 转义原子：类简写 / 控制字符 / 元字符字面；未知转义报错。
fn escape_atom(escaped: char) -> Result<Ast, String> {
    let class = |negated: bool, items: &[(char, char)]| Ast::Class { negated, items: items.to_vec() };
    const WORD: [(char, char); 4] = [('0', '9'), ('A', 'Z'), ('a', 'z'), ('_', '_')];
    const SPACE: [(char, char); 4] = [(' ', ' '), ('\t', '\t'), ('\n', '\n'), ('\r', '\r')];
    match escaped {
        'd' => Ok(class(false, &[('0', '9')])),
        'D' => Ok(class(true, &[('0', '9')])),
        'w' => Ok(class(false, &WORD)),
        'W' => Ok(class(true, &WORD)),
        's' => Ok(class(false, &SPACE)),
        'S' => Ok(class(true, &SPACE)),
        'n' => Ok(Ast::Char('\n')),
        't' => Ok(Ast::Char('\t')),
        'r' => Ok(Ast::Char('\r')),
        c if ".*+?[](){}|\\^$".contains(c) => Ok(Ast::Char(c)),
        other => Err(format!("unsupported escape `\\{other}`")),
    }
}

fn parse_class(chars: &[char], start: usize) -> Option<(Ast, usize)> {
    let mut index = start + 1;
    let mut negated = false;
    if index < chars.len() && (chars[index] == '!' || chars[index] == '^') {
        negated = true;
        index += 1;
    }
    let mut items = Vec::new();
    let mut first = true;
    while index < chars.len() {
        if chars[index] == ']' && !first {
            return Some((Ast::Class { negated, items }, index + 1));
        }
        first = false;
        let low = chars[index];
        if index + 2 < chars.len() && chars[index + 1] == '-' && chars[index + 2] != ']' {
            items.push((low, chars[index + 2]));
            index += 3;
            continue;
        }
        items.push((low, low));
        index += 1;
    }
    None
}

/// 从 `pos` 起，`ast` 所有可能的结束位置（去重、升序）；空 = 不匹配。
fn ends(ast: &Ast, text: &[char], pos: usize) -> Vec<usize> {
    let mut out = Vec::new();
    match ast {
        Ast::Empty => out.push(pos),
        Ast::Char(expected) => {
            if pos < text.len() && text[pos] == *expected {
                out.push(pos + 1);
            }
        }
        Ast::Any => {
            if pos < text.len() {
                out.push(pos + 1);
            }
        }
        Ast::Start => {
            if pos == 0 {
                out.push(pos);
            }
        }
        Ast::End => {
            if pos == text.len() {
                out.push(pos);
            }
        }
        Ast::Class { negated, items } => {
            if pos < text.len() {
                let hit = items.iter().any(|(low, high)| *low <= text[pos] && text[pos] <= *high);
                if hit != *negated {
                    out.push(pos + 1);
                }
            }
        }
        Ast::Seq(nodes) => {
            let mut positions = vec![pos];
            for node in nodes {
                let mut next = Vec::new();
                for start in positions {
                    next.extend(ends(node, text, start));
                }
                dedup(&mut next);
                if next.is_empty() {
                    return Vec::new();
                }
                positions = next;
            }
            out = positions;
        }
        Ast::Alt(branches) => {
            for branch in branches {
                out.extend(ends(branch, text, pos));
            }
        }
        Ast::Repeat { inner, min, max } => {
            let mut positions = vec![pos];
            let mut count = 0usize;
            loop {
                if count >= *min {
                    out.extend(positions.iter().copied());
                }
                if max.is_some_and(|max| count >= max) {
                    break;
                }
                let mut next = Vec::new();
                for start in &positions {
                    for end in ends(inner, text, *start) {
                        // 跳过零宽推进，避免 `(a?)*` 之类死循环。
                        if end != *start {
                            next.push(end);
                        }
                    }
                }
                dedup(&mut next);
                if next.is_empty() {
                    break;
                }
                positions = next;
                count += 1;
                if count > text.len() + 1 {
                    break;
                }
            }
        }
    }
    dedup(&mut out);
    out
}

fn dedup(values: &mut Vec<usize>) {
    values.sort_unstable();
    values.dedup();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_basics() {
        assert!(glob_match("*.rs", "main.rs"));
        assert!(!glob_match("*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "src/main.rs"));
        assert!(glob_match("**/*.rs", "main.rs"));
        assert!(glob_match("src/*.rs", "src/main.rs"));
        assert!(!glob_match("src/*.rs", "src/nested/main.rs"));
        assert!(glob_match("a?c", "abc"));
        assert!(glob_match("[a-c]x", "bx"));
        assert!(!glob_match("[!a-c]x", "bx"));
        assert!(glob_match("**", "any/deep/path"));
    }

    #[test]
    fn glob_brace_groups() {
        // 逗号分组：文件类型过滤的主要用法。
        assert!(glob_match("*.{py,yml,yaml}", "app.py"));
        assert!(glob_match("*.{py,yml,yaml}", "ci.yml"));
        assert!(!glob_match("*.{py,yml,yaml}", "app.rs"));
        // 分组只替换所在段，前缀 / 后缀保持。
        assert!(glob_match("src/*.{rs,md}", "src/lib.rs"));
        assert!(!glob_match("src/*.{rs,md}", "tests/lib.rs"));
        // 跨目录 `**` 与分组共存。
        assert!(glob_match("**/*.{rs,md}", "a/b/c.md"));
        assert!(glob_match("**/*.{rs,md}", "c.md"));
        // 嵌套分组。
        assert!(glob_match("{a,{b,c}}.txt", "b.txt"));
        assert!(glob_match("{a,{b,c}}.txt", "c.txt"));
        assert!(glob_match("{a,{b,c}}.txt", "a.txt"));
        assert!(!glob_match("{a,{b,c}}.txt", "d.txt"));
        // 整数区间（含降序）。
        assert!(glob_match("file{1..3}.txt", "file2.txt"));
        assert!(!glob_match("file{1..3}.txt", "file4.txt"));
        assert!(glob_match("v{3..1}.log", "v2.log"));
        // 空候选：`{a,}` 允许匹配无后缀部分。
        assert!(glob_match("a{,x}", "a"));
        assert!(glob_match("a{,x}", "ax"));
        // 无逗号且非区间 → 字面：`{a}` 只匹配含花括号的字面文本。
        assert!(glob_match("{a}.txt", "{a}.txt"));
        assert!(!glob_match("{a}.txt", "a.txt"));
        // 未闭合 `{` 按字面处理。
        assert!(glob_match("a{b", "a{b"));
        // 区间超上限按字面处理，不展开成海量候选。
        assert!(glob_match("{1..1000}", "{1..1000}"));
        assert!(!glob_match("{1..1000}", "5"));
    }

    #[test]
    fn regex_basics() {
        assert!(regex_search("abc", "xxabcxx"));
        assert!(regex_search("^abc", "abcxx"));
        assert!(!regex_search("^abc", "xabc"));
        assert!(regex_search("abc$", "xxabc"));
        assert!(regex_search("a.c", "azc"));
        assert!(regex_search("ab*c", "ac"));
        assert!(regex_search("ab*c", "abbbc"));
        assert!(regex_search("ab+c", "ac") == false);
        assert!(regex_search("ab+c", "abc"));
        assert!(regex_search("colou?r", "color"));
        assert!(regex_search("colou?r", "colour"));
        assert!(regex_search("[0-9]+", "abc123"));
        assert!(!regex_search("[0-9]+", "abc"));
        assert!(regex_search(r"a\.b", "a.b"));
        assert!(!regex_search(r"a\.b", "axb"));
    }

    #[test]
    fn regex_syntax_errors_are_reported() {
        // 真语法错误：未闭合类 / 未闭合分组 / 悬空量词 / 尾反斜杠 / 未知转义 / max<min。
        assert!(regex_unsupported("[abc").is_some());
        assert!(regex_unsupported("(foo").is_some());
        assert!(regex_unsupported("*foo").is_some());
        assert!(regex_unsupported(r"a\").is_some());
        assert!(regex_unsupported(r"\q").is_some());
        assert!(regex_unsupported("a{3,1}").is_some());
        // 现已支持：交替 / 分组 / 重复 / 类简写 / 转义元字符。
        assert!(regex_unsupported("foo|bar").is_none());
        assert!(regex_unsupported("(foo)").is_none());
        assert!(regex_unsupported("a{2,3}").is_none());
        assert!(regex_unsupported(r"\d+").is_none());
        assert!(regex_unsupported("^fn .*\\(\\)").is_none());
        assert!(regex_unsupported("[0-9]+").is_none());
        assert!(regex_unsupported(r"a\.b").is_none());
        assert!(regex_unsupported("colou?r").is_none());
        assert!(regex_unsupported("plain text").is_none());
    }

    #[test]
    fn regex_alternation_grouping_and_classes() {
        assert!(regex_search("foo|bar", "xx bar xx"));
        assert!(regex_search("apiKey|api_key", "const api_key = 1"));
        assert!(!regex_search("foo|bar", "baz"));
        assert!(regex_search("(apiKey|api_key)", "let apiKey = 1"));
        assert!(regex_search("^(GET|POST) /", "POST /x"));
        assert!(!regex_search("^(GET|POST) /", "PUT /x"));
        assert!(regex_search(r"(TODO|FIXME|HACK)", "// HACK: x"));
        assert!(regex_search(r"\d{3}-\d{4}", "call 555-1234"));
        assert!(regex_search(r"\w+@\w+", "mail a@b end"));
        assert!(regex_search("a{2,3}", "aaa"));
        assert!(!regex_search("a{4}", "aaa"));
        assert!(regex_search("ab?|cd+", "acdd"));
        assert!(regex_search("foo(bar|baz)qux", "foobazqux"));
        assert!(!regex_search("foo(bar|baz)qux", "foobar"));
    }

    #[test]
    fn literal_empty_hint_only_for_regex_like_patterns() {
        // 像正则但不支持的形态：给提示（说明是字面搜索）。
        assert!(literal_empty_hint("TODO|FIXME").is_some());
        assert!(literal_empty_hint("a{2,3}").is_some());
        assert!(literal_empty_hint("(foo)").is_some());
        // 被转义的元字符：正则里是字面量，字面搜索会连反斜杠一起匹配 → 也提示。
        assert!(literal_empty_hint(r"apiKey\|api_key").is_some());
        assert!(literal_empty_hint(r"a\(b\)").is_some());
        assert!(literal_empty_hint(r"items\[0\]").is_some());
        // 纯文本 / 常见路径：不打扰。
        assert!(literal_empty_hint("plain text").is_none());
        assert!(literal_empty_hint("fn main").is_none());
        assert!(literal_empty_hint("TODO").is_none());
        assert!(literal_empty_hint(r"C:\Users\anyi").is_none());
    }

    #[test]
    fn regex_intent_only_strong_signals() {
        // 强信号：交替 / 类简写 / `{n}` / 转义元字符。
        assert!(regex_intent("TODO|FIXME"));
        assert!(regex_intent("(apiKey|api_key)"));
        assert!(regex_intent(r"\d+"));
        assert!(regex_intent("a{2,3}"));
        assert!(regex_intent(r"foo\|bar"));
        // 常见代码 / 路径 / 纯文本不误判。
        assert!(!regex_intent("fn main()"));
        assert!(!regex_intent("if (x)"));
        assert!(!regex_intent("[error]"));
        assert!(!regex_intent("plain text"));
        assert!(!regex_intent(r"C:\Users\anyi"));
    }

    #[test]
    fn regex_quantifier_backtracking() {
        assert!(regex_search("a.*b", "axxxb"));
        assert!(regex_search("a.*b.*c", "a1b2c3"));
        assert!(regex_search("^a+$", "aaaa"));
        assert!(!regex_search("^a+$", "aaab"));
    }
}
