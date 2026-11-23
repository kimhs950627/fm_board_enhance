#!/usr/bin/env python3
"""typeset_symbols.py — ASCII 로 적힌 기호를 실제 조판 기호로 바꾼다.

  ->  →   ←   ↔        =>  ⇒
  <=  ≤   >=  ≥        +/-  ±
  m^2   m²   10^-9  10⁻⁹

글자는 건드리지 않는다. 바뀌는 것은 기호뿐이고, 변환 결과는 로그로 보여 준다.

  python3 scripts/typeset_symbols.py --dry-run
  python3 scripts/typeset_symbols.py
"""

from __future__ import annotations

import glob
import re
import sys

SUP = str.maketrans("0123456789+-=()n", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ")

REPLACEMENTS = [
    ("<->", "↔"),
    ("<-->", "↔"),
    ("->", "→"),
    ("-->", "→"),
    ("=>", "⇒"),
    ("<-", "←"),
    ("<=", "≤"),
    ("=<", "≤"),
    (">=", "≥"),
    ("+/-", "±"),
    ("+-", "±"),
]


def superscript(match: re.Match) -> str:
    return match.group(1).translate(SUP)


def convert(text: str) -> tuple[str, int]:
    out = text
    changes = 0

    # 위첨자: ^2, ^-3, ^n, ^(2) 같은 형태만
    def sup(pattern: str):
        nonlocal changes
        before = out
        new = re.sub(pattern, superscript, out)
        if new != before:
            changes += before.count("^") - new.count("^")
            # 남아 있는 ^ 개수 차이로 세는 대신, 실제 치환 횟수를 센다
        return new

    out = re.sub(r"\^(-?\d+|n)\b", superscript, out)
    out = re.sub(r"\^\((-?\d+|n)\)", superscript, out)

    for old, new in REPLACEMENTS:
        if old in out:
            changes += out.count(old)
            out = out.replace(old, new)

    # 화살표가 두 번 겹친 경우 정리
    out = out.replace("→→", "→").replace("≤=", "≤").replace("≥=", "≥")
    return out, changes


def main() -> int:
    dry = "--dry-run" in sys.argv
    total = 0
    for path in sorted(glob.glob("base/*.md")):
        text = open(path, encoding="utf-8").read()
        updated, changes = convert(text)
        if not changes:
            continue
        total += changes
        print(f"  {path}: {changes}곳")
        if not dry:
            open(path, "w", encoding="utf-8").write(updated)
    print(f"기호 변환 {total}곳{' (미리보기)' if dry else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
