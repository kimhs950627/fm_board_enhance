#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const NOTES = path.join(ROOT, "notes");
const BASE = path.join(ROOT, "base");
const TEMPLATES = path.join(ROOT, "templates");
const DIST = path.join(ROOT, "dist");
const HTML_DIR = path.join(DIST, "html");
const BASE_HTML_DIR = path.join(DIST, "base");
const PDF_DIR = path.join(DIST, "pdf");
const TAXONOMY_FILE = path.join(ROOT, "taxonomy.json");
const UNCATEGORIZED = "미분류";

const flags = new Set(process.argv.slice(2));
const WATCH = flags.has("--watch");
const NO_PDF = flags.has("--no-pdf");

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) data[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { data, body: text.slice(match[0].length) };
}

function splitList(value) {
  return [...new Set(String(value || "").split(",").map((v) => v.trim()).filter(Boolean))];
}

function loadTaxonomy() {
  if (!fs.existsSync(TAXONOMY_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TAXONOMY_FILE, "utf8"));
  } catch {
    return null;
  }
}

function loadNotes() {
  if (!fs.existsSync(NOTES)) return [];
  const notes = [];
  for (const name of fs.readdirSync(NOTES)) {
    const dir = path.join(NOTES, name);
    const entryPath = path.join(dir, "entry.md");
    if (!fs.existsSync(entryPath)) continue;

    const entry = parseFrontMatter(fs.readFileSync(entryPath, "utf8"));
    const polishedPath = path.join(dir, "polished.md");
    const hasPolished = fs.existsSync(polishedPath);
    const polished = hasPolished ? parseFrontMatter(fs.readFileSync(polishedPath, "utf8")) : null;

    const data = { ...entry.data };
    for (const [key, value] of Object.entries(polished?.data ?? {})) {
      if (value) data[key] = value;
    }

    const divisions = splitList(data.divisions || data.division || data.categories || data.category);
    const topics = splitList(data.topics || data.topic);

    notes.push({
      id: data.id || name,
      dir,
      file: hasPolished ? "polished.md" : "entry.md",
      title: data.title || "(제목 없음)",
      division: divisions[0] || "",
      extraDivisions: divisions.slice(1),
      part: String(data.part || "").trim(),
      topics,
      created: data.created || "",
      polished: hasPolished,
      merged: String(data.merged || "").toLowerCase() === "true",
      body: hasPolished ? polished.body : entry.body,
    });
  }
  return notes.sort((a, b) => a.created.localeCompare(b.created));
}

// base: docx 를 옮긴 '기본 교재'. 기록(note)과 별개로 매일 갱신된다.
function loadBase() {
  if (!fs.existsSync(BASE)) return [];
  const taxonomy = loadTaxonomy();
  const order = taxonomy ? Object.keys(taxonomy) : [];
  const rank = (name) => (order.indexOf(name) === -1 ? Number.MAX_SAFE_INTEGER : order.indexOf(name));
  return fs
    .readdirSync(BASE)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const { data, body } = parseFrontMatter(fs.readFileSync(path.join(BASE, name), "utf8"));
      return {
        division: data.division || name.replace(/\.md$/, ""),
        sources: data.sources || "",
        file: name,
        slug: name.replace(/\.md$/, ""),
        headings: [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim()),
        body,
      };
    })
    .sort((a, b) => {
      const diff = rank(a.division) - rank(b.division);
      return diff !== 0 ? diff : a.division.localeCompare(b.division, "ko");
    });
}

