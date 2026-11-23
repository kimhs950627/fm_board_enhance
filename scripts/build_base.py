#!/usr/bin/env python3
"""build_base.py — 단원별정리 docx 를 base md 로 바꾼다.

base 는 사용자가 기록(note)과 별개로 유지하는 '기본 교재'다. docx 를 다시 돌려도
사용자가 base 에 덧붙인 줄은 남도록, 이미 있는 파일은 새 내용을 덮지 않고
없는 소제목만 뒤에 붙인다(append-only). 강제로 다시 만들려면 --force.

  python3 scripts/build_base.py            # base/*.md 증분 갱신 + base/categories.json
  python3 scripts/build_base.py --force    # docx 내용으로 전부 다시 씀 (손댄 base 는 사라짐)
"""

from __future__ import annotations

import html
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCX_DIR = ROOT / "fm 보드시험 단원별정리"
BASE_DIR = ROOT / "base"
CATEGORIES = BASE_DIR / "categories.json"

PARA = re.compile(r"<w:p[ >].*?</w:p>", re.S)
TEXT = re.compile(r"<w:t[^>]*>([^<]*)</w:t>")
SECT = re.compile(r"^\[(.+?)\]$")


def text_of(paragraph: str) -> str:
    with_breaks = re.sub(r"<w:br[^>]*/>|<w:cr[^>]*/>", "\n", paragraph)
    return html.unescape("".join(TEXT.findall(with_breaks)))


def docx_lines(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    lines: list[str] = []
    for p in PARA.findall(xml):
        for line in text_of(p).split("\n"):
            # docx 안에서 공백으로 눌러 쓴 불릿("-   -   ")을 다시 줄로 나눈다
            lines.extend(re.split(r"\s{3,}(?=[-*●])", line))
    return lines


def is_heading(line: str) -> bool:
    """docx 의 소제목 줄. 불릿이 아니고 짧고 마침표로 끝나지 않는 줄."""
    t = line.strip()
    if not t or t[0] in "●-*→:" or t[0].isdigit():
        return False
    if len(t) > 60 or t.endswith((".", ":", "?")):
        return False
    return True


def render_note(lines: list[str]) -> list[str]:
    out: list[str] = []
    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        stripped = line.strip()
        if stripped.startswith("●"):
            out.append("- " + stripped[1:].strip())
        elif re.match(r"^\s+[-*]", line):
            out.append("  - " + re.sub(r"^\s+[-*]\s*", "", line))
        elif stripped.startswith("→"):
            out.append("  " + stripped)
        elif is_heading(stripped):
            out.append("### " + stripped)
        else:
            out.append(stripped)
    return out


def slug(name: str) -> str:
    return re.sub(r"[\\/:*?\"<>|]", "_", name).strip()


def build(force: bool) -> None:
    BASE_DIR.mkdir(exist_ok=True)
    if not DOCX_DIR.exists():
        raise SystemExit(f"docx 폴더가 없다: {DOCX_DIR}")

    # division -> part -> [(제목, [본문 줄])]
    sections: dict[str, dict[str, list[tuple[str, list[str]]]]] = {}
    sources: dict[str, list[str]] = {}

    for path in sorted(DOCX_DIR.glob("*.docx")):
        try:
            lines = docx_lines(path)
        except (zipfile.BadZipFile, KeyError) as err:
            print(f"  ! {path.name}: 읽지 못함 ({err})", file=sys.stderr)
            continue
        division = part = ""
        heading = ""
        body: list[str] = []

        def flush() -> None:
            nonlocal heading, body
            if not division or not (heading or body):
                heading, body = "", []
                return
            parts = sections.setdefault(division, {})
            parts.setdefault(part, []).append((heading or "(서두)", body))
            heading, body = "", []

        for line in lines:
            t = line.strip()
            m = SECT.match(t)
            if m:
                flush()
                name = m.group(1)
                division, _, part = (s.strip() for s in name.partition("-"))
                sources.setdefault(division, []).append(path.name)
                continue
            if not division or not t:
                continue
            if is_heading(t) and not line.startswith((" ", "\t")):
                flush()
                heading = t
                continue
            body.append(line)
        flush()

    for division, parts in sections.items():
        path = BASE_DIR / f"{slug(division)}.md"
        if not path.exists() or force:
            md: list[str] = [
                "---",
                f"division: {division}",
                f"sources: {', '.join(dict.fromkeys(sources.get(division, [])))}",
                "---",
                "",
            ]
        else:
            md = path.read_text(encoding="utf-8").rstrip("\n").split("\n") + [""]

        seen = "\n".join(md)
        added = 0
        for part, entries in parts.items():
            block: list[str] = []
            for heading, body in entries:
                if heading != "(서두)":
                    if f"### {heading}" in seen:
                        # 이미 있는 소제목은 docx 원본으로 덮지 않는다 (사용자가 덧붙인 줄 보존)
                        continue
                    block.append(f"### {heading}")
                    block.append("")
                block.extend(render_note(body))
                block.append("")
                seen += f"### {heading}\n"
                added += 1
            if block:
                if part:
                    md.append(f"## {part}")
                    md.append("")
                md.extend(block)

        path.write_text("\n".join(md).rstrip("\n") + "\n", encoding="utf-8")
        print(f"  {'새로 씀' if added else '변경 없음'} base/{path.name}" + (f" (+{added})" if added else ""))

    categories: dict[str, dict[str, list[str]]] = {}
    for division, parts in sections.items():
        bucket = categories.setdefault(division, {})
        for part, entries in parts.items():
            bucket.setdefault(part, []).extend(h for h, _ in entries if h != "(서두)")
    CATEGORIES.write_text(
        json.dumps(categories, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    total = sum(len(v) for d in categories.values() for v in d.values())
    print(f"{len(categories)}개 대단원 · 소단원 {total}개 → base/")
    return None


if __name__ == "__main__":
    build(force="--force" in sys.argv)
