#!/usr/bin/env node
/**
 * hierarchy_llm.mjs — 평평하거나 잘못 들여쓴 소단원을 LLM 으로 계층 정리한다.
 *
 * 규칙 기반으로는 판단이 안 되는 일(어느 줄이 어느 줄의 하위인지, 한 줄에 몇 개 계층이
 * 뭉쳐 있는지)을 command code CLI 에 맡긴다. 결과는 글자 보존 검사(check_content.py)를
 * 통과해야만 남긴다. 실패하면 그 파일은 HEAD 판으로 되돌린다.
 *
 *   node scripts/hierarchy_llm.mjs --limit 2            # 상위 2개 섹션
 *   node scripts/hierarchy_llm.mjs --top                # 1순위 하나만
 *   node scripts/hierarchy_llm.mjs --dry-run            # 대상만 출력
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = path.join(ROOT, "base");
const STATE = path.join(ROOT, "reports", "hierarchy-done.json");
const MODEL = process.env.FM_MODEL || "deepseek/deepseek-v4.1-flash";
const EFFORT = process.env.FM_EFFORT || "low";
const TIMEOUT = 20 * 60 * 1000;

const argv = process.argv.slice(2);
const limit = argv.includes("--top") ? 1 : Number((argv[argv.indexOf("--limit") + 1] || "2").replace(/[^\d]/g, "")) || 2;
const dry = argv.includes("--dry-run");

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  return { ok: result.status === 0, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

function py(args) {
  const first = run("python3", args);
  return first.ok ? first : run("python", args);
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

function promptFor(file, section) {
  return (
    `저장소 루트의 STYLE.md 를 읽고, base/${file} 파일의 '### ${section}' 섹션 하나만 계층을 정리해라. ` +
    "다른 섹션과 다른 파일은 건드리지 마라. 규칙: " +
    "① 문장·수치·약물명·검사명은 한 글자도 바꾸지 않는다(위치와 들여쓰기만 바꾼다). " +
    "② 한 줄에 계층이 여러 개 뭉쳐 있으면(예: '급성기 치료: 혈역학 불안정 → Cardioversion, 안정 → CCB') 줄을 나눠 상위 불릿과 하위 불릿으로 만든다. " +
    "③ 들여쓰기가 잘못돼 있으면(상위여야 할 것이 하위에 있거나 그 반대) 바로잡는다. " +
    "④ 병명이 불릿 머리에 있으면 '### 병명' 소단원으로 승격하고 그 설명을 하위 불릿으로 둔다. " +
    "⑤ 한 줄짜리 병명을 개별 소단원으로 남발하지 마라. 같은 성격이 3개 이상 모일 때만 승격하고, 아니면 상위 소단원의 불릿으로 묶어라. " +
    "⑥ 족보 표시(￥)는 지우지 않는다. git 명령은 실행하지 마라. 완료하면 수정한 파일 경로만 출력해라."
  );
}

function main() {
  const rows = auditRows();
  if (!rows.length) {
    console.log("점검할 섹션이 없다.");
    return;
  }
  const done = doneList();
  const targets = rows.filter((row) => !done.includes(`${row.division}/${row.section}`)).slice(0, limit);
  if (!targets.length) {
    saveDone([]);
    console.log("남은 대상이 없어 완료 목록을 초기화했다.");
    return;
  }
  for (const target of targets) console.log(`대상: ${target.division} / ${target.section} (${target.score})`);
  if (dry) return;

  for (const target of targets) {
    const file = baseFile(target.division);
    if (!file) {
      console.log(`  ! ${target.division}: base 파일을 찾지 못함`);
      continue;
    }
    console.log(`  ${file} ← '${target.section}' 정리 중…`);
    const command =
      `cmdc.cmd -p "${promptFor(file, target.section).replace(/"/g, "'")}"` +
      ` --model "${MODEL}" --effort "${EFFORT}"` +
      " --permission-mode accept-edits --trust --skip-onboarding --no-auto-update --output-format text";
    const agent = spawnSync(command, { cwd: ROOT, shell: true, encoding: "utf8", timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024 });
    console.log(`  에이전트 종료 (status=${agent.status})`);

    const check = py(["scripts/check_content.py", `base/${file}`, "--quiet"]);
    if (!check.ok) {
      run("git", ["checkout", "--", `base/${file}`]);
      console.log(`  ! ${file}: 글자 유실 → 되돌림`);
      continue;
    }
    console.log(`  ${file}: 계층 정리 반영`);
    done.push(`${target.division}/${target.section}`);
    saveDone(done);
  }
}

main();