function markdownToHtml(note) {
  const result = spawnSync(
    "pandoc",
    [
      note.file,
      "--from",
      "markdown",
      "--to",
      "html5",
      "--embed-resources",
      "--resource-path",
      ".",
      "--wrap=none",
      "--mathml",
    ],
    { cwd: note.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.error) throw new Error(`pandoc 실행 실패: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`pandoc 변환 실패 (${note.id}):\n${result.stderr}`);
  }
  // 이미지 대체텍스트: 비어 있으면 파일명으로 채운다(접근성 검사 통과 + PDF 태그)
  return result.stdout
    .replace(/<colgroup>[\s\S]*?<\/colgroup>\s*/g, "")
    .replace(/￥/g, '<span class="yama" aria-label="야마: 자주 출제">야마</span>')
    .replace(/<img([^>]*)>/g, (tag, attrs) => {
      if (/alt="[^"]+"/.test(attrs)) return tag;
      const src = /src="([^"]*)"/.exec(attrs)?.[1] || "이미지";
      const name = decodeURIComponent(src.split("/").pop() || src);
      return `<img${attrs.replace(/alt="[^"]*"/, "").trimEnd()} alt="${name}">`;
    });
}

// 한 페이지짜리 문서에서는 h3 를 h2 로 올려 제목 계층을 지킨다
function shiftHeadings(html) {
  return html.replace(/<(\/?)h([234])(\s|>)/g, (whole, close, level, rest) => `<${close}h${Number(level) - 1}${rest}`);
}

function buildPage({ title, body, css, nav = "" }) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
<main class="sheet">
${nav}${body}
</main>
</body>
</html>
`;
}

function printPdf(chrome, htmlPath, pdfPath) {
  const url = pathToFileURL(htmlPath).href;
  const flags = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--no-pdf-header-footer",
    "--virtual-time-budget=15000",
    `--print-to-pdf=${pdfPath}`,
    url,
  ];
  if (process.env.CI) flags.splice(1, 0, "--no-sandbox");

  const result = spawnSync(chrome, flags, { encoding: "utf8", timeout: 180000 });

  if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`PDF 생성 실패: ${path.basename(pdfPath)} ${detail}`);
  }
}

// 대단원(h1)·소단원(h2)·소제목(h3)을 PDF 북마크로 심는다.
function plainText(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function collectOutline(html) {
  const items = [];
  const re = /<h([123])([^>]*)>([\s\S]*?)<\/h\1>/g;
  let inBase = false;
  for (const match of html.matchAll(re)) {
    const level = Number(match[1]);
    const attrs = match[2];
    if (/class="cover-title"/.test(attrs)) continue;
    if (/class="front-title"/.test(attrs)) continue; // 앞부속 제목은 목차·북마크에서 뺀다
    const title = plainText(match[3]);
    if (!title) continue;
    // '기본 정리' 자체는 목차에 넣지 않고, 그 아래 h3 를 소단원(2단계)로 올린다
    if (title === "기본 정리") {
      inBase = true;
      continue;
    }
    if (level <= 2) inBase = false;
    items.push({ level: inBase ? 2 : level, title });
  }
  return items;
}

function addOutline(pdfPath, outlinePath, { returnToc = false } = {}) {
  const args = [path.join(ROOT, "scripts", "pdf_outline.py"), pdfPath, outlinePath];
  if (returnToc) args.push("--print-toc");
  const result = spawnSync("python3", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`PDF 북마크 생성 실패: ${detail}`);
  }
  if (returnToc) return result.stdout.trim();
  if (result.stdout.trim()) console.log(result.stdout.trim());
  return "";
}

// 쪽번호·러닝헤드: Chrome 인쇄로는 넣을 수 없어 PDF 에 직접 그린다.
function decoratePdf(pdfPath, outlinePath, title) {
  const result = spawnSync(
    "python3",
    [path.join(ROOT, "scripts", "pdf_decorate.py"), pdfPath, outlinePath, title],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`PDF 쪽번호 처리 실패: ${detail}`);
  }
  if (result.stdout.trim()) console.log(result.stdout.trim());
}

// 한글 글꼴이 PDF에 실제로 박혔는지 확인한다. CI에 한글 폰트가 없으면 Chrome이
// 라틴 폰트로만 찍어 한글이 전부 빈 네모가 되는데, 빌드는 성공한 것처럼 보인다.
function assertKoreanFont(pdfPath) {
  const raw = fs.readFileSync(pdfPath, "latin1");
  const names = [...raw.matchAll(/\/BaseFont\s*\/([#\w+.,\-]+)/g)].map((m) => m[1]);
  const hasKorean = names.some((name) => /noto|cjk|nanum|gothic|batang|malgun|pretendard/i.test(name));
  if (!hasKorean) {
    throw new Error(
      `PDF에 한글 글꼴이 없습니다 (삽입된 글꼴: ${names.join(", ") || "없음"}). ` +
        `빌드 환경에 한글 글꼴(예: fonts-noto-cjk)을 설치하세요.`,
    );
  }
}

function topicRank(taxonomy, division, part, topic) {  const list = taxonomy?.[division]?.[part] ?? [];
  const index = list.indexOf(topic);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function buildTree(notes, taxonomy) {
  const divisions = new Map();
  const loose = [];

  for (const note of notes) {
    if (!note.division) {
      loose.push(note);
      continue;
    }
    const part = note.part;
    const topics = note.topics.length ? note.topics : [""];

    if (!divisions.has(note.division)) divisions.set(note.division, new Map());
    const parts = divisions.get(note.division);
    if (!parts.has(part)) parts.set(part, new Map());
    const topicMap = parts.get(part);

    for (const topic of topics) {
      if (!topicMap.has(topic)) topicMap.set(topic, []);
      if (!topicMap.get(topic).includes(note)) topicMap.get(topic).push(note);
    }
  }

  const order = taxonomy ? Object.keys(taxonomy) : [];
  const rank = (name) => {
    const index = order.indexOf(name);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  const names = [...divisions.keys()].sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.localeCompare(b, "ko");
  });

  const chapters = names.map((division) => {
    const parts = divisions.get(division);
    const partNames = [...parts.keys()].sort((a, b) => {
      if (!a !== !b) return a ? -1 : 1;
      return a.localeCompare(b, "ko");
    });

    return {
      division,
      parts: partNames.map((part) => {
        const topicMap = parts.get(part);
        const topicNames = [...topicMap.keys()].sort((a, b) => {
          if (!a !== !b) return a ? -1 : 1;
          const diff = topicRank(taxonomy, division, part, a) - topicRank(taxonomy, division, part, b);
          return diff !== 0 ? diff : a.localeCompare(b, "ko");
        });
        return {
          part,
          topics: topicNames.map((topic) => ({ topic, notes: topicMap.get(topic) })),
        };
      }),
    };
  });

  return { chapters, loose };
}

function chapterTitle(division) {
  return division;
}

function bookToc(html) {
  // 인쇄 목차는 대단원(h1)과 그 아래 실제 h2 만 싣는다(북마크는 더 세밀하다).
  const entries = [];
  for (const match of html.matchAll(/<h([12])([^>]*)>([\s\S]*?)<\/h\1>/g)) {
    if (/class="(cover-title|front-title)"/.test(match[2])) continue;
    const title = plainText(match[3]);
    if (!title || title === "기본 정리") continue;
    entries.push({ level: Number(match[1]), title });
  }
  return entries;
}

// 목차 항목 순서대로 북마크(제목→쪽)에서 쪽 번호를 뽑는다. 제목이 겹쳐도 순서로 짝지어 안전하다.
function tocPages(outline, titles) {
  const pages = [];
  let cursor = 0;
  for (const title of titles) {
    while (cursor < outline.length && outline[cursor][1] !== title) cursor += 1;
    if (cursor < outline.length) {
      pages.push(outline[cursor][2]);
      cursor += 1;
    } else {
      pages.push("");
    }
  }
  return pages;
}

function buildBook(tree, base, css, pages = null) {
  const total = tree.chapters.reduce(
    (sum, chapter) => sum + chapter.parts.reduce((s, p) => s + p.topics.reduce((n, t) => n + t.notes.length, 0), 0),
    0,
  );
  const looseCount = tree.loose.length;
  const now = new Date();

  const cover = `<section class="cover">
  <div class="cover-kicker">가정의학과 전문의</div>
  <h1 class="cover-title">기출 개념<br>단권화</h1>
  <div class="cover-rule"></div>
  <p class="cover-lede">기본 정리 ${base.length}단원에 기록 ${total + looseCount}개를 얹은 시험장용 단권화.</p>
  <div class="cover-meta">${now.getFullYear()}년 ${now.getMonth() + 1}월 · fm_board_enhance</div>
</section>`;

  const preface = `<section class="frontmatter">
  <h2 class="front-title">이 책 쓰는 법</h2>
  <p>단원마다 두 층이 있다. <strong>기본 정리</strong>는 2020~2025 단원별정리에서 옮긴 뼈대이고,
  그 아래 <strong>기록</strong>은 시험을 보며 새로 적은 내용이다. 기록은 매일 아침 기본 정리에 흡수된다.</p>
  <p><span class="yama" aria-label="야마: 자주 출제">야마</span> 표시는 족보에 반복해서 나오는 항목이다. 먼저 훑고,
  남는 시간에 나머지를 훑는다.</p>
  <p>대단원과 소단원은 PDF 북마크에 그대로 들어 있다. 쪽 번호는 아래 목차와 각 쪽 아래에 있다.</p>
</section>`;

  const noteArticle = (note) => `<article class="note">
  <h3 class="note-title">${escapeHtml(note.title)}</h3>
${note.html}
</article>`;

  const notesFor = (chapter) =>
    chapter.parts
      .map((part) => {
        const partHeading = part.part ? `<h2 class="part-title">${escapeHtml(part.part)}</h2>` : "";
        const topics = part.topics
          .map((group) => {
            const heading = group.topic ? `<h2 class="topic-title">${escapeHtml(group.topic)}</h2>` : "";
            const live = group.notes.filter((note) => !note.merged);
            if (!live.length) return heading;
            return `${heading}
${live.map(noteArticle).join("\n")}`;
          })
          .join("\n");
        return `${partHeading}
${topics}`;
      })
      .join("\n");

  const baseBlock = (entry) => `<section class="base-block">
  <h2 class="part-title">기본 정리</h2>
${entry.html}
</section>`;

  const noteChapter = (division) => tree.chapters.find((c) => c.division === division);
  const baseChapter = (division) => base.find((b) => b.division === division);
  const divisions = [
    ...new Set([...base.map((b) => b.division), ...tree.chapters.map((c) => c.division)]),
  ];

  const chapters = divisions
    .map((division, index) => {
      const notes = noteChapter(division);
      const baseHtml = baseChapter(division);
      const counts = [
        baseHtml ? `기본 정리 ${baseHtml.headings.length}항목` : "",
        notes
          ? `기록 ${notes.parts.reduce((s, p) => s + p.topics.reduce((n, t) => n + t.notes.filter((note) => !note.merged).length, 0), 0)}개`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<section class="chapter">
  <header class="chapter-head">
    <span class="pdfmark" aria-hidden="true">⟦${String(index + 1).padStart(2, "0")}⟧</span>
    <span class="chapter-num">${String(index + 1).padStart(2, "0")}</span>
    <h1 class="chapter-title">${escapeHtml(chapterTitle(division))}</h1>
    <p class="chapter-meta">${counts}</p>
  </header>
${baseHtml ? baseBlock(baseHtml) : ""}
${notes ? notesFor(notes) : ""}
</section>`;
    })
    .join("\n");

  const loose = tree.loose.length
    ? `<section class="chapter">
  <header class="chapter-head">
    <span class="pdfmark" aria-hidden="true">⟦${String(divisions.length + 1).padStart(2, "0")}⟧</span>
    <span class="chapter-num">${String(divisions.length + 1).padStart(2, "0")}</span>
    <h1 class="chapter-title">${UNCATEGORIZED}</h1>
  </header>
${tree.loose.map(noteArticle).join("\n")}
</section>`
    : "";

  const chaptersHtml = `${chapters}\n${loose}`;
  const tocEntries = bookToc(chaptersHtml);
  const tocRows = tocEntries
    .map((entry, index) => {
      const page = pages && pages[index] ? String(pages[index]) : "";
      return `<li class="toc-item is-level-${entry.level}">
      <span class="toc-title">${escapeHtml(entry.title)}</span>
      <span class="toc-dots" aria-hidden="true"></span>
      <span class="toc-page">${page}</span>
    </li>`;
    })
    .join("\n");

  const toc = `<section class="frontmatter toc">
  <h2 class="front-title">목차</h2>
  <ol class="toc-list">
${tocRows}
  </ol>
</section>`;

  return buildPage({
    title: "가정의학과 기출 개념 단권화",
    css,
    body: `${cover}\n${preface}\n${toc}\n${chaptersHtml}`,
  });
}

