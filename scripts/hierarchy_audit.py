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


BURY = re.compile(r"[→]|\s-\s|\s{2,}|[:：]")
SENT = re.compile(r"\.\s")


def buried_layers(text: str) -> int:
    """한 줄에 몇 개의 계층이 뭉쳐 있는지 — 구분자와 문장 수로 센다."""
    body = text.strip().lstrip("-* ").strip()
    if len(body) < 60:
        return 0
    marks = len(BURY.findall(body))
    sentences = len(SENT.findall(body))
    return max(0, marks - 1) + max(0, sentences - 1)


def nesting_suspects(body: list[str]) -> int:
    """들여쓰기가 4칸 이상인데 부모가 없거나, 들여쓴 항목이 병명인 경우를 센다."""
    count = 0
    for i, line in enumerate(body):
        m = re.match(r"^(\s{4,})- ", line)
        if not m:
            continue
        prev = body[i - 1] if i > 0 else ""
        if not prev.strip().startswith("-"):
            count += 1
    return count


def audit(path: str) -> list[tuple[int, str, str]]:
    division = os.path.basename(path)[:-3]
    lines = open(path, encoding="utf-8").read().split("\n")
    rows = []
    for name, body in sections(lines):
        bullets = [l for l in body if l.strip().startswith("-")]
        nested = [l for l in body if re.match(r"^\s{2,}-", l)]
        labelled = [l for l in body if re.match(r"^\s*- [^:：]{2,30}[:：]", l)]
        buried = sum(buried_layers(l) for l in bullets)
        suspects = nesting_suspects(body)
        if len(bullets) < 8 and buried < 6:
            continue
        flat = len(bullets) - len(nested)
        score = flat + 2 * len(labelled) + 2 * buried + 3 * suspects
        if score >= 12:
            rows.append((score, division, name))
    return rows


def main() -> int:
# Windows 콘솔(cp949)에서도 한글·기호가 깨지지 않게
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
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
