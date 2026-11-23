#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const NOTES = path.join(ROOT, "notes");
const TEMPLATES = path.join(ROOT, "templates");
const DIST = path.join(ROOT, "dist");
const HTML_DIR = path.join(DIST, "html");
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
      body: hasPolished ? polished.body : entry.body,
    });
  }
  return notes.sort((a, b) => a.created.localeCompare(b.created));
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
  return result.stdout.replace(/<colgroup>[\s\S]*?<\/colgroup>\s*/g, "");
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
  assertKoreanFont(pdfPath);
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

function topicRank(taxonomy, division, part, topic) {
  const list = taxonomy?.[division]?.[part] ?? [];
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

function buildBook(tree, css) {
  const total = tree.chapters.reduce(
    (sum, chapter) => sum + chapter.parts.reduce((s, p) => s + p.topics.reduce((n, t) => n + t.notes.length, 0), 0),
    0,
  );
  const looseCount = tree.loose.length;
  const now = new Date();

  const cover = `<section class="cover">
  <div class="cover-kicker">가정의학과 전문의</div>
  <h1 class="cover-title">기출 개념 단권화</h1>
  <div class="cover-rule"></div>
  <div class="cover-meta">${total + looseCount}개 기록 · ${tree.chapters.length}개 대단원 · ${now.getFullYear()}. ${now.getMonth() + 1}. ${now.getDate()}</div>
</section>`;

  const noteArticle = (note) => `<article class="note">
  <h3 class="note-title">${escapeHtml(note.title)}</h3>
${note.html}
</article>`;

  const chapters = tree.chapters
    .map((chapter) => {
      const body = chapter.parts
        .map((part) => {
          const partHeading = part.part ? `<h2 class="part-title">${escapeHtml(part.part)}</h2>` : "";
          const topics = part.topics
            .map((group) => {
              const heading = group.topic
                ? `<h2 class="topic-title">${escapeHtml(group.topic)}</h2>`
                : "";
              return `${heading}
${group.notes.map(noteArticle).join("\n")}`;
            })
            .join("\n");
          return `${partHeading}
${topics}`;
        })
        .join("\n");

      return `<section class="chapter">
  <h1 class="chapter-title">${escapeHtml(chapterTitle(chapter.division))}</h1>
${body}
</section>`;
    })
    .join("\n");

  const loose = tree.loose.length
    ? `<section class="chapter">
  <h1 class="chapter-title">${UNCATEGORIZED}</h1>
${tree.loose.map(noteArticle).join("\n")}
</section>`
    : "";

  return buildPage({
    title: "가정의학과 기출 개념 단권화",
    css,
    body: `${cover}\n${chapters}\n${loose}`,
  });
}

function buildIndex(tree, css) {
  const count = (chapter) =>
    chapter.parts.reduce((s, p) => s + p.topics.reduce((n, t) => n + t.notes.length, 0), 0);
  const total = tree.chapters.reduce((sum, c) => sum + count(c), 0) + tree.loose.length;

  const linkFor = (note) =>
    `<li><a class="title" href="html/${encodeURIComponent(note.id)}.html">${escapeHtml(note.title)}</a>
      <span class="links"><a href="html/${encodeURIComponent(note.id)}.html">HTML</a></span></li>`;

  const sections = tree.chapters
    .map((chapter) => {
      const parts = chapter.parts
        .map((part) => {
          const partHeading = part.part ? `<h3 class="part-head">${escapeHtml(part.part)}</h3>` : "";
          const topics = part.topics
            .map(
              (group) => `${group.topic ? `<h4 class="topic-head">${escapeHtml(group.topic)}</h4>` : ""}
        <ul class="doc-list">${group.notes.map(linkFor).join("")}</ul>`,
            )
            .join("\n");
          return `${partHeading}\n${topics}`;
        })
        .join("\n");

      return `<section class="cat-block">
  <h2 class="cat-head">${escapeHtml(chapter.division)}<span class="count">${count(chapter)}</span></h2>
${parts}
</section>`;
    })
    .join("\n");

  const loose = tree.loose.length
    ? `<section class="cat-block">
  <h2 class="cat-head">${UNCATEGORIZED}<span class="count">${tree.loose.length}</span></h2>
  <ul class="doc-list">${tree.loose.map(linkFor).join("")}</ul>
</section>`
    : "";

  const body = `<h1>가정의학과 기출 개념 단권화</h1>
<p class="lede">${total}개 기록 · ${tree.chapters.length}개 대단원 · 빌드 ${new Date().toLocaleString("ko-KR")}</p>
<p class="lede"><a href="new.html">새 기록 쓰기</a> · <a href="pdf/fm_board_all.pdf">전체 PDF 열기</a></p>
${total ? sections + loose : `<p class="empty">아직 기록이 없습니다.</p>`}`;

  return buildPage({ title: "가정의학과 기출 개념 단권화", body, css });
}

function build() {
  const started = Date.now();
  const css = fs.readFileSync(path.join(TEMPLATES, "style.css"), "utf8");
  const taxonomy = loadTaxonomy();
  const notes = loadNotes();

  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(HTML_DIR, { recursive: true });
  if (!NO_PDF) fs.mkdirSync(PDF_DIR, { recursive: true });

  const chrome = NO_PDF ? null : findChrome();
  if (!NO_PDF && !chrome) {
    console.warn("! Chrome/Edge를 찾지 못했습니다. HTML만 생성합니다 (CHROME_PATH 지정 가능).");
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
    const editor = fs
      .readFileSync(path.join(ROOT, "app", "index.html"), "utf8")
      .replace("</head>", `<script>window.FM_CONFIG = ${JSON.stringify(config)};<\/script>\n</head>`);
    fs.writeFileSync(path.join(DIST, "new.html"), editor, "utf8");
  }

  fs.writeFileSync(path.join(DIST, "index.html"), buildIndex(tree, css), "utf8");

  if (chrome && notes.length) {
    const bookPath = path.join(HTML_DIR, "_book.html");
    fs.writeFileSync(bookPath, buildBook(tree, css), "utf8");
    printPdf(chrome, bookPath, path.join(PDF_DIR, "fm_board_all.pdf"));
    fs.rmSync(bookPath);
  }

  const uncategorized = notes.filter((n) => !n.division).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `완료: ${notes.length}개 기록 · ${tree.chapters.length}개 대단원` +
      (uncategorized ? ` (미분류 ${uncategorized})` : "") +
      ` · ${seconds}s → dist/`,
  );
  return { notes, tree };
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
