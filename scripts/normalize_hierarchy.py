#!/usr/bin/env python3
"""normalize_hierarchy.py — 평평하게 늘어선 base 불릿에서 숨은 소단원을 끌어올린다.

문서 안에서 '- 병명' 줄 바로 아래에 들여쓴 '- 설명' 줄이 여러 개 붙어 있으면
그 병명은 사실 소단원 제목이다. '1) …' 처럼 번호로만 구분한 묶음도 마찬가지다.
이 스크립트는 그런 줄을 '### 제목' 으로 승격하고 자식 불릿을 두 칸 당긴다.

원칙: **글자는 그대로 둔다.** '#' 만 추가되고 공백만 바뀐다.
파일마다 단어 순서가 완전히 같은지 대조해, 다르면 그 파일은 건드리지 않고 되돌린다.

  python3 scripts/normalize_hierarchy.py            # 전체 base
  python3 scripts/normalize_hierarchy.py --dry-run  # 미리보기만
"""

from __future__ import annotations

import glob
import re
import sys

BOLD = re.compile(r"^\*\*.*\*\*")


def tokens(text: str) -> list[str]:
    """'#'·불릿 기호·공백을 지운 단어 목록. 승격 전후가 같아야 한다."""
    clean = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
    clean = re.sub(r"^\s*(?:[-*]|\d+\))\s*", "", clean, flags=re.M)
    clean = clean.replace("**", "")
    return clean.split()


def is_label(line: str) -> tuple[bool, str]:
    """소단원 제목 후보인가? (짧은 병명 줄, 콜론 없음)"""
    t = line.strip()
    bare = re.sub(r"^-\s*", "", t)
    bare = re.sub(r"^\d+\)\s*", "", bare)
    if not bare or len(bare) > 32:
        return False, ""
    if any(ch in bare for ch in ("：", ":", "→", ">", "|")):
        return False, ""
    if bare.endswith((".", ",", "?", "!")):
        return False, ""
    if BOLD.match(bare):
        return False, ""
    # 번호 라벨("1) …") 또는 불릿 라벨("- …")
    if re.match(r"^\d+\)\s*\S", t) or t.startswith("- "):
        return True, bare
    return False, ""


def promote_numbered(lines: list[str]) -> tuple[list[str], int]:
    """'1) 진단' 처럼 번호만 붙은 줄을 '### 진단' 으로 올린다(자식 불릿은 들여쓰지 않아도 됨)."""
    out: list[str] = []
    promoted = 0
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^(\d+)\)\s+(\S.*)$", line)
        if m and any(l.startswith("### ") for l in out):
            end = i + 1
            body = 0
            while end < len(lines):
                nxt = lines[end]
                if nxt.startswith("### ") or re.match(r"^\d+\)\s+\S", nxt):
                    break
                if nxt.strip():
                    body += 1
                end += 1
            if body >= 2:
                out.append("")
                out.append(f"### {m.group(2).strip()}")
                out.append("")
                out.extend(lines[i + 1:end])
                promoted += 1
                i = end
                continue
        out.append(line)
        i += 1
    return out, promoted


def normalize(text: str) -> tuple[str, int]:
    lines = text.split("\n")
    out: list[str] = []
    promoted = 0
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # 현재 소단원 안에서만 승격한다
        in_section = any(l.startswith("### ") for l in out)

        if in_section and line.startswith(" ") is False:
            ok, label = is_label(line)
            if ok:
                # 다음 줄이 들여쓴 자식인지 확인
                j = i + 1
                children: list[str] = []
                while j < len(lines) and (lines[j].startswith("  ") or not lines[j].strip()):
                    if lines[j].strip():
                        children.append(lines[j])
                    j += 1
                if len(children) >= 2:
                    out.append("")
                    out.append(f"### {label}")
                    out.append("")
                    for child in children:
                        out.append(child[2:] if child.startswith("  ") else child)
                    promoted += 1
                    i = j
                    continue

        out.append(line)
        i += 1

    numbered, extra = promote_numbered(out)
    return "\n".join(numbered), promoted + extra


def main() -> int:
# Windows 콘솔(cp949)에서도 한글·기호가 깨지지 않게
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    dry = "--dry-run" in sys.argv
    total = 0
    for path in sorted(glob.glob("base/*.md")):
        text = open(path, encoding="utf-8").read()
        updated, promoted = normalize(text)
        if not promoted:
            continue
        if tokens(text) != tokens(updated):
            print(f"  ! {path}: 글자가 달라져 건너뜀")
            continue
        total += promoted
        print(f"  {path}: 소단원 {promoted}개 승격")
        if not dry:
            open(path, "w", encoding="utf-8").write(updated)
    print(f"승격 {total}개{' (미리보기)' if dry else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
