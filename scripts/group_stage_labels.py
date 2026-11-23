#!/usr/bin/env python3
"""group_stage_labels.py — 치료 단계 라벨 아래로 세부 불릿을 묶는다.

  - 급성기 치료
  - 혈역학적 불안정: Cardioversion      →    - 급성기 치료
  - 혈역학적 안정: CCB …                       - 혈역학적 불안정: Cardioversion
                                                - 혈역학적 안정: CCB …

'치료·검사·분류·예방·리듬 조절' 처럼 단계를 가리키는 짧은 불릿을 부모로 삼아
그 뒤에 오는 같은 층위 불릿을 두 칸 들여쓴다. 글자는 건드리지 않는다.

  python3 scripts/group_stage_labels.py --dry-run
  python3 scripts/group_stage_labels.py
"""

from __future__ import annotations

import glob
import re
import sys

STAGES = re.compile(
    r"^(- )?(치료|급성기 치료|만성 치료|약물 치료|수술 치료|재발 예방|뇌졸중 예방|예방|검사|진단|"
    r"분류|합병증|추적|경과 관찰|리듬 조절|속도 조절|rate control|rhythm control|"
    r"선별검사|감별|감별진단|치료 원칙|초기 치료|유지 치료|재활|교육|식이|운동)$"
)


def group(lines: list[str]) -> tuple[list[str], int]:
    out: list[str] = []
    grouped = 0
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^- (.*)$", line.strip())
        if m and STAGES.match(f"- {m.group(1).strip()}"):
            # 뒤따르는 같은 층위 불릿(들여쓰기 없는)을 자식으로
            j = i + 1
            kids: list[str] = []
            while j < len(lines):
                nxt = lines[j]
                if nxt.startswith("#") or (nxt.strip().startswith("- ") and not nxt.startswith(" ")):
                    break
                if nxt.strip():
                    kids.append(nxt)
                j += 1
            if len(kids) >= 1:
                out.append(line)
                for kid in kids:
                    out.append("  " + kid if not kid.startswith("  ") else kid)
                grouped += 1
                i = j
                continue
        out.append(line)
        i += 1
    return out, grouped


def main() -> int:
    dry = "--dry-run" in sys.argv
    total = 0
    for path in sorted(glob.glob("base/*.md")):
        text = open(path, encoding="utf-8").read()
        updated, grouped = group(text.split("\n"))
        if not grouped:
            continue
        total += grouped
        print(f"  {path}: {grouped}개 단계 묶음")
        if not dry:
            open(path, "w", encoding="utf-8").write("\n".join(updated))
    print(f"단계 묶음 {total}개{' (미리보기)' if dry else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
