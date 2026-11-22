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

function parseCategories(data) {
  const raw = data.categories || data.category || "";
  return [...new Set(raw.split(",").map((c) => c.trim()).filter(Boolean))];
}

function loadNotes() {
  if (!fs.existsSync(NOTES)) return [];
  const notes = [];
  for (const name of fs.readdirSync(NOTES)) {
    const dir = path.join(NOTES, name);
    const file = path.join(dir, "entry.md");
    if (!fs.existsSync(file)) continue;
    const { data, body } = parseFrontMatter(fs.readFileSync(file, "utf8"));
    notes.push({
      id: data.id || name,
      dir,
      title: data.title || "(제목 없음)",
      categories: parseCategories(data),
      created: data.created || "",
      body,
    });
  }
  return notes.sort((a, b) => a.created.localeCompare(b.created));
}

function markdownToHtml(note) {
  const result = spawnSync(
    "pandoc",
    [
      "entry.md",
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
}

function groupByCategory(notes) {
  const groups = new Map();
  for (const note of notes) {
    const keys = note.categories.length ? note.categories : [UNCATEGORIZED];
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(note);
    }
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === UNCATEGORIZED) return 1;
    if (b === UNCATEGORIZED) return -1;
    return a.localeCompare(b, "ko");
  });
  return keys.map((key) => ({ category: key, notes: groups.get(key) }));
}

function noteMetaLine(note) {
  const parts = [];
  if (note.created) parts.push(note.created.replace("T", " ").slice(0, 16));
  if (note.categories.length) parts.push(note.categories.join(" · "));
  return parts.join(" · ");
}

function buildBook(groups, css) {
  const total = groups.reduce((sum, g) => sum + g.notes.length, 0);
  const now = new Date();

  const cover = `<section class="cover">
  <div class="cover-kicker">가정의학과 전문의</div>
  <h1 class="cover-title">기출 개념 단권화</h1>
  <div class="cover-rule"></div>
  <div class="cover-meta">${total}개 기록 · ${groups.length}개 분류 · ${now.getFullYear()}. ${now.getMonth() + 1}. ${now.getDate()}</div>
</section>`;

  const chapters = groups
    .map((group) => {
      const notes = group.notes
        .map(
          (note, i) => `<article class="note">
  <h2 class="note-title"><span class="note-num">${String(i + 1).padStart(2, "0")}</span>${escapeHtml(note.title)}</h2>
${note.html}
</article>`,
        )
        .join("\n");

      return `<section class="chapter">
  <h1 class="chapter-title">${escapeHtml(group.category)}</h1>
${notes}
</section>`;
    })
    .join("\n");

  return buildPage({
    title: "가정의학과 기출 개념 단권화",
    css,
    body: `${cover}\n${chapters}`,
  });
}

function buildIndex(groups, css) {
  const total = groups.reduce((sum, g) => sum + g.notes.length, 0);

  const sections = groups
    .map(
      (group) => `<section class="cat-block">
  <h2 class="cat-head">${escapeHtml(group.category)}<span class="count">${group.notes.length}</span></h2>
  <ul class="doc-list">
${group.notes
  .map(
    (note) => `    <li>
      <span class="num">${(note.created || "").slice(5, 10).replace("-", ".")}</span>
      <a class="title" href="html/${encodeURIComponent(note.id)}.html">${escapeHtml(note.title)}</a>
    </li>`,
  )
  .join("\n")}
  </ul>
</section>`,
    )
    .join("\n");

  const body = `<h1>가정의학과 기출 개념 단권화</h1>
<p class="lede">${total}개 기록 · ${groups.length}개 분류 · 빌드 ${new Date().toLocaleString("ko-KR")}</p>
<p class="lede"><a href="new.html">새 기록 쓰기</a> · <a href="pdf/fm_board_all.pdf">전체 PDF 열기</a></p>
${total ? sections : `<p class="empty">아직 기록이 없습니다. <code>npm start</code> 로 입력 앱을 열어 저장하세요.</p>`}`;

  return buildPage({ title: "가정의학과 기출 개념 단권화", body, css });
}

function build() {
  const started = Date.now();
  const css = fs.readFileSync(path.join(TEMPLATES, "style.css"), "utf8");
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

    fs.writeFileSync(
      path.join(HTML_DIR, `${note.id}.html`),
      buildPage({
        title: note.title,
        css,
        nav: `<nav class="topnav"><a href="../index.html">← 목록으로</a></nav>`,
        body: `<article class="note">
<div class="meta"><span>${escapeHtml(noteMetaLine(note))}</span></div>
<h1>${escapeHtml(note.title)}</h1>
${note.html}
</article>`,
      }),
      "utf8",
    );
  }

  const groups = groupByCategory(notes);

  const configPath = path.join(ROOT, "app", "config.json");
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const editor = fs
      .readFileSync(path.join(ROOT, "app", "index.html"), "utf8")
      .replace("</head>", `<script>window.FM_CONFIG = ${JSON.stringify(config)};<\/script>\n</head>`);
    fs.writeFileSync(path.join(DIST, "new.html"), editor, "utf8");
  }

  fs.writeFileSync(path.join(DIST, "index.html"), buildIndex(groups, css), "utf8");

  if (chrome && notes.length) {
    const bookPath = path.join(HTML_DIR, "_book.html");
    fs.writeFileSync(bookPath, buildBook(groups, css), "utf8");
    printPdf(chrome, bookPath, path.join(PDF_DIR, "fm_board_all.pdf"));
    fs.rmSync(bookPath);
  }

  const uncategorized = notes.filter((n) => !n.categories.length).length;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `완료: ${notes.length}개 기록 · ${groups.length}개 분류` +
      (uncategorized ? ` (미분류 ${uncategorized})` : "") +
      ` · ${seconds}s → dist/`,
  );
  return { notes, groups };
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
