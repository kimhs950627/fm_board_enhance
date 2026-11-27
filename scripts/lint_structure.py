#!/usr/bin/env python3
"""lint_structure.py — base/*.md 의 구조를 전수 검사한다.

점검 항목
  1) 제목 앞뒤 빈 줄     `### X` 바로 앞/뒤에 빈 줄이 없으면 붙은 제목으로 본다
  2) 제목 수준           `##` 없이 `###` 만 있거나, `####` 부모가 어긋난 경우
  3) 중복 소단원 제목    같은 파일 안에서 같은 `### X` 가 두 번 이상
  4) 중복 본문 줄        같은 문장이 두 섹션에 걸쳐 반복
  5) 빈 섹션             제목만 있고 본문이 없는 소단원
  6) 본문에 섞인 제목    줄 중간에 `##` 이 들어간 경우

  python3 scripts/lint_structure.py            # 요약 + 상세
  python3 scripts/lint_structure.py --json     # 기계 판독
  python3 scripts/lint_structure.py --fix      # 1) 빈 줄 누락만 자동 수정
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys
from collections import defaultdict

HEAD = re.compile(r"^(#{2,6})\s+(.*\S)\s*$")
STOP = {"-", "*", "", "```"}


def scan(path: str) -> dict:
    lines = open(path, encoding="utf-8").read().split("\n")
    problems: list[dict] = []

    def add(kind: str, line: int, detail: str) -> None:
        problems.append({"kind": kind, "line": line, "detail": detail})

    headings: list[tuple[int, int, str]] = []  # (lineno, level, text)
    for i, line in enumerate(lines, 1):
        m = HEAD.match(line)
        if not m:
            # 6) 본문 중간에 섞인 제목
            if re.search(r"\S\s*#{2,4}\s+\S", line) and not line.lstrip().startswith("#"):
                add("glued-inline", i, line[:90])
            continue
        headings.append((i, len(m.group(1)), m.group(2)))

    # 1) 제목 앞뒤 빈 줄
    for idx, (lineno, level, text) in enumerate(headings):
        prev = lines[lineno - 2] if lineno >= 2 else ""
        nxt = lines[lineno] if lineno < len(lines) else ""
        if prev.strip() and not HEAD.match(prev):
            add("no-blank-before", lineno, f"{'#'*level} {text}")
        if nxt.strip():
            add("no-blank-after", lineno, f"{'#'*level} {text}")

    # 2) 제목 수준: ### 이 ## 없이 나오는 것은 이 저장소 규약상 정상 → 건너뜀
    #    다만 #### 의 부모가 ### 인지 확인
    stack: list[tuple[int, str]] = []
    for lineno, level, text in headings:
        while stack and stack[-1][0] >= level:
            stack.pop()
        if level >= 4 and not stack:
            add("orphan-heading", lineno, f"{'#'*level} {text} (부모 ### 없음)")
        stack.append((level, text))

    # 3) 중복 소단원 제목 (### 만)
    seen: dict[str, int] = {}
    for lineno, level, text in headings:
        if level != 3:
            continue
        key = re.sub(r"\s+", " ", text.strip())
        if key in seen:
            add("dup-heading", lineno, f"### {text} (첫 등장 {seen[key]}행)")
        else:
            seen[key] = lineno

    # 4) 중복 본문 줄
    body_owner: dict[str, tuple[int, str]] = {}
    owner = ""
    for i, line in enumerate(lines, 1):
        m = HEAD.match(line)
        if m:
            owner = m.group(2) if len(m.group(1)) == 3 else owner
            continue
        stripped = line.strip()
        if len(stripped) < 25 or stripped in STOP or stripped.startswith("```"):
            continue
        key = re.sub(r"\s+", " ", stripped)
        if key in body_owner:
            first_line, first_owner = body_owner[key]
            if first_owner != owner:
                add("dup-body", i, f"[{owner}] ← [{first_owner}:{first_line}행] {stripped[:60]}")
        else:
            body_owner[key] = (i, owner)

    # 5) 빈 섹션 — '###' 아래에 '####' 자식이 있으면 비어 있는 게 아니다
    for idx, (lineno, level, text) in enumerate(headings):
        if level != 3:
            continue
        end = headings[idx + 1][0] - 1 if idx + 1 < len(headings) else len(lines)
        body = [l for l in lines[lineno:end - 1] if l.strip()]
        nxt = headings[idx + 1] if idx + 1 < len(headings) else None
        if not body and not (nxt and nxt[1] > level):
            add("empty-section", lineno, f"### {text}")

    return {"file": path, "lines": len(lines), "problems": problems}


def fix_blank_lines(path: str) -> int:
    lines = open(path, encoding="utf-8").read().split("\n")
    out: list[str] = []
    changed = 0
    for line in lines:
        if HEAD.match(line):
            if out and out[-1].strip():
                out.append("")
                changed += 1
        elif out and HEAD.match(out[-1]) and line.strip():
            out.append("")
            changed += 1
        out.append(line)
    if changed:
        open(path, "w", encoding="utf-8", newline="\n").write("\n".join(out))
    return changed


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    if "--fix" in sys.argv:
        total = 0
        for path in sorted(glob.glob("base/*.md")):
            n = fix_blank_lines(path)
            if n:
                print(f"{path}: 빈 줄 {n}곳 삽입")
                total += n
        print(f"빈 줄 {total}곳 수정")
        return 0

    results = [scan(p) for p in sorted(glob.glob("base/*.md"))]
    if "--json" in sys.argv:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    totals: dict[str, int] = defaultdict(int)
    for r in results:
        for p in r["problems"]:
            totals[p["kind"]] += 1

    print("== 종류별 ==")
    for kind, count in sorted(totals.items(), key=lambda kv: -kv[1]):
        print(f"{kind:18s} {count}")
    print()

    for r in results:
        if not r["problems"]:
            continue
        by_kind: dict[str, list[dict]] = defaultdict(list)
        for p in r["problems"]:
            by_kind[p["kind"]].append(p)
        print(f"## {os.path.basename(r['file'])} ({r['lines']}줄)")
        for kind in sorted(by_kind):
            for p in by_kind[kind][:12]:
                print(f"  [{kind}] {p['line']}행: {p['detail']}")
            if len(by_kind[kind]) > 12:
                print(f"  [{kind}] … 외 {len(by_kind[kind]) - 12}건")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
