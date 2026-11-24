#!/usr/bin/env node
/**
 * hierarchy_api.mjs — 평평한 소단원을 Command Code API 로 계층 정리한다.
 *
 * cmdc(에이전트) 대신 API 를 쓰므로 파일 편집은 이 스크립트가 직접 한다.
 * 모델은 '고친 섹션 마크다운'만 돌려주고, 우리가 그 섹션을 교체한다.
 * 교체 뒤 check_content.py 를 통과하지 못하면 파일을 되돌린다.
 *
 *   node scripts/hierarchy_api.mjs --limit 3 [--parallel 3] [--dry-run]
 *   node scripts/hierarchy_api.mjs --file base/심혈관.md --section "심방세동 …"
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { complete } from "./llm.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = path.join(ROOT, "base");
const STATE = path.join(ROOT, "reports", "hierarchy-done.json");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const limit = Number(arg("limit", "3")) || 3;
const parallel = Math.max(1, Number(arg("parallel", "2")) || 2);
const dry = argv.includes("--dry-run");

function py(args) {
  const run = (cmd) => spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  const first = run("python3");
  return first.status === 0 ? { ok: true, out: `${first.stdout}${first.stderr}` } : run("python");
}

function doneList() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return [];
  }
}

function saveDone(list) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify([...new Set(list)], null, 1) + "\n", "utf8");
}

function auditRows() {
  const result = py(["scripts/hierarchy_audit.py", "--print"]);
  if (!result.ok) return [];
  return result.out
    .split("\n")
    .filter((line) => /^\| \d/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .map(([, score, division, section]) => ({ score: Number(score), division, section }));
}

function baseFile(division) {
  const files = fs.readdirSync(BASE).filter((name) => name.endsWith(".md"));
  return files.find((name) => name.startsWith(division)) || files.find((name) => name === `${division}.md`);
}

/** '### 제목' 부터 다음 '###' 전까지를 잘라낸다. */
function sectionRange(text, title) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `### ${title}` || line.trim().startsWith(`### ${title}`));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("### ")) end += 1;
  return { lines, start, end };
}

function promptFor(file, section, body) {
  return [
    "너는 한국어 의학 교재의 편집자다. 아래 '### 소단원' 하나의 계층만 정리한다.",
    "규칙:",
    "1) 문장·수치·약물명·검사명은 그대로 둔다. 같은 의미로 더 짧고 부드럽게 다듬는 것은 허용.",
    "2) 다룬 항목을 빼지 않는다. 항목이 사라지면 실패다.",
    "3) 한 줄에 여러 계층이 뭉쳐 있으면 상위 불릿과 하위 불릿으로 나눈다.",
    "4) 들여쓰기가 잘못됐으면 바로잡는다(상위여야 할 것이 하위에 있거나 반대인 경우).",
    "5) 병명이 불릿 머리에 있으면 '### 병명' 으로 승격하되, 한 줄짜리 소단원을 남발하지 않는다.",
    "6) 족보 표시(￥)는 그대로 둔다.",
    "출력은 고친 마크다운만. 설명·코드펜스·머리말 금지. 첫 줄은 반드시 '### ' 로 시작한다.",
    "",
    `대상 파일: base/${file}`,
    "",
    "```markdown",
    body,
    "```",
  ].join("\n");
}

function stripFence(text) {
  return text
    .replace(/^```(?:markdown)?\n/, "")
    .replace(/\n```$/, "")
    .trim();
}

async function processOne(row, done) {
  const file = baseFile(row.division);
  if (!file) return { ok: false, reason: "base 파일 없음" };

  const filePath = path.join(BASE, file);
  const text = fs.readFileSync(filePath, "utf8");
  const range = sectionRange(text, row.section);
  if (!range) return { ok: false, reason: "섹션 없음" };

  const body = range.lines.slice(range.start, range.end).join("\n").trim();
  const answer = stripFence(await complete(promptFor(file, row.section, body), { maxTokens: 6000 }));
  if (!answer.startsWith("### ")) return { ok: false, reason: "형식 위반" };

  const before = fs.readFileSync(filePath, "utf8");
  const updated = [...range.lines.slice(0, range.start), `${answer.trim()}\n`, ...range.lines.slice(range.end)].join("\n");
  fs.writeFileSync(filePath, updated, "utf8");

  const check = py(["scripts/check_content.py", `base/${file}`, "--quiet"]);
  if (!check.ok) {
    fs.writeFileSync(filePath, before, "utf8");
    return { ok: false, reason: "내용 삭제 감지" };
  }

  done.push(`${row.division}/${row.section}`);
  saveDone(done);
  return { ok: true, reason: "정리" };
}

async function main() {
  const onlyFile = arg("file", "");
  const onlySection = arg("section", "");
  const done = doneList();

  let rows = auditRows().filter((row) => !done.includes(`${row.division}/${row.section}`));
  if (onlyFile) rows = rows.filter((row) => onlyFile.endsWith(row.division) || baseFile(row.division) === path.basename(onlyFile));
  if (onlySection) rows = rows.filter((row) => row.section === onlySection);
  rows = rows.slice(0, limit);

  if (!rows.length) {
    console.log("정리할 섹션이 없다.");
    return;
  }
  for (const row of rows) console.log(`대상: ${row.division} / ${row.section} (${row.score})`);
  if (dry) return;

  let index = 0;
  const workers = Array.from({ length: Math.min(parallel, rows.length) }, async () => {
    while (index < rows.length) {
      const row = rows[index++];
      try {
        const result = await processOne(row, done);
        console.log(`  ${result.ok ? "✓" : "✗"} ${row.division}/${row.section} — ${result.reason}`);
      } catch (error) {
        console.log(`  ✗ ${row.division}/${row.section} — ${error.message.slice(0, 120)}`);
      }
    }
  });
  await Promise.all(workers);
  console.log("계층 정리 종료");
}

main();
