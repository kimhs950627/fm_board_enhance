#!/usr/bin/env node
/**
 * nightly_api.mjs — 04:00 무인 작업 (GitHub Actions / 로컬 공용).
 *
 * cmdc 없이 Command Code Provider API 만 쓴다.
 *   1) 위계 정리 (hierarchy_api)  2) 기록 병합 (merge_api)
 *   3) 기호 조판 · 규칙 승격  4) 빌드 검증  5) 커밋·push  6) 웹훅 알림
 *
 * 필요한 환경변수
 *   COMMANDCODE_API_KEY   (필수)
 *   DISCORD_WEBHOOK       (선택, 완료/실패 알림)
 *   FM_HIERARCHY_LIMIT    (기본 6)  FM_MERGE=0 이면 병합 생략
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOG_DIR = path.join(ROOT, "logs");
const HIERARCHY_LIMIT = process.env.FM_HIERARCHY_LIMIT || "6";

fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG = path.join(LOG_DIR, `nightly-${new Date().toISOString().slice(0, 10)}.log`);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG, `${line}\n`, "utf8");
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, out: `${result.stdout || ""}${result.stderr || ""}`.trim() };
}

function node(script, args = []) {
  return run(process.execPath, [script, ...args]);
}

async function notify(message) {
  const url = process.env.DISCORD_WEBHOOK || "";
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch {
    /* 알림 실패는 작업을 막지 않는다 */
  }
}

async function main() {
  log("=== nightly 시작 ===");
  if (!process.env.COMMANDCODE_API_KEY) {
    log("COMMANDCODE_API_KEY 없음 → 중단");
    await notify("fm_board_enhance 04:00 실패 — API 키가 없다");
    process.exit(1);
  }

  let hierarchy = { out: "" };
  let merge = { out: "" };

  // ① 위계 정리 먼저
  hierarchy = node("scripts/hierarchy_api.mjs", ["--limit", HIERARCHY_LIMIT, "--parallel", "3"]);
  log(hierarchy.out.split("\n").slice(-6).join(" | "));

  // ② 새 기록 다듬기(polished.md) → 병합
  if (process.env.FM_MERGE !== "0") {
    const polish = node("scripts/polish_api.mjs");
    log(polish.out.split("\n").slice(-6).join(" | "));
    merge = node("scripts/merge_api.mjs");
    log(merge.out.split("\n").slice(-6).join(" | "));
  }

  // ③ 결정적 정리: 기호 조판 → 규칙 승격
  for (const script of ["scripts/typeset_symbols.py", "scripts/normalize_hierarchy.py"]) {
    const result = run("python3", [script]);
    if (!result.ok) run("python", [script]);
    log(`${script}: ${result.out.split("\n").slice(-1).join("")}`);
  }

  // ④ 빌드 검증
  const build = node("scripts/build.mjs", ["--no-pdf"]);
  if (!build.ok) {
    log(`빌드 실패: ${build.out.slice(-300)}`);
    await notify("fm_board_enhance 04:00 실패 — 빌드 오류");
    process.exit(1);
  }

  // ⑤ 커밋·push (Actions 에서는 GITHUB_TOKEN 이 remote 인증을 맡는다)
  run("git", ["add", "base", "notes", "reports"]);
  const staged = run("git", ["diff", "--cached", "--name-only"]);
  if (!staged.out) {
    log("변경 없음 → 종료");
    await notify("fm_board_enhance 04:00 — 변경 없음(할 일 없음)");
    return;
  }
  run("git", ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit", "-m", "nightly: 계층 정리·기록 병합"]);
  const push = run("git", ["push"]);
  log(push.ok ? "push 완료" : `push 실패: ${push.out}`);

  const hierarchyCount = (hierarchy.out.match(/✓/g) || []).length;
  const mergeCount = (merge.out.match(/✓/g) || []).length;
  await notify(
    push.ok
      ? `fm_board_enhance 04:00 완료 — 위계 ${hierarchyCount}건 · 병합 ${mergeCount}건 · 사이트·PDF 갱신`
      : "fm_board_enhance 04:00 — push 실패",
  );
  log("=== nightly 끝 ===");
}

main();
