import collections
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "fm 보드시험 단원별정리"

CONTENT_PREFIX = re.compile(r"^(●|○|-|\*|→|⇒|※|▶|[0-9]+[).]|[①-⑩]|[가-힣]\)|\([0-9]+\)|[a-zA-Z])")


def run_size(p):
    sizes = []
    for r in p.iter(f"{{{NS['w']}}}r"):
        s = r.find("w:rPr/w:sz", NS)
        if s is not None:
            sizes.append(int(s.get(f"{{{NS['w']}}}val")))
    return max(sizes) if sizes else 0


def is_bold(p):
    return any(r.find("w:rPr/w:b", NS) is not None for r in p.iter(f"{{{NS['w']}}}r"))


stats = collections.Counter()
samples = collections.defaultdict(list)

for docx in sorted(SRC.glob("*.docx")):
    with zipfile.ZipFile(docx) as archive:
        tree = ET.fromstring(archive.read("word/document.xml"))
    for p in tree.iter(f"{{{NS['w']}}}p"):
        text = "".join(t.text or "" for t in p.iter(f"{{{NS['w']}}}t")).strip()
        if not text or text.startswith("["):
            continue
        size = run_size(p)
        key = (size, is_bold(p))
        stats[key] += 1
        if len(samples[key]) < 4:
            samples[key].append(text[:60])

out = []
for (size, bold), count in sorted(stats.items(), key=lambda kv: -kv[1]):
    out.append(f"size={size:3d} bold={int(bold)} count={count}")
    out.extend(f"    {s}" for s in samples[(size, bold)])

(ROOT / "docx-sizes.txt").write_text("\n".join(out), encoding="utf-8")
print("done")
