#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const NOTES = path.join(ROOT, "notes");
const LOGS = path.join(ROOT, "logs");
const QUEUE = path.join(ROOT, ".triage-queue.txt");
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
    shell: process.platform === "win32",
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

  const build = run(process.execPath, ["scripts/build.mjs", "--no-pdf"]);
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
