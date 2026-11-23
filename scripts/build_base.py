#!/usr/bin/env python3
"""build_base.py — 단원별정리 docx 를 base md 로 바꾼다.

base 는 사용자가 기록(note)과 별개로 유지하는 '기본 교재'다. 덧붙이기 전용이라
이미 base 에 있는 소제목은 다시 쓰지 않는다(사용자·LLM 이 덧붙인 줄 보존).
처리한 소제목은 base/_seen.json 에 남겨 다음 실행에서 중복을 막는다.

내용이 너무 적은 소제목은 따로 세우지 않고 묶는다.
  - 첫 소제목 앞의 내용        → "### 총론"
  - 내용이 MIN_CHARS 자 미만    → "### 기타"

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
SEEN = BASE_DIR / "_seen.json"

MIN_CHARS = 80

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
    if not t or t[0] in "●-*→>:" or t[0].isdigit():
        return False
    if len(t) > 60 or t.endswith((".", ":", "?")):
        return False
    return True


MARKERS = {"☞": "→", "➡": "→", "⇒": "→", "★": "·", "☆": "·", "✔": "·", "✓": "·"}


def render_note(lines: list[str]) -> list[str]:
    out: list[str] = []
    for raw in lines:
        line = "".join(MARKERS.get(ch, ch) for ch in raw.rstrip())
        if not line.strip():
            continue
        indented = line[:1] in (" ", "\t")
        # 원본 docx 가 '###' 을 소제목 구분자로 써 두었다 → 줄로 나눈다
        pieces = [piece.strip() for piece in re.split(r"\s*###\s*", line) if piece.strip()]
        if len(pieces) > 1:
            out.append("- " + pieces[0].lstrip("● ").strip())
            out.extend("  - " + re.sub(r"^[>›»]\s*", "", piece) for piece in pieces[1:])
            continue
        stripped = pieces[0] if pieces else line.strip()
        nested = "  " if indented else ""
        if stripped.startswith(("●", ">", "›", "»")):
            out.append(nested + "- " + re.sub(r"^[●>›»]\s*", "", stripped))
        elif re.match(r"^[-*]\s*", stripped):
            out.append(nested + "- " + re.sub(r"^[-*]\s*", "", stripped))
        elif stripped.startswith("→"):
            out.append(nested + stripped)
        elif not indented and is_heading(stripped):
            out.append("### " + stripped)
        else:
            out.append(stripped)
    return out


def slug(name: str) -> str:
    return re.sub(r"[\\/:*?\"<>|]", "_", name).strip()


def load_docx() -> tuple[dict[str, dict[str, list[tuple[str, list[str]]]]], dict[str, list[str]]]:
    sections: dict[str, dict[str, list[tuple[str, list[str]]]]] = {}
    sources: dict[str, list[str]] = {}
    seen_headings: dict[str, set[str]] = {}

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
            if division and (heading or body):
                key = heading or "(서두)"
                # 권이 겹치는 docx(6권 피부과 등)에서 같은 소제목이 두 번 들어오지 않게 한다
                bucket = seen_headings.setdefault(division, set())
                if key not in bucket:
                    bucket.add(key)
                    sections.setdefault(division, {}).setdefault(part, []).append((key, body))
            heading, body = "", []

        for line in lines:
            t = line.strip()
            m = SECT.match(t)
            if m:
                flush()
                division, _, part = (s.strip() for s in m.group(1).partition("-"))
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

    return sections, sources


def classify(entries: list[tuple[str, list[str]]]) -> tuple[str | None, list[str], list[tuple[str, list[str]]], list[tuple[str, list[str]]]]:
    """(서두, 총론 줄, 본문 있는 소제목, 기타로 묶을 소제목) 로 나눈다."""
    intro: list[str] = []
    real: list[tuple[str, list[str]]] = []
    misc: list[tuple[str, list[str]]] = []

    for heading, body in entries:
        rendered = render_note(body)
        if heading == "(서두)":
            intro.extend(rendered)
        elif len("\n".join(rendered)) >= MIN_CHARS:
            real.append((heading, rendered))
        else:
            misc.append((heading, rendered))

    return None, intro, real, misc


def misc_lines(misc: list[tuple[str, list[str]]]) -> list[str]:
    out: list[str] = []
    for heading, rendered in misc:
        out.append(f"- {heading}")
        for line in rendered:
            text = line.strip()
            text = re.sub(r"^[-*]\s*", "", text)
            if text:
                out.append(f"  - {text}")
    return out


def append_section(lines: list[str], title: str, block: list[str]) -> None:
    """같은 제목의 섹션이 있으면 그 끝에, 없으면 파일 끝에 붙인다."""
    if not block:
        return
    index = None
    for i, line in enumerate(lines):
        if line.strip() == f"### {title}":
            index = i
    if index is None:
        lines.extend(["", f"### {title}", ""])
        lines.extend(block)
        return

    end = index + 1
    while end < len(lines) and not lines[end].startswith("### "):
        end += 1
    while end > index + 1 and not lines[end - 1].strip():
        end -= 1
    lines[end:end] = block


def build(force: bool) -> None:
    BASE_DIR.mkdir(exist_ok=True)
    if not DOCX_DIR.exists():
        raise SystemExit(f"docx 폴더가 없다: {DOCX_DIR}")

    sections, sources = load_docx()
    seen_all: dict[str, list[str]] = {}
    seen = {} if force else (json.loads(SEEN.read_text(encoding="utf-8")) if SEEN.exists() else {})

    for division, parts in sections.items():
        path = BASE_DIR / f"{slug(division)}.md"
        done = set(seen.get(division, []))

        if not path.exists() or force:
            lines = [
                "---",
                f"division: {division}",
                f"sources: {', '.join(dict.fromkeys(sources.get(division, [])))}",
                "---",
                "",
            ]
            done = set()
        else:
            lines = path.read_text(encoding="utf-8").rstrip("\n").split("\n")

        added_own = added_misc = 0
        for part, entries in parts.items():
            fresh = [(h, b) for h, b in entries if h not in done]
            if not fresh:
                continue
            _, intro, real, misc = classify(fresh)

            if part and not any(line.strip() == f"## {part}" for line in lines):
                lines.extend(["", f"## {part}", ""])

            if intro:
                append_section(lines, "총론", intro)
                added_misc += 1

            for heading, rendered in real:
                lines.extend(["", f"### {heading}", ""])
                lines.extend(rendered)
                added_own += 1

            batch = misc_lines(misc)
            if batch:
                append_section(lines, "기타", batch)
                added_misc += 1

            for heading, _ in fresh:
                if heading != "(서두)":
                    seen.setdefault(division, []).append(heading)
                done.add(heading)

        text = "\n".join(lines).rstrip("\n") + "\n"
        text = re.sub(r"\n{3,}", "\n\n", text)
        path.write_text(text, encoding="utf-8")
        if added_own or added_misc:
            print(f"  갱신 base/{path.name} (소단원 +{added_own}, 묶음 {added_misc})")
        else:
            print(f"  변경 없음 base/{path.name}")
        seen_all[division] = sorted(set(seen.get(division, [])))

    categories: dict[str, dict[str, list[str]]] = {}
    for division, parts in sections.items():
        bucket = categories.setdefault(division, {})
        for part, entries in parts.items():
            bucket.setdefault(part, []).extend(h for h, _ in entries if h != "(서두)")

    CATEGORIES.write_text(json.dumps(categories, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    SEEN.write_text(json.dumps(seen_all, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    total = sum(len(v) for d in categories.values() for v in d.values())
    print(f"{len(categories)}개 대단원 · 소단원 {total}개 → base/")


if __name__ == "__main__":
    build(force="--force" in sys.argv)
