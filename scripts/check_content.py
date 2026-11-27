#!/usr/bin/env python3
"""check_content.py — base 가 '다룬 내용'을 잃지 않았는지 검사한다.

의미가 같으면 문장을 다듬거나 짧게 줄여도 된다. 다만 **주제 자체가 사라지는 것**은 막는다.
그래서 글자 단위 비교 대신 다음 네 가지를 본다.

  1) 수치·단위     126mg/dL, 4.5시간, 6.5% …
  2) 영문 고유명   Metformin, SGLT2, eGFR, CHA₂DS₂-VASc …
  3) 소단원 제목   '### X' 의 X 가 새 파일 어딘가에 남아 있는가
  4) 분량          새 파일이 HEAD 판의 80% 이상인가

  python3 scripts/check_content.py base/내분비.md
  python3 scripts/check_content.py --changed
  exit 0 = 유지, 1 = 삭제 의심
"""

from __future__ import annotations

import re
import subprocess
import sys

NUMBER = re.compile(r"\d+(?:[.,]\d+)?\s*(?:mg/dL|mg|mL|mEq/L|mmHg|%|시간|분|초|일|주|개월|년|세|도|g|kg|IU/L|U/L|ng/mL|pg/mL)?")
LATIN = re.compile(r"[A-Za-z][A-Za-z0-9₂₃₄+\-]{1,}")
TITLE = re.compile(r"^#{2,3}\s+(.+)$", re.M)
STOP_LATIN = {"the", "and", "or", "vs", "with", "without", "type"}


def head_text(path: str) -> str:
    result = subprocess.run(["git", "show", f"HEAD:{path}"], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else ""


def entities(text: str) -> tuple[set[str], set[str]]:
    numbers = {m.group(0).replace(" ", "") for m in NUMBER.finditer(text) if any(c.isdigit() for c in m.group(0))}
    latin = {w for w in LATIN.findall(text) if w.lower() not in STOP_LATIN}
    return numbers, latin


def check(path: str, quiet: bool, ignore_titles: bool = False) -> bool:
    old = head_text(path)
    if not old:
        return True
    new = open(path, encoding="utf-8").read()

    for lineno, line in enumerate(new.split("\n"), 1):
        if "###" in line and not line.lstrip().startswith("#"):
            print(f"  ! {path}:{lineno}: 제목 표식이 본문에 섞임 → {line.strip()[:60]}")
            return False

    old_nums, old_latin = entities(old)
    new_nums, new_latin = entities(new)
    lost_nums = sorted(old_nums - new_nums)
    lost_latin = sorted(old_latin - new_latin)

    lost_titles = []
    if not ignore_titles:
        for title in TITLE.findall(old):
            key = re.sub(r"\s+", " ", title.strip())
            if key and key not in new:
                lost_titles.append(key)

    ratio = len(new) / max(1, len(old))

    if lost_nums or lost_latin or lost_titles or ratio < 0.8:
        if not quiet:
            if lost_nums:
                print(f"  ! {path}: 수치 사라짐 → {', '.join(lost_nums[:8])}")
            if lost_latin:
                print(f"  ! {path}: 고유명 사라짐 → {', '.join(lost_latin[:8])}")
            if lost_titles:
                print(f"  ! {path}: 소단원 제목 사라짐 → {', '.join(lost_titles[:4])}")
            if ratio < 0.8:
                print(f"  ! {path}: 분량 {ratio:.0%} 로 줄어듦")
        return False
    return True


def changed_files() -> list[str]:
    result = subprocess.run(["git", "diff", "--name-only", "--", "base"], capture_output=True, text=True)
    return [line for line in result.stdout.split("\n") if line.endswith(".md")]


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    quiet = "--quiet" in sys.argv
    # --ignore-titles: 제목 레벨 변경·껍데기 제거를 하는 계층 작업용.
    # 글자(수치·고유명·분량)는 그대로 검사하고 제목 존재 검사만 건너뛴다.
    ignore_titles = "--ignore-titles" in sys.argv
    paths = changed_files() if "--changed" in sys.argv else args
    ok = True
    for path in paths:
        if not check(path, quiet, ignore_titles):
            ok = False
    print("내용 보존 확인(수치·고유명·제목·분량)" + (" — 통과" if ok else " — 삭제 의심"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
