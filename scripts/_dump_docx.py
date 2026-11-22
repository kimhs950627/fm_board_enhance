import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fm 보드시험 단원별정리"

docx = sorted(SRC.glob("*.docx"))[2]
limit = int(sys.argv[1]) if len(sys.argv) > 1 else 120

with zipfile.ZipFile(docx) as archive:
    tree = ET.fromstring(archive.read("word/document.xml"))

lines = [f"# {docx.name}", ""]
for p in tree.iter(f"{{{NS['w']}}}p"):
    style = p.find("w:pPr/w:pStyle", NS)
    name = style.get(f"{{{NS['w']}}}val") if style is not None else "-"
    text = "".join(t.text or "" for t in p.iter(f"{{{NS['w']}}}t")).strip()
    if text:
        lines.append(f"[{name}] {text}")

(ROOT / "docx-sample.txt").write_text("\n".join(lines[:limit]), encoding="utf-8")
print(f"{len(lines)} lines, wrote {min(limit, len(lines))}")
