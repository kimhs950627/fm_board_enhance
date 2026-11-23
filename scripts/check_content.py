#!/usr/bin/env python3
"""check_content.py — base 파일이 '글자를 잃지 않았는지' 검사한다.

LLM 이 계층을 정리하거나 새 기록을 병합할 때, 문장을 새로 쓰거나 옮기는 것은 괜찮지만
사실(수치·약물명·검사명)이 사라지면 안 된다. 이 스크립트는 git HEAD 판과 현재 파일의
단어 묶음을 비교해 사라진 단어가 있으면 알려 준다.

  python3 scripts/check_content.py base/내분비.md [--quiet]
  python3 scripts/check_content.py --changed           # git diff 로 바뀐 base 파일 전부

종료 코드: 0 = 보존, 1 = 단어 유실(호출한 쪽에서 되돌릴 것)
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections import Counter

# 계층 표식·불릿·강조는 단어가 아니므로 무시한다
NOISE = re.compile(r"^(#{1,6}|\*\*|[-*]$)")


def tokens(text: str) -> Counter:
    words: list[str] = []
    for line in text.split("\n"):
        line = re.sub(r"^\s*(?:#{1,6}\s*|[-*]\s*|\d+\)\s*)", "", line)
        line = line.replace("**", "").replace("`", "")
        for word in line.split():
            if NOISE.match(word):
                continue
            words.append(word)
    return Counter(words)


def head_text(path: str) -> str:
    result = subprocess.run(["git", "show", f"HEAD:{path}"], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else ""


def check(path: str, quiet: bool) -> bool:
    old = head_text(path)
    if not old:
        return True
    new = open(path, encoding="utf-8").read()
    lost = tokens(old) - tokens(new)
    lost.pop("-", None)
    if not lost:
        return True
    if not quiet:
        items = ", ".join(f"{word}×{count}" if count > 1 else word for word, count in lost.most_common(12))
        print(f"  ! {path}: 단어 유실 → {items}")
    return False


def changed_files() -> list[str]:
    result = subprocess.run(["git", "diff", "--name-only", "--", "base"], capture_output=True, text=True)
    return [line for line in result.stdout.split("\n") if line.endswith(".md")]


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    quiet = "--quiet" in sys.argv
    paths = changed_files() if "--changed" in sys.argv else args
    ok = True
    for path in paths:
        if not check(path, quiet):
            ok = False
    print("내용 보존 확인" + (" — 통과" if ok else " — 유실 있음"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