function buildIndex(tree, base, css) {
  const allNotes = [
    ...tree.chapters.flatMap((c) => c.parts.flatMap((p) => p.topics.flatMap((t) => t.notes))),
    ...tree.loose,
  ];
  const live = allNotes
    .filter((note) => !note.merged)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));

  const excerptOf = (note) =>
    escapeHtml(
      String(note.body || "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/[#>*_`\[\]{}]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 110),
    );

  const baseRows = base
    .map(
      (entry) => `<li>
      <a class="title" href="base/${encodeURIComponent(entry.slug)}.html">${escapeHtml(entry.division)}</a>
      <span class="links"><span>${entry.headings.length}개 항목</span><a href="base/${encodeURIComponent(entry.slug)}.html">HTML</a></span>
    </li>`,
    )
    .join("\n");

  const extraRows = live
    .map((note) => {
      const meta = [
        note.division || "미분류",
        ...(note.topics || []),
        String(note.created || "").replace("T", " ").slice(0, 16),
      ]
        .filter(Boolean)
        .join(" · ");
      return `<li class="note-row">
      <div class="note-head">
        <a class="title" href="html/${encodeURIComponent(note.id)}.html">${escapeHtml(note.title)}</a>
        <span class="links"><a href="html/${encodeURIComponent(note.id)}.html">HTML</a></span>
      </div>
      <div class="note-meta">${escapeHtml(meta)}</div>
      <p class="note-excerpt">${excerptOf(note)}</p>
    </li>`;
    })
    .join("\n");

  const built = new Date();
  const builtLabel = `${built.getFullYear()}년 ${built.getMonth() + 1}월 ${built.getDate()}일 ${String(built.getHours()).padStart(2, "0")}:${String(built.getMinutes()).padStart(2, "0")} 빌드`;

  const body = `<h1>가정의학과 기출 개념 단권화</h1>
<p class="lede">기본 교재 ${base.length}단원 · 아직 합치지 않은 기록 ${live.length}건. 빌드는 ${builtLabel}.</p>
<p class="lede no-print"><a href="new.html">새 기록 쓰기</a> · <a href="pdf/fm_board_all.pdf">전체 PDF 열기</a></p>

<div class="tabs" role="tablist" aria-label="보기 선택">
  <button class="tab" role="tab" id="tab-base" aria-controls="panel-base" aria-selected="true">기본 교재<span class="tab-count">${base.length}</span></button>
  <button class="tab" role="tab" id="tab-extra" aria-controls="panel-extra" aria-selected="false">추가 내용<span class="tab-count">${live.length}</span></button>
</div>

<section class="tab-panel" id="panel-base" role="tabpanel" aria-labelledby="tab-base" tabindex="0">
  <p class="panel-lede">단원별 기본 정리. 밤사이 새 기록이 여기에 합쳐진다.</p>
  <ul class="doc-list">
${baseRows}
  </ul>
</section>

<section class="tab-panel" id="panel-extra" role="tabpanel" aria-labelledby="tab-extra" tabindex="0" hidden>
${
  live.length
    ? `<p class="panel-lede">아직 기본 교재에 합쳐지지 않은 기록. 새벽 작업이 끝나면 이 탭은 비고, 내용은 기본 교재로 옮겨진다.</p>
  <ul class="doc-list notes">
${extraRows}
  </ul>`
    : `<p class="empty">지금은 새로 적은 내용이 없습니다. 적은 내용은 모두 기본 교재에 합쳐졌습니다.</p>`
}
</section>

<script>
(function () {
  const tabs = [...document.querySelectorAll(".tab")];
  const panels = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));
  function select(index, focus) {
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    });
    history.replaceState(null, "", index === 0 ? "#base" : "#extra");
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(i));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      select((i + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length, true);
    });
  });
  select(location.hash === "#extra" ? 1 : 0);
})();
</script>`;

  return buildPage({ title: "가정의학과 기출 개념 단권화", body, css });
}

