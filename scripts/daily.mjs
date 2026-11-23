#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const NOTES = path.join(ROOT, "notes");
const BASE = path.join(ROOT, "base");
const LOGS = path.join(ROOT, "logs");
const QUEUE = path.join(ROOT, ".triage-queue.txt");
const BASE_QUEUE = path.join(ROOT, ".base-queue.txt");
const MODEL = process.env.FM_MODEL || "deepseek/deepseek-v4.1-flash";
const EFFORT = process.env.FM_EFFORT || "low";
const AGENT_TIMEOUT_MS = 30 * 60 * 1000;

const stamp = new Date().toISOString().slice(0, 10);
fs.mkdirSync(LOGS, { recursive: true });
const LOG = path.join(LOGS, `daily-${stamp}.log`);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n", "utf8");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    out: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    out: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function readFrontMatter(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const data = {};
  if (!match) return data;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) data[kv[1].toLowerCase()] = kv[2].trim();
  }
  return data;
}

function pendingNotes() {
  if (!fs.existsSync(NOTES)) return [];
  const pending = [];
  for (const name of fs.readdirSync(NOTES)) {
    const dir = path.join(NOTES, name);
    const entry = path.join(dir, "entry.md");
    const polished = path.join(dir, "polished.md");
    if (!fs.existsSync(entry) || fs.existsSync(polished)) continue;
    if (String(readFrontMatter(entry).locked).toLowerCase() === "true") continue;
    pending.push(name);
  }
  return pending.sort();
}

function quote(value) {
  return `"${String(value).replace(/"/g, "")}"`;
}

// base 는 docx 를 옮긴 '기본 교재'다. 오늘 다듬은 기록을 base 의 해당 소제목 아래에
// 덧붙이게 하고, 기존 줄이 하나라도 지워지면 되돌린다(덧붙이기 전용).
function syncBase(targets) {
  const baseFiles = fs.existsSync(BASE)
    ? fs.readdirSync(BASE).filter((name) => name.endsWith(".md")).sort()
    : [];
  if (!baseFiles.length) {
    log("base 없음 → base 갱신 건너뜀");
    return;
  }

  fs.writeFileSync(
    BASE_QUEUE,
    [
      "# base/*.md 는 시험 기본 교재다. 아래 기록에서 base 에 없는 내용만 해당 소단원에 덧붙인다.",
      "# 규칙: 기존 줄을 지우거나 고치지 않는다(덧붙이기만). 없는 소단원이면 파일 끝에 '### <소단원>' 로 추가한다.",
      ...baseFiles.map((name) => `base/${name}`),
      "",
      "# 오늘 처리한 기록",
      ...targets.map((name) => `notes/${name}/polished.md`),
      "",
    ].join("\n"),
    "utf8",
  );

  const prompt =
    "이 저장소 루트의 .base-queue.txt 를 읽고 그 지시대로 작업해라. " +
    "base/*.md 는 시험 기본 교재이고, 오늘 다듬은 기록 내용을 해당 대단원 파일의 맞는 소단원에 덧붙인다. " +
    "기존 줄은 절대 지우거나 고치지 말고 덧붙이기만 한다. 중복되는 내용은 넣지 않는다. " +
    "git 명령은 실행하지 마라. 완료하면 수정한 base 파일 경로만 한 줄씩 출력해라.";

  const command =
    `cmdc.cmd -p ${quote(prompt)}` +
    ` --model ${quote(MODEL)} --effort ${quote(EFFORT)}` +
    ` --permission-mode accept-edits --trust --skip-onboarding --no-auto-update` +
    ` --output-format text`;

  log("base 갱신 에이전트 실행 중…");
  const agent = spawnSync(command, {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    timeout: AGENT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  log(`base 에이전트 종료 (status=${agent.status})`);

  const diff = run("git", ["diff", "--numstat", "--", "base"]);
  const removed = diff.out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 2 && Number(cols[1]) > 0);

  if (!diff.out.trim()) {
    log("base 변경 없음");
  } else if (removed.length) {
    log(`base 에서 줄이 지워짐 → 되돌림: ${removed.map((c) => c[2]).join(", ")}`);
    run("git", ["checkout", "--", "base"]);
  } else {
    log(`base 갱신: ${diff.out.split("\n").length}개 파일 (추가만)`);
  }

  fs.rmSync(BASE_QUEUE, { force: true });
}

function main() {
  log("=== daily triage 시작 ===");
  log(`model=${MODEL} effort=${EFFORT}`);

  const pull = run("git", ["pull", "--ff-only"]);
  if (!pull.ok) {
    log(`git pull 실패, 중단: ${pull.out}`);
    process.exit(1);
  }
  log(pull.out.includes("Already up to date") ? "pull: 이미 최신" : "pull: 갱신됨");

  const targets = pendingNotes();
  if (!targets.length) {
    log("처리할 노트 없음. 종료.");
    return;
  }
  log(`대상 ${targets.length}건: ${targets.join(", ")}`);

  fs.writeFileSync(
    QUEUE,
    [
      "# 아래 폴더마다 entry.md를 읽고 같은 폴더에 polished.md를 만든다.",
      "# 규칙: TRIAGE.md",
      ...targets.map((name) => `notes/${name}`),
      "",
    ].join("\n"),
    "utf8",
  );

  const prompt =
    "이 저장소 루트의 TRIAGE.md를 읽고 그 규칙대로 작업해라. " +
    "대상 목록은 .triage-queue.txt 에 있다. " +
    "각 대상 폴더의 entry.md를 읽고 같은 폴더에 polished.md를 만든다. " +
    "entry.md와 다른 파일은 수정하지 말고, git 명령도 실행하지 마라. " +
    "완료하면 처리한 경로만 한 줄씩 출력해라.";

  const command =
    `cmdc.cmd -p ${quote(prompt)}` +
    ` --model ${quote(MODEL)} --effort ${quote(EFFORT)}` +
    ` --permission-mode accept-edits --trust --skip-onboarding --no-auto-update` +
    ` --output-format text`;

  log("에이전트 실행 중…");
  const agent = spawnSync(command, {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    timeout: AGENT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });

  const agentOut = `${agent.stdout || ""}${agent.stderr || ""}`.trim();
  log(`에이전트 종료 (status=${agent.status})`);
  if (agentOut) log(agentOut.split("\n").slice(-30).join("\n"));

  const missing = targets.filter((name) => !fs.existsSync(path.join(NOTES, name, "polished.md")));
  if (missing.length) {
    log(`polished.md 누락 ${missing.length}건 → 커밋하지 않고 중단: ${missing.join(", ")}`);
    process.exit(1);
  }

  syncBase(targets);

  const build = runNode("scripts/build.mjs", ["--no-pdf"]);
  if (!build.ok) {
    log(`빌드 실패 → 커밋하지 않고 중단:\n${build.out}`);
    process.exit(1);
  }
  log("빌드 확인 통과");

  fs.rmSync(QUEUE, { force: true });

  run("git", ["add", "-A"]);
  const staged = run("git", ["diff", "--cached", "--name-only"]);
  if (!staged.out) {
    log("변경 사항 없음. 종료.");
    return;
  }

  const commit = run("git", ["commit", "-m", `triage: polish ${targets.length} note(s)`]);
  if (!commit.ok) {
    log(`커밋 실패: ${commit.out}`);
    process.exit(1);
  }
  log(`${staged.out.split("\n").length}개 파일 변경`);

  const push = run("git", ["push"]);
  log(push.ok ? "push 완료 → Action이 Pages에 배포" : `push 실패: ${push.out}`);
  log("=== daily triage 끝 ===");
}

main();
