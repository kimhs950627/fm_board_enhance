#!/usr/bin/env python3
"""hierarchy_audit.py — 대단원별로 '아직 평평한' 소단원을 찾아 보고서를 만든다.

점수 = 긴 불릿 목록 + 콜론 라벨이 많은데 들여쓰기가 거의 없는 섹션.
새벽 작업이 이 보고서의 1순위 대단원 하나를 골라 계층을 다듬는다.

  python3 scripts/hierarchy_audit.py            # reports/hierarchy-audit.md 생성
  python3 scripts/hierarchy_audit.py --print    # 표준출력만
  python3 scripts/hierarchy_audit.py --top      # 1순위 대단원 이름만
"""

from __future__ import annotations

import glob
import os
import re
import sys


def sections(lines: list[str]):
    cur, sec = None, []
    for line in lines:
        if line.startswith("### "):
            if cur is not None:
                yield cur, sec
            cur, sec = line[4:].strip(), []
        elif line.startswith("## "):
            if cur is not None:
                yield cur, sec
            cur, sec = None, []
        elif cur is not None:
            sec.append(line)
    if cur is not None:
        yield cur, sec


def audit(path: str) -> list[tuple[int, str, str]]:
    division = os.path.basename(path)[:-3]
    lines = open(path, encoding="utf-8").read().split("\n")
    rows = []
    for name, body in sections(lines):
        bullets = [l for l in body if l.strip().startswith("-")]
        nested = [l for l in body if re.match(r"^\s{2,}-", l)]
        labelled = [l for l in body if re.match(r"^\s*- [^:：]{2,30}[:：]", l)]
        if len(bullets) < 8:
            continue
        flat = len(bullets) - len(nested)
        score = flat + 2 * len(labelled)
        if score >= 12:
            rows.append((score, division, name))
    return rows


def main() -> int:
    rows: list[tuple[int, str, str]] = []
    for path in sorted(glob.glob("base/*.md")):
        rows.extend(audit(path))
    rows.sort(reverse=True)

    if "--top" in sys.argv:
        print(rows[0][1] if rows else "")
        return 0

    lines = ["# 계층 점검 — 아직 평평한 소단원", ""]
    if not rows:
        lines.append("남은 항목이 없다.")
    else:
        lines.append("| 점수 | 대단원 | 소단원 |")
        lines.append("|---|---|---|")
        for score, division, name in rows[:40]:
            lines.append(f"| {score} | {division} | {name} |")
    text = "\n".join(lines) + "\n"

    if "--print" in sys.argv:
        print(text)
        return 0

    os.makedirs("reports", exist_ok=True)
    open("reports/hierarchy-audit.md", "w", encoding="utf-8").write(text)
    print(f"{len(rows)}개 섹션 → reports/hierarchy-audit.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
