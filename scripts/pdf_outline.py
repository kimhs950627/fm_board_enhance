#!/usr/bin/env python3
"""pdf_outline.py — 인쇄된 PDF 에 대단원/소단원 북마크(목차)를 심는다.

Chrome 의 --print-to-pdf 는 목차(아웃라인)를 만들지 않는다. 빌드가 HTML 순서대로
남긴 제목 목록을 받아, 각 제목이 처음 나오는 페이지를 찾아 북마크를 단다.

  python3 scripts/pdf_outline.py dist/pdf/fm_board_all.pdf dist/pdf/_outline.json

제목을 못 찾은 항목은 조용히 건너뛴다(쪽 번호를 지어내지 않는다).
"""

from __future__ import annotations

import json
import os
import sys

import pymupdf


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: pdf_outline.py <pdf> <outline.json>", file=sys.stderr)
        return 2

    pdf_path, spec_path = sys.argv[1], sys.argv[2]
    items = json.load(open(spec_path, encoding="utf-8")).get("items", [])
    doc = pymupdf.open(pdf_path)

    toc: list[list] = []
    cursor = 0
    last_level = 1

    for item in items:
        title = " ".join(str(item.get("title", "")).split())
        if not title:
            continue
        needle = title[:30]
        page = None
        for pno in range(cursor, doc.page_count):
            # 줄 전체가 제목과 같아야 한다 — 표지의 '가정의학과 전문의' 같은 부분 일치를 막는다
            lines = [line.strip() for line in doc[pno].get_text().split("\n")]
            if title in lines:
                page = pno
                break
        if page is None:
            continue

        level = int(item.get("level") or 1)
        level = max(1, min(level, last_level + 1))
        last_level = level
        toc.append([level, title, page + 1])
        cursor = page

    if not toc:
        print("! 북마크할 제목을 찾지 못했다 — 원본 그대로 둔다", file=sys.stderr)
        return 0

    doc.set_toc(toc)
    tmp = f"{pdf_path}.tmp"
    doc.save(tmp, garbage=3, deflate=True)
    doc.close()
    os.replace(tmp, pdf_path)
    print(f"북마크 {len(toc)}개 → {os.path.basename(pdf_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
