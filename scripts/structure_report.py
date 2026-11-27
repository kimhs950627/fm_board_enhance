#!/usr/bin/env python3
"""structure_report.py — base/*.md 구조 전수조사 보고서.

lint_structure.py 의 결과에 '묶음 제목' 후보를 더해 reports/structure-audit.md 를 만든다.
묶음 제목 = 본문이 없는 ### 이고, 바로 다음에 다른 ### 이 오는 경우.
이들은 사실 소단원의 부모(중분류)인데 자식과 같은 ### 레벨로 평평하게 놓여 있다.

  python3 scripts/structure_report.py
"""

from __future__ import annotations

import glob
import os
import re
import sys
from collections import defaultdict

HEAD = re.compile(r"^(#{2,6})\s+(.*\S)\s*$")


def analyse(path: str) -> dict:
    lines = open(path, encoding="utf-8").read().split("\n")
    heads = [(i + 1, len(m.group(1)), m.group(2)) for i, line in enumerate(lines) if (m := HEAD.match(line))]

    groups: list[tuple[int, str, list[str]]] = []
    dup_heads: list[tuple[int, str, int]] = []
    seen: dict[str, int] = {}

    for idx, (lineno, level, title) in enumerate(heads):
        if level != 3:
            continue
        end = heads[idx + 1][0] - 1 if idx + 1 < len(heads) else len(lines)
        body = [l for l in lines[lineno:end - 1] if l.strip()]
        if not body:
            nxt = heads[idx + 1][2] if idx + 1 < len(heads) else "(파일 끝)"
            groups.append((lineno, title, nxt))
        key = re.sub(r"\s+", " ", title.strip())
        if key in seen:
            dup_heads.append((lineno, title, seen[key]))
        else:
            seen[key] = lineno

    # 중복 본문
    dup_body: list[tuple[int, str, int, str]] = []
    owner = ""
    first: dict[str, tuple[str, int]] = {}
    for i, line in enumerate(lines, 1):
        m = HEAD.match(line)
        if m:
            if len(m.group(1)) == 3:
                owner = m.group(2)
            continue
        s = line.strip()
        if len(s) < 25 or s.startswith(("```", "-", "*")):
            continue
        key = re.sub(r"\s+", " ", s)
        if key in first and first[key][0] != owner:
            dup_body.append((i, owner, first[key][1], s[:70]))
        else:
            first.setdefault(key, (owner, i))

    return {"file": path, "lines": len(lines), "heads": heads, "groups": groups,
            "dup_heads": dup_heads, "dup_body": dup_body}


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    data = [analyse(p) for p in sorted(glob.glob("base/*.md"))]
    total_groups = sum(len(d["groups"]) for d in data)
    total_dup_h = sum(len(d["dup_heads"]) for d in data)
    total_dup_b = sum(len(d["dup_body"]) for d in data)
    total_heads = sum(len([h for h in d["heads"] if h[1] == 3]) for d in data)

    out = ["# base 구조 전수조사", "",
           f"- 대단원 20개 · 소단원(###) {total_heads}개 · 전체 {sum(d['lines'] for d in data)}줄",
           f"- 묶음 제목(본문 없는 ###) **{total_groups}개** — 자식과 같은 레벨로 평평하게 놓임",
           f"- 중복 소단원 제목 **{total_dup_h}개**",
           f"- 섹션 간 중복 본문 **{total_dup_b}건**",
           "",
           "## 1. 묶음 제목 (중분류가 평평하게 놓인 곳)", "",
           "이 제목들은 아래 항목들의 부모인데 같은 `###` 레벨이라 목차·북마크에서 형제로 보인다.", ""]

    for d in data:
        if not d["groups"]:
            continue
        out.append(f"### {os.path.basename(d['file'])}")
        out.append("")
        out.append("| 행 | 묶음 제목 | 바로 다음 항목 |")
        out.append("|---|---|---|")
        for lineno, title, nxt in d["groups"]:
            out.append(f"| {lineno} | {title} | {nxt} |")
        out.append("")

    out += ["## 2. 중복 소단원 제목", ""]
    if not total_dup_h:
        out.append("없음.")
    for d in data:
        for lineno, title, first in d["dup_heads"]:
            out.append(f"- `{os.path.basename(d['file'])}:{lineno}` **{title}** (첫 등장 {first}행)")
    out.append("")

    out += ["## 3. 섹션 간 중복 본문", "",
            "같은 문장이 서로 다른 소단원에 있다. 질환이 다르면 같은 치료 문장이 반복되는 것이 정상일 수 있으므로",
            "자동 삭제하지 않고 목록만 남긴다.", ""]
    if not total_dup_b:
        out.append("없음.")
    for d in data:
        for lineno, owner, first_line, text in d["dup_body"]:
            out.append(f"- `{os.path.basename(d['file'])}:{lineno}` [{owner}] ← {first_line}행 — {text}")
    out.append("")

    text = "\n".join(out) + "\n"
    os.makedirs("reports", exist_ok=True)
    open("reports/structure-audit.md", "w", encoding="utf-8").write(text)
    print(f"묶음 제목 {total_groups}개 · 중복 제목 {total_dup_h}개 · 중복 본문 {total_dup_b}건 → reports/structure-audit.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
