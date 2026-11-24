#!/usr/bin/env node
/**
 * merge_api.mjs — 새 기록(polished.md)을 base 의 해당 소단원 안으로 병합한다. (API 직접 호출)
 *
 * 대상 섹션을 잘라 모델에 보내고, 돌려받은 섹션으로 교체한다.
 * check_content.py 를 통과해야 남기고, 실패하면 파일을 되돌린다.
 * 성공하면 entry.md 에 merged: true 를 찍는다.
 *
 *   node scripts/merge_api.mjs [--dry-run] [--id notes/<id>]
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { complete } from "./llm.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const NOTES = path.join(ROOT, "notes");
const BASE = path.join(ROOT, "base");
const argv = process.argv.slice(2);
const dry = argv.includes("--dry-run");
const onlyId = argv.includes("--id") ? argv[argv.indexOf("--id") + 1] : "";

function py(args) {
  const run = (cmd) => spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  const first = run("python3");
  return first.status === 0 ? { ok: true, out: `${first.stdout}${first.stderr}` } : run("python");
}

function frontMatter(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const data = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (kv) data[kv[1].toLowerCase()] = kv[2].trim();
    }
  }
  return { data, body: text.slice(match ? match[0].length : 0) };
}

function pending() {
  if (!fs.existsSync(NOTES)) return [];
  return fs
    .readdirSync(NOTES)
    .filter((id) => !onlyId || `notes/${id}` === onlyId)
    .filter((id) => fs.existsSync(path.join(NOTES, id, "polished.md")))
    .filter((id) => String(frontMatter(path.join(NOTES, id, "entry.md")).data.merged).toLowerCase() !== "true");
}

function baseFile(division) {
  const files = fs.readdirSync(BASE).filter((name) => name.endsWith(".md"));
  return files.find((name) => name.startsWith(division));
}

function sectionRange(text, title) {
  const lines = text.split("\n");
  let start = lines.findIndex((line) => line.trim() === `### ${title}`);
  if (start === -1) start = lines.findIndex((line) => line.trim().startsWith(`### ${title}`));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("### ")) end += 1;
  return { lines, start, end };
}

function pickSection(text, topics) {
  const titles = [...text.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
  for (const topic of topics) {
    const exact = titles.find((title) => title === topic);
    if (exact) return exact;
    const partial = titles.find((title) => title.includes(topic) || topic.includes(title));
    if (partial) return partial;
    // 괄호가 잘린 토픽("… (Chest pain")은 앞부분으로 다시 맞춘다
    const stem = topic.replace(/\s*\(.*$/, "").trim();
    if (stem) {
      const fuzzy = titles.find((title) => title.startsWith(stem) || title.includes(stem));
      if (fuzzy) return fuzzy;
    }
  }
  return "";
}

function promptFor(section, note) {
  return [
    "너는 한국어 의학 교재 편집자다. 아래 '기존 소단원'에 '새 기록'의 내용을 자연스럽게 합쳐라.",
    "규칙:",
    "1) 기존 항목을 빼지 않는다. 새 내용도 빠뜨리지 않는다.",
    "2) 같은 사실은 하나로 합치고, 새 항목은 관련 위치에 넣는다. 단원 끝에 몰아 붙이지 않는다.",
    "3) 수치·단위·약물명·검사명은 그대로 쓴다. 같은 의미로 더 짧고 부드럽게 다듬는 것은 허용.",
    "4) 흐름이 갈리면 하위 불릿으로 나눈다(급성기 치료, 리듬 조절, 예방 같은 단계).",
    "5) 족보 표시(￥)는 그대로 둔다.",
    "출력은 합친 마크다운만. 설명·코드펜스 금지. 첫 줄은 반드시 '### ' 로 시작한다.",
    "",
    "```markdown",
    section,
    "```",
    "",
    "새 기록:",
    "```markdown",
    note,
    "```",
  ].join("\n");
}

function stripFence(text) {
  return text.replace(/^```(?:markdown)?\n/, "").replace(/\n```$/, "").trim();
}

function markMerged(id) {
  const entry = path.join(NOTES, id, "entry.md");
  const text = fs.readFileSync(entry, "utf8");
  if (/^merged:\s*true$/m.test(text)) return;
  const stamped = /^created:.*$/m.test(text)
    ? text.replace(/^(created:.*)$/m, "$1\nmerged: true")
    : text.replace(/^---\n/, "---\nmerged: true\n");
  fs.writeFileSync(entry, stamped, "utf8");
}

async function mergeOne(id) {
  const { data } = frontMatter(path.join(NOTES, id, "entry.md"));
  const division = data.division || "";
  if (!division) return { ok: false, reason: "대단원 없음" };
  const file = baseFile(division);
  if (!file) return { ok: false, reason: "base 파일 없음" };

  const filePath = path.join(BASE, file);
  const text = fs.readFileSync(filePath, "utf8");
  const topics = String(data.topics || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const title = pickSection(text, topics);

  if (!title) {
    // 기존에 없는 주제면 새 소단원을 만든다. categories.json 순서를 참고해 앞 주제 뒤에 넣는다.
    const wanted = topics[0];
    if (!wanted) return { ok: false, reason: "대단원/소단원 없음" };
    const section = `### ${wanted}\n\n${fs.readFileSync(path.join(NOTES, id, "polished.md"), "utf8").trim()}\n`;
    let insertAt = text.length;
    try {
      const categories = JSON.parse(fs.readFileSync(path.join(BASE, "categories.json"), "utf8"));
      const order = Object.values(categories[division] || {}).flat();
      const index = order.indexOf(wanted);
      for (let i = index - 1; i >= 0; i -= 1) {
        const previous = order[i];
        const found = sectionRange(text, previous);
        if (found) {
          insertAt = found.lines.slice(0, found.end).join("\n").length;
          break;
        }
      }
    } catch {
      /* 순서를 모르면 파일 끝에 붙인다 */
    }
    const updated = `${text.slice(0, insertAt).trimEnd()}\n\n${section}\n${text.slice(insertAt).trimStart()}`;
    fs.writeFileSync(filePath, updated, "utf8");
    const check = py(["scripts/check_content.py", `base/${file}`, "--quiet"]);
    if (!check.ok) {
      fs.writeFileSync(filePath, text, "utf8");
      return { ok: false, reason: "내용 삭제 감지" };
    }
    markMerged(id);
    return { ok: true, reason: `'${wanted}' 소단원 새로 만듦` };
  }

  const range = sectionRange(text, title);
  const section = range.lines.slice(range.start, range.end).join("\n").trim();
  // polished.md 의 front matter 는 보내지 않는다(섹션에 섞이면 목차 제목이 중복된다)
  const note = frontMatter(path.join(NOTES, id, "polished.md")).body.trim();

  const answer = stripFence(await complete(promptFor(section, note), { maxTokens: 8000 }));
  if (!answer.startsWith("### ")) return { ok: false, reason: "형식 위반" };

  const before = text;
  const updated = [...range.lines.slice(0, range.start), `${answer.trim()}\n`, ...range.lines.slice(range.end)].join("\n");
  fs.writeFileSync(filePath, updated, "utf8");

  const check = py(["scripts/check_content.py", `base/${file}`, "--quiet"]);
  if (!check.ok) {
    fs.writeFileSync(filePath, before, "utf8");
    return { ok: false, reason: "내용 삭제 감지" };
  }

  markMerged(id);
  return { ok: true, reason: `'${title}' 에 병합` };
}

async function main() {
  const ids = pending();
  if (!ids.length) {
    console.log("병합할 기록이 없다.");
    return;
  }
  for (const id of ids) console.log(`대상: notes/${id}`);
  if (dry) return;

  for (const id of ids) {
    try {
      const result = await mergeOne(id);
      console.log(`  ${result.ok ? "✓" : "✗"} ${id} — ${result.reason}`);
    } catch (error) {
      console.log(`  ✗ ${id} — ${error.message.slice(0, 140)}`);
    }
  }
  console.log("병합 종료");
}

main();
