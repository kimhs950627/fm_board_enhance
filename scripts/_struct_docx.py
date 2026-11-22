import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fm 보드시험 단원별정리"

CONTENT_PREFIX = re.compile(r"^(●|○|-|\*|→|※|▶|[0-9]+[).]|[①-⑩]|[가-힣]\)|\([0-9]+\))")


def lines_of(path):
    with zipfile.ZipFile(path) as archive:
        tree = ET.fromstring(archive.read("word/document.xml"))
    for p in tree.iter(f"{{{NS['w']}}}p"):
        text = "".join(t.text or "" for t in p.iter(f"{{{NS['w']}}}t")).strip()
        if text:
            yield text


report = []
bracket_counts = {}
for docx in sorted(SRC.glob("*.docx")):
    headers = []
    shorts = 0
    for text in lines_of(docx):
        if text.startswith("[") and text.endswith("]"):
            headers.append(text)
            bracket_counts[text] = bracket_counts.get(text, 0) + 1
        elif len(text) <= 30 and not CONTENT_PREFIX.match(text):
            shorts += 1
    report.append(f"{docx.name}\theaders={len(headers)}\tshort_lines={shorts}")
    report.extend(f"    {h}" for h in headers[:40])

report.append("")
report.append("# bracket header frequency")
for key, count in sorted(bracket_counts.items(), key=lambda kv: -kv[1])[:60]:
    report.append(f"{count}\t{key}")

(ROOT / "docx-structure.txt").write_text("\n".join(report), encoding="utf-8")
print("done", len(report))
