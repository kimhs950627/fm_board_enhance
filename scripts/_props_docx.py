import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fm 보드시험 단원별정리"

docx = sorted(SRC.glob("*.docx"))[1]
start = int(sys.argv[1]) if len(sys.argv) > 1 else 60
count = int(sys.argv[2]) if len(sys.argv) > 2 else 80


def attr(node, path, name):
    found = node.find(path, NS)
    return found.get(f"{{{NS['w']}}}{name}") if found is not None else ""


with zipfile.ZipFile(docx) as archive:
    tree = ET.fromstring(archive.read("word/document.xml"))

out = [f"# {docx.name}", ""]
index = 0
for p in tree.iter(f"{{{NS['w']}}}p"):
    text = "".join(t.text or "" for t in p.iter(f"{{{NS['w']}}}t")).strip()
    if not text:
        continue
    index += 1
    if index < start:
        continue
    if index > start + count:
        break

    ppr = p.find("w:pPr", NS)
    left = attr(ppr, "w:ind", "left") if ppr is not None else ""
    first = attr(ppr, "w:ind", "firstLine") if ppr is not None else ""
    level = attr(ppr, "w:numPr/w:ilvl", "val") if ppr is not None else ""
    bold = any(r.find("w:rPr/w:b", NS) is not None for r in p.iter(f"{{{NS['w']}}}r"))
    size = ""
    for r in p.iter(f"{{{NS['w']}}}r"):
        s = r.find("w:rPr/w:sz", NS)
        if s is not None:
            size = s.get(f"{{{NS['w']}}}val")
            break

    out.append(f"{index:4d} ind={left or '-':>5} first={first or '-':>5} lvl={level or '-':>2} b={int(bold)} sz={size or '-':>3} | {text}")

(ROOT / "docx-props.txt").write_text("\n".join(out), encoding="utf-8")
print("done")
