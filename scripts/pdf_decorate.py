#!/usr/bin/env python3
"""pdf_decorate.py — 인쇄물에 쪽번호와 러닝헤드를 찍는다.

Chrome 의 --print-to-pdf 는 @page margin box(쪽번호·머리글)를 지원하지 않는다.
그래서 북마크(목차)가 심긴 PDF 를 열어, 장 경계를 기준으로
  · 위쪽: 왼쪽에 지금 장 이름, 오른쪽에 책 제목
  · 아래쪽: 가운데 쪽번호
를 직접 그려 넣는다. 표지와 앞부속(이 책 쓰는 법·목차)에는 쪽번호만 찍는다.

  python3 scripts/pdf_decorate.py <pdf> <outline.json> "<책 제목>"

한글 글꼴을 못 찾으면 머리글 없이 쪽번호만 찍고 그 사실을 알린다.
"""

from __future__ import annotations

import os
import sys

import pymupdf

KOREAN_FONTS = [
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
]

MUTED = (0.42, 0.44, 0.47)


def find_font() -> str | None:
    for path in KOREAN_FONTS:
        if os.path.exists(path):
            return path
    return None


def main() -> int:
    pdf_path, _spec_path, book_title = sys.argv[1], sys.argv[2], sys.argv[3]
    doc = pymupdf.open(pdf_path)
    toc = doc.get_toc() or []
    chapters = [(title, page) for level, title, page in toc if level == 1]
    first_chapter = chapters[0][1] if chapters else 1

    font_path = find_font()
    font = None
    if font_path:
        try:
            font = pymupdf.Font(fontfile=font_path)
        except Exception:  # noqa: BLE001
            font = None

    def right_x(text: str, size: float, width: float) -> float:
        if not font:
            return 0.0
        return width - 42 - font.text_length(text, fontsize=size)

    for index, page in enumerate(doc):
        number = index + 1
        if number == 1:  # 표지
            continue
        width, height = page.rect.width, page.rect.height

        label = str(number)
        page.insert_text((width / 2 - 3.2 * len(label), height - 26), label, fontname="helv", fontsize=8, color=MUTED)

        if not font or number < first_chapter:
            continue

        current = ""
        for title, start in chapters:
            if start <= number:
                current = title

        try:
            page.insert_font(fontname="book", fontfile=font_path)
        except Exception:  # noqa: BLE001
            continue

        page.insert_text((42, 34), current, fontname="book", fontsize=7.5, color=MUTED)
        page.insert_text((right_x(book_title, 7.5, width), 34), book_title, fontname="book", fontsize=7.5, color=MUTED)

    tmp = f"{pdf_path}.tmp"
    doc.save(tmp, garbage=3, deflate=True)
    doc.close()
    os.replace(tmp, pdf_path)
    print(f"쪽번호·러닝헤드 {'적용' if font else '쪽번호만(한글 글꼴 없음)'} → {os.path.basename(pdf_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
