"""fm 보드시험 단원별정리/*.docx 에서 대단원-중단원-소단원 체계를 뽑아 taxonomy.json / TAXONOMY.md 를 만든다.

원본 문서 규칙 (스타일 대신 서식으로 판별):
  [분과] / [분과 - 파트]        → 대단원 / 중단원
  굵게 + 글자크기 24 이상(또는 상속 크기 0) → 소단원
  그 외                          → 본문

사용: python scripts/taxonomy.py
"""

import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fm 보드시험 단원별정리"

CONTENT_PREFIX = re.compile(r"^(●|○|-|\*|→|⇒|※|▶|[0-9]+[).]|[①-⑩]|[가-힣]\)|\([0-9]+\)|[a-zA-Z])")
HEADER = re.compile(r"^\[(.+)\]$")
MAX_TOPIC_LEN = 45


def paragraph_info(p):
    text = "".join(t.text or "" for t in p.iter(f"{{{NS['w']}}}t")).strip()
    sizes = []
    bold = False
    for r in p.iter(f"{{{NS['w']}}}r"):
        props = r.find("w:rPr", NS)
        if props is None:
            continue
        size = props.find("w:sz", NS)
        if size is not None:
            sizes.append(int(size.get(f"{{{NS['w']}}}val") or 0))
        if props.find("w:b", NS) is not None:
            bold = True
    return text, (max(sizes) if sizes else 0), bold


def paragraphs(path):
    with zipfile.ZipFile(path) as archive:
        tree = ET.fromstring(archive.read("word/document.xml"))
    for p in tree.iter(f"{{{NS['w']}}}p"):
        text, size, bold = paragraph_info(p)
        if text:
            yield text, size, bold


def is_topic(text, size, bold):
    if not bold or size < 24 and size != 0:
        return False
    if CONTENT_PREFIX.match(text) or len(text) > MAX_TOPIC_LEN:
        return False
    if text.startswith("[") or text.startswith("("):
        return False
    return True


def main():
    taxonomy = {}
    for docx in sorted(SRC.glob("*.docx")):
        division = None
        part = ""
        for text, size, bold in paragraphs(docx):
            header = HEADER.match(text)
            if header:
                division, _, mid = header.group(1).partition(" - ")
                division = division.strip()
                part = mid.strip()
                taxonomy.setdefault(division, {}).setdefault(part, [])
                continue

            if division is None or not is_topic(text, size, bold):
                continue

            topics = taxonomy[division].setdefault(part, [])
            if text not in topics:
                topics.append(text)

    ordered = {
        division: {part: topics for part, topics in parts.items() if topics}
        for division, parts in taxonomy.items()
    }

    (ROOT / "taxonomy.json").write_text(
        json.dumps(ordered, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    lines = [
        "# 단원 분류체계",
        "",
        "`fm 보드시험 단원별정리` 문서에서 추출한 대단원-중단원-소단원 목록.",
        "분류할 때 이 이름을 **그대로** 쓴다. 목록에 없으면 가장 가까운 소단원을 고르고, 정말 없을 때만 새로 만든다.",
        "",
    ]
    for division, parts in ordered.items():
        lines.append(f"## {division}")
        for part, topics in parts.items():
            if part:
                lines.append(f"### {part}")
            for topic in topics:
                lines.append(f"- {topic}")
        lines.append("")

    (ROOT / "TAXONOMY.md").write_text("\n".join(lines), encoding="utf-8")

    total = sum(len(topics) for parts in ordered.values() for topics in parts.values())
    print(f"{len(ordered)} divisions, {total} topics")


if __name__ == "__main__":
    main()
