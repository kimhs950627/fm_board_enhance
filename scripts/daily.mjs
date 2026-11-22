#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const NOTES = path.join(ROOT, "notes");
const LOGS = path.join(ROOT, "logs");
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
    ...options,
  });
  return {
    ok: result.status === 0,
    status: result.status,
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
    const data = readFrontMatter(entry);
    if (String(data.locked).toLowerCase() === "true") continue;
    pending.push(`notes/${name}/entry.md`);
  }
  return pending.sort();
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

  const prompt = [
    "TRIAGE.md 규칙을 먼저 읽고 그대로 따라라.",
    "",
    "아래 각 entry.md에 대해 같은 폴더에 polished.md를 만든다.",
    ...targets.map((t) => `- ${t}`),
    "",
    "요약:",
    "- 의학적 사실·수치·용량·진단기준은 절대 변경하지 말 것. 애매하면 원문 유지.",
    "- front matter는 복사하고 categories만 채운다(쉼표로 여러 개 가능). polished: 오늘 날짜 추가.",
    "- 이미지 참조와 표는 그대로 둔다.",
    "- polished.md 외 파일 생성·수정 금지, git 명령 실행 금지.",
    "- 완료 후 처리한 파일 경로만 출력.",
  ].join("\n");

  log("에이전트 실행 중…");
  const agent = spawnSync(
    process.platform === "win32" ? "cmdc.cmd" : "cmdc",
    [
      "-p",
      prompt,
      "--model",
      MODEL,
      "--effort",
      EFFORT,
      "--permission-mode",
      "accept-edits",
      "--trust",
      "--skip-onboarding",
      "--no-auto-update",
      "--output-format",
      "text",
    ],
    { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", timeout: AGENT_TIMEOUT_MS },
  );

  const agentOut = `${agent.stdout || ""}${agent.stderr || ""}`.trim();
  log(`에이전트 종료 (status=${agent.status})`);
  if (agentOut) log(agentOut.split("\n").slice(-40).join("\n"));

  const missing = targets.filter((t) => !fs.existsSync(path.join(ROOT, t.replace("entry.md", "polished.md"))));
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

  run("git", ["add", "-A"]);
  const staged = run("git", ["diff", "--cached", "--name-only"]);
  if (!staged.out) {
    log("변경 사항 없음. 종료.");
    return;
  }

  const message = `triage: polish ${targets.length} note(s)\n\n${targets.join("\n")}`;
  const commit = run("git", ["commit", "-m", message]);
  if (!commit.ok) {
    log(`커밋 실패: ${commit.out}`);
    process.exit(1);
  }

  const push = run("git", ["push"]);
  log(push.ok ? "push 완료 → Action이 Pages에 배포" : `push 실패: ${push.out}`);
  log(staged.out.split("\n").length + "개 파일 변경");
  log("=== daily triage 끝 ===");
}

main();
