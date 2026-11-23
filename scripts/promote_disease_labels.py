#!/usr/bin/env python3
"""promote_disease_labels.py — 병명이 불릿 머리에 있는 줄을 소단원으로 승격한다.

예)
  - 산후 갑상선염: 출산 후 1년 이내          →  ### 산후 갑상선염
  - Anti-TPO 항체(+), RAIU 감소 …              - 출산 후 1년 이내
                                               - Anti-TPO 항체(+) …

판정은 병명 어미(질환·증후군·병·염·증·암·부정맥·감염 …) 또는 괄호 안 영문명만 본다.
치료·진단처럼 병명이 아닌 라벨은 건드리지 않는다. 글자는 그대로 두고 위치만 바꾼다.

  python3 scripts/promote_disease_labels.py --dry-run
  python3 scripts/promote_disease_labels.py
  python3 scripts/promote_disease_labels.py --report      # 대단원별 후보만 출력
"""

from __future__ import annotations

import glob
import re
import sys

SUFFIX = re.compile(
    r"(질환|증후군|질병|병|염|암|종양|선종|부정맥|감염|골절|탈구|궤양|혈전증|색전증|부전|경색|"
    r"마비|중독|화상|탈장|낭종|용종|실신|혼수|쇼크|결절|협착|폐쇄|저하증|항진증)$"
)
BAD = set("0123456789+=<>?/\\%^[]{}~|")
VERBY = re.compile(r"(하는|되는|있는|없는|경우|때|중$|후$|전$|이상$|이하$|시$|및|등)")
STOP = re.compile(
    r"^(치료|진단|검사|증상|원인|합병증|분류|정의|예후|금기|주의|기타|총론|부작용|용법|투여|"
    r"적응증|참고|정리|감별|감별진단|치료원칙|예방|역학|병태생리|기전|경과|추적|재발|수술|약물|"
    r"생활|식이|운동|간호|설명|평가|분류기준|진단기준|치료기준|특징|소견|징후|합병|전신증상)"
)


def is_disease(label: str) -> bool:
    if STOP.match(label):
        return False
    if len(label) > 30:
        return False
    if any(ch in BAD for ch in label) or label.startswith(">"):
        return False
    if VERBY.search(label):
        return False
    if not re.search(r"[가-힣]", label):
        return False  # 영문 약어·검사명만 있는 라벨은 승격하지 않는다
    return bool(SUFFIX.search(label))


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


def split_section(body: list[str]) -> tuple[list[str], list[str]]:
    """섹션 본문을 [승격할 병명, 그 뒤에 붙일 자식] 단위로 재배치한 줄 목록을 만든다."""
    out: list[str] = []
    promoted: list[str] = []
    i = 0
    while i < len(body):
        line = body[i]
        m = re.match(r"^- ([^:：→]{2,34})[:：]\s*(\S.*)$", line.strip())
        bare = re.match(r"^- ([^:：→]{2,34})$", line.strip())

        label = None
        first = None
        children: list[str] = []

        if m and is_disease(m.group(1).strip()):
            label, first = m.group(1).strip(), m.group(2).strip()
            j = i + 1
            while j < len(body) and (body[j].startswith("  ") or not body[j].strip()):
                if body[j].strip():
                    children.append(body[j])
                j += 1
            i = j
        elif bare and is_disease(bare.group(1).strip()):
            j = i + 1
            kids: list[str] = []
            while j < len(body):
                nxt = body[j]
                if nxt.startswith("### "):
                    break
                if nxt.startswith("- "):
                    other = re.match(r"^- ([^:：→]{2,34})[:：]?", nxt.strip())
                    if other and is_disease(other.group(1).strip()) and kids:
                        break
                if nxt.strip():
                    kids.append(nxt)
                j += 1
            if len(kids) >= 2:
                label = bare.group(1).strip()
                children = kids
                i = j

        if label is None:
            out.append(line)
            i += 1
            continue

        if label:
            out.append("")
            out.append(f"### {label}")
            out.append("")
            if first:
                out.append(f"- {first}")
            for child in children:
                out.append(child[2:] if child.startswith("  ") else child)
            promoted.append(label)
            continue

        out.append(line)
        i += 1

    return out, promoted


def main() -> int:
# Windows 콘솔(cp949)에서도 한글·기호가 깨지지 않게
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    report = "--report" in sys.argv
    dry = "--dry-run" in sys.argv or report
    total = 0
    for path in sorted(glob.glob("base/*.md")):
        text = open(path, encoding="utf-8").read()
        lines = text.split("\n")
        new_lines: list[str] = []
        promoted_all: list[str] = []
        for name, body in sections(lines):
            start = lines.index(f"### {name}")
            new_lines.append(lines[start])
            moved, promoted = split_section(body)
            new_lines.extend(moved)
            promoted_all.extend(promoted)
        if not promoted_all:
            continue
        updated = "\n".join(new_lines)
        total += len(promoted_all)
        print(f"  {path}: {len(promoted_all)}개 — {', '.join(promoted_all[:5])}{' …' if len(promoted_all) > 5 else ''}")
        if not dry:
            open(path, "w", encoding="utf-8").write(updated)
    print(f"병명 승격 {total}개{' (미리보기)' if dry else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