function build() {
  const started = Date.now();
  const css = fs.readFileSync(path.join(TEMPLATES, "style.css"), "utf8");
  const taxonomy = loadTaxonomy();
  const notes = loadNotes();
  const base = loadBase();

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(HTML_DIR, { recursive: true });
  fs.mkdirSync(BASE_HTML_DIR, { recursive: true });
  if (!NO_PDF) fs.mkdirSync(PDF_DIR, { recursive: true });

  const chrome = NO_PDF ? null : findChrome();
  if (!NO_PDF && !chrome) {
    console.warn("! Chrome/Edge를 찾지 못했습니다. HTML만 생성합니다 (CHROME_PATH 지정 가능).");
  }

  for (const entry of base) {
    entry.html = markdownToHtml({ file: entry.file, dir: BASE });
    fs.writeFileSync(
      path.join(BASE_HTML_DIR, `${entry.slug}.html`),
      buildPage({
        title: `${entry.division} — 기본 정리`,
        css,
        nav: `<nav class="topnav"><a href="../index.html">← 목록으로</a></nav>`,
        body: `<article class="note">
<div class="meta"><span>기본 정리 · ${escapeHtml(entry.sources)}</span></div>
<h1>${escapeHtml(entry.division)}</h1>
${shiftHeadings(entry.html)}
</article>`,
      }),
      "utf8",
    );
  }

  for (const note of notes) {
    note.html = markdownToHtml(note);

    const meta = [note.created.replace("T", " ").slice(0, 16), [note.division, note.part].filter(Boolean).join(" · "), note.topics.join(" · ")]
      .filter(Boolean)
      .join(" · ");

    fs.writeFileSync(
      path.join(HTML_DIR, `${note.id}.html`),
      buildPage({
        title: note.title,
        css,
        nav: `<nav class="topnav"><a href="../index.html">← 목록으로</a></nav>`,
        body: `<article class="note">
<div class="meta"><span>${escapeHtml(meta)}</span></div>
<h1>${escapeHtml(note.title)}</h1>
${note.html}
</article>`,
      }),
      "utf8",
    );
  }

  const tree = buildTree(notes, taxonomy);

  const configPath = path.join(ROOT, "app", "config.json");
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const categoriesPath = path.join(BASE, "categories.json");
    const editorConfig = {
      ...config,
      categories: fs.existsSync(categoriesPath)
        ? JSON.parse(fs.readFileSync(categoriesPath, "utf8"))
        : {},
      divisions: base.map((entry) => entry.division),
    };
    const editor = fs
      .readFileSync(path.join(ROOT, "app", "index.html"), "utf8")
      .replace("</head>", `<script>window.FM_CONFIG = ${JSON.stringify(editorConfig)};<\/script>\n</head>`);
    fs.writeFileSync(path.join(DIST, "new.html"), editor, "utf8");
  }

  fs.writeFileSync(path.join(DIST, "index.html"), buildIndex(tree, base, css), "utf8");

  if (chrome && (notes.length || base.length)) {
    const bookPath = path.join(HTML_DIR, "_book.html");
    const pdfPath = path.join(PDF_DIR, "fm_board_all.pdf");
    const outlinePath = path.join(PDF_DIR, "_outline.json");

    const tocTitles = (html) => bookToc(html).map((entry) => entry.title);

    // 1차 인쇄 → 북마크 심기 → 목차 쪽번호 읽기 → 쪽번호 넣어 2차 인쇄(쪽 구성이 같아야 함)
    const printOnce = (pages) => {
      const html = buildBook(tree, base, css, pages);
      fs.writeFileSync(bookPath, html, "utf8");
      fs.writeFileSync(outlinePath, JSON.stringify({ items: collectOutline(html) }), "utf8");
      printPdf(chrome, bookPath, pdfPath);
      return html;
    };

    let html = printOnce(null);
    let toc = JSON.parse(addOutline(pdfPath, outlinePath, { returnToc: true }) || "[]");
    const titles = tocTitles(html);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pages = tocPages(toc, titles);
      if (!pages.filter(Boolean).length) break;
      const previous = JSON.stringify(pages);
      html = printOnce(pages);
      toc = JSON.parse(addOutline(pdfPath, outlinePath, { returnToc: true }) || "[]");
      if (JSON.stringify(tocPages(toc, titles)) === previous) break;
    }

    decoratePdf(pdfPath, outlinePath, "가정의학과 기출 개념 단권화");
    assertKoreanFont(pdfPath);
    fs.rmSync(outlinePath, { force: true });
    fs.rmSync(bookPath);
  }

  const uncategorized = notes.filter((n) => !n.division).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `완료: 기본 ${base.length}단원 · 기록 ${notes.length}개 · ${tree.chapters.length}개 대단원` +
      (uncategorized ? ` (미분류 ${uncategorized})` : "") +
      ` · ${seconds}s → dist/`,
  );
  return { notes, tree, base };
}

function main() {
  try {
    build();
  } catch (error) {
    console.error(`\n${error.message}\n`);
    if (!WATCH) process.exit(1);
  }

  if (!WATCH) return;

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`\n[${new Date().toLocaleTimeString("ko-KR")}] 변경 감지 → 다시 빌드`);
      try {
        build();
      } catch (error) {
        console.error(`\n${error.message}\n`);
      }
    }, 600);
  };

  for (const dir of [NOTES, TEMPLATES]) {
    if (fs.existsSync(dir)) fs.watch(dir, { recursive: true }, schedule);
  }
  console.log("감시 중… notes/ 또는 templates/ 수정 시 자동 빌드 (Ctrl+C 종료)");
}

main();
