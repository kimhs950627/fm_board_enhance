#!/usr/bin/env node
/**
 * hierarchy_bulk.mjs — 전수 계층 점검을 대단원 파일 단위로 LLM 에 돌린다.
 *
 * audit 이 뽑은 '아직 평평한 소단원'을 파일별로 묶어, 파일 하나당 에이전트 하나를 띄운다.
 * 동시에 3개까지 병렬 실행하고, 파일마다 글자 보존 검사를 통과해야 남긴다.
 * 처리한 섹션은 reports/hierarchy-done.json 에 쌓여 다음 실행에서 건너뛴다.
 *
 *   node scripts/hierarchy_bulk.mjs --parallel 3
 *   node scripts/hierarchy_bulk.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = path.join(ROOT, "base");
const STATE = path.join(ROOT, "reports", "hierarchy-done.json");
const MODEL = process.env.FM_MODEL || "deepseek/deepseek-v4.1-flash";
const EFFORT = process.env.FM_EFFORT || "low";
const TIMEOUT = 30 * 60 * 1000;

const argv = process.argv.slice(2);
const parallel = Math.max(1, Number((argv[argv.indexOf("--parallel") + 1] || "3").replace(/[^\d]/g, "")) || 3);
const dry = argv.includes("--dry-run");

function py(args) {
  const a = spawnSync("python3", args, { cwd: ROOT, encoding: "utf8" });
  if (a.status === 0) return { ok: true, out: `${a.stdout}${a.stderr}`.trim() };
  const b = spawnSync("python", args, { cwd: ROOT, encoding: "utf8" });
  return { ok: b.status === 0, out: `${b.stdout}${b.stderr}`.trim() };
}

function pending() {
  const audit = py(["scripts/hierarchy_audit.py", "--print"]);
  if (!audit.ok) return [];
  let done = [];
  try {
    done = JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    done = [];
  }
  return audit.out
    .split("\n")
    .filter((line) => /^\| \d/.test(line))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .map(([, score, division, section]) => ({ score: Number(score), division, section }))
    .filter((row) => !done.includes(`${row.division}/${row.section}`));
}

function byFile(rows) {
  const files = fs.readdirSync(BASE).filter((name) => name.endsWith(".md"));
  const groups = new Map();
  for (const row of rows) {
    const file =
      files.find((name) => name.startsWith(row.division)) || files.find((name) => name === `${row.division}.md`);
    if (!file) continue;
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(row);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

function promptFor(file, sections) {
  return (
    `저장소 루트의 STYLE.md 를 읽고 base/${file} 의 다음 소단원만 계층을 정리해라: ${sections.join(", ")}. ` +
    "다른 소단원과 다른 파일은 건드리지 마라. 규칙: " +
    "① 문장·수치·약물명·검사명은 한 글자도 바꾸지 않는다(위치·들여쓰기·제목만). " +
    "② 한 줄에 계층이 여러 개 뭉쳐 있으면 상위 불릿과 하위 불릿으로 나눈다. " +
    "③ 들여쓰기가 잘못됐으면 바로잡는다(상위여야 할 것이 하위에 있거나 반대인 경우). " +
    "④ 병명이 불릿 머리에 있으면 '### 병명' 으로 승격하고 설명을 하위 불릿으로 둔다. " +
    "⑤ 한 줄짜리 병명을 개별 소단원으로 남발하지 마라. 같은 성격 3개 이상 모일 때만 승격한다. " +
    "⑥ 제목 앞에는 반드시 빈 줄을 둔다. ⑦ 족보 표시(￥)는 지우지 않는다. git 명령은 실행하지 마라. " +
    "완료하면 수정한 파일 경로만 출력해라."
  );
}

function windowsPath() {
  const result = spawnSync("wslpath", ["-w", ROOT], { encoding: "utf8" });
  return (result.stdout || ROOT).trim();
}

function runAgent(file, sections) {
  // hierarchy_llm.mjs 와 같은 방식(shell:true + cmd 문자열)으로 실행한다.
  const prompt = promptFor(file, sections).replace(/"/g, "'");
  const command =
    `cmdc.cmd -p "${prompt}" --model "${MODEL}" --effort "${EFFORT}"` +
    " --permission-mode accept-edits --trust --skip-onboarding --no-auto-update --output-format text";
  const result = spawnSync(command, { cwd: ROOT, shell: true, encoding: "utf8", timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024 });
  return { code: result.status, out: `${result.stdout || ""}${result.stderr || ""}`.slice(-400) };
}

async function main() {
  const rows = pending();
  if (!rows.length) {
    console.log("남은 계층 점검 대상이 없다.");
    return;
  }
  const groups = byFile(rows);
  console.log(`대상 ${rows.length}개 섹션 / ${groups.length}개 파일 (동시 ${parallel})`);
  if (dry) {
    for (const [file, list] of groups) console.log(`  ${file}: ${list.length}개`);
    return;
  }

  let done = [];
  try {
    done = JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    done = [];
  }

  const queue = [...groups];
  const workers = Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) {
      const [file, list] = queue.shift();
      console.log(`→ ${file} (${list.length}개 섹션)`);
      const before = spawnSync("git", ["diff", "--stat", "--", `base/${file}`], { cwd: ROOT, encoding: "utf8" }).stdout;
      const result = await runAgent(
        file,
        list.map((row) => row.section),
      );
      const after = spawnSync("git", ["diff", "--stat", "--", `base/${file}`], { cwd: ROOT, encoding: "utf8" }).stdout;
      console.log(`  ${file}: agent exit=${result.code}`);
      if (before === after) {
        // 파일이 실제로 바뀌지 않았으면 성공으로 치지 않는다
        console.log(`  - ${file}: 변경 없음 (건너뜀)`);
        continue;
      }
      const check = py(["scripts/check_content.py", `base/${file}`, "--quiet"]);
      if (!check.ok) {
        spawnSync("git", ["checkout", "--", `base/${file}`], { cwd: ROOT });
        console.log(`  ! ${file}: 글자 유실 → 되돌림`);
        continue;
      }
      done.push(...list.map((row) => `${row.division}/${row.section}`));
      fs.writeFileSync(STATE, JSON.stringify([...new Set(done)], null, 1) + "\n", "utf8");
      console.log(`  ✓ ${file}: 반영`);
    }
  });
  await Promise.all(workers);
  console.log("전수 계층 점검 종료");
}

main();
