#!/usr/bin/env python3
"""生成 execute/casefold.rs：Unicode Default Case Folding（C+F 全量）表。

用法：python tools/gen-casefold.py
数据来源：本机 Python 的 unicodedata（对应其 Unicode 版本），故表是可复现的纯数据；
ASCII 码位由 Rust 侧 fast path（to_ascii_lowercase）处理，不进表，以缩小体积。
生成物随源码入世（execute/ 入世）；本脚本在 tools/（`.worldignore` 声明不入世）。
"""

import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "execute" / "casefold_table.rs"


def rust_str(text: str) -> str:
    return '"' + "".join(f"\\u{{{ord(ch):x}}}" for ch in text) + '"'


def main() -> int:
    version = unicodedata.unidata_version
    entries: list[tuple[int, str]] = []
    for cp in range(0x80, 0x110000):
        if 0xD800 <= cp <= 0xDFFF:  # 代理区无字符
            continue
        ch = chr(cp)
        folded = ch.casefold()
        if folded != ch:
            entries.append((cp, folded))
    entries.sort(key=lambda item: item[0])

    lines: list[str] = []
    lines.append("// 生成文件：请勿手改，改动请跑 tools/gen-casefold.py 重新生成。")
    lines.append(f"// 数据：Unicode Default Case Folding（C+F 全量），Unicode {version}。")
    lines.append("// 语义：casefold 只做码位折叠，**不含** NFC/NFD 规范化（组合形 / 分解形不互相匹配）。")
    lines.append("// ASCII 由 fast path 处理（to_ascii_lowercase），表内仅非 ASCII 码位，按码位升序。")
    lines.append("")
    lines.append(f'pub const UNICODE_VERSION: &str = "{version}";')
    lines.append("")
    lines.append("/// 非 ASCII 码位 → casefold 结果（升序，供二分查找）。")
    lines.append(f"pub static CASEFOLD: &[(u32, &str)] = &[")
    for cp, folded in entries:
        lines.append(f"    (0x{cp:X}, {rust_str(folded)}),")
    lines.append("];")
    lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"wrote {OUT} ({len(entries)} entries, Unicode {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
