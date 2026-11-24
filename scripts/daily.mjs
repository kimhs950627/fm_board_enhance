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

function notify(message) {
  try {
    spawnSync("discord-noti", [message], { shell: true, timeout: 20000 });
  } catch {
    /* 알림 실패는 작업을 막지 않는다 */
  }
}

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

// base 에 합쳐진 기록은 책 본문에서 빼고 목록에 '기본 정리 통합' 으로 표시한다.
function markMerged(targets) {
  for (const name of targets) {
    const entry = path.join(NOTES, name, "entry.md");
    if (!fs.existsSync(entry)) continue;
    const text = fs.readFileSync(entry, "utf8");
    if (/^merged:\s*true$/m.test(text)) continue;
    const stamped = /^created:.*$/m.test(text)
      ? text.replace(/^(created:.*)$/m, "$1\nmerged: true")
      : text.replace(/^---\n/, "---\nmerged: true\n");
    fs.writeFileSync(entry, stamped, "utf8");
    log(`병합 표시: notes/${name}`);
  }
}

function quote(value) {
  return `"${String(value).replace(/"/g, "")}"`;
}

// base 는 docx 를 옮긴 '기본 교재'다. 오늘 다듬은 기록을 base 의 해당 소제목 아래에
// 덧붙이게 하고, 기존 줄이 하나라도 지워지면 되돌린다(덧붙이기 전용).
// 매일 다른 대단원 하나씩 — 아직 평평한 소단원을 계층 정리 우선순위로 넘긴다.
function hierarchyFocus() {
  const audit = run("python", ["-3", "scripts/hierarchy_audit.py", "--print"]);
  if (!audit.ok) return ["# (점검 보고서를 만들지 못함)"];
  const row = audit.out.split("\n").find((line) => /^\| \d/.test(line));
  if (!row) return ["# 남은 평평한 소단원 없음"];
  const [, score, division, section] = row.split("|").map((cell) => cell.trim());
  const file = fs.readdirSync(BASE).find((name) => name.endsWith(".md") && name.startsWith(division));
  return [`# ${file || division + ".md"} — '${section}' (평평도 ${score})`, `base/${file || division + ".md"}`];
}

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
      "# base/*.md 는 시험 기본 교재다. 오늘 기록의 내용을 **이미 있는 소단원 안으로 합쳐 넣는다**.",
      "# 규칙:",
      "#  - 같은 주제가 이미 있으면 그 소단원의 흐름에 맞춰 문장을 합치고, 중복은 하나로 정리한다.",
      "#  - 새 사실은 관련 위치(같은 주제의 불릿 사이)에 넣는다. 파일·단원 끝에 몰아 붙이지 않는다.",
      "#  - 성격이 다른 내용이 섞이면 소단원을 나눈다(STYLE.md 의 재분류 원칙).",
      "#  - 불릿이 평평하게 늘어선 곳은 소단원(###)으로 승격한다. 병명·검사·분류가 기준이다.",
      "#    예: '- 산후 갑상선염: 출산 후 1년 이내' 처럼 병명이 불릿 머리에 있으면 소단원으로 올리고,",
      "#        그 뒤 설명을 그 소단원의 첫 불릿으로 옮긴다. 판단은 임상 지식으로 하되 구조만 바꾼다.",
      "#  - 의미가 같으면 문장을 다듬어도 된다(더 짧고 부드럽게). 단 수치·약물명·검사명·항목은 빼지 않는다.",
      "#  - 맞는 소단원이 없을 때만 해당 위치에 '### <소단원>' 을 새로 만든다.",
      ...baseFiles.map((name) => `base/${name}`),
      "",
      "# 이번 회차 계층 우선순위",
      ...hierarchyFocus(),
      "",
      "# 오늘 처리한 기록",
      ...targets.map((name) => `notes/${name}/polished.md`),
      "",
    ].join("\n"),
    "utf8",
  );

  const prompt =
    "이 저장소 루트의 STYLE.md 와 .base-queue.txt 를 읽고 그 지시대로 작업해라. " +
    "base/*.md 는 시험 기본 교재다. 오늘 다듬은 기록의 내용을 해당 대단원 파일에서 **이미 그 주제를 다루는 소단원 안으로 합쳐라**. " +
    "같은 사실이 있으면 문장을 다듬어 하나로 만들고, 새 사실은 그 주제의 불릿 사이에 넣는다. " +
    "불릿이 평평하게 늘어선 곳은 병명·검사·분류 단위로 소단원(###)을 만들어 올려라. " +
    "계층을 맞추는 데만 임상 지식을 쓰고, 수치·약물명·검사명은 그대로 둬라. 같은 의미의 문장을 더 짧게 다듬는 것은 괜찮다. " +
    "치료가 단계로 나뉘면(급성기 치료, 리듬 조절, 뇌졸중 예방 …) 그 라벨을 상위 불릿으로 두고 세부 항목을 들여써라. " +
    ".base-queue.txt 의 '계층 우선순위' 섹션이 있으면 그 소단원부터 계층을 정리하라. " +
    "단원이나 파일 끝에 새 블록처럼 붙이지 마라. 성격이 다른 내용이 섞여 있으면 소단원을 나눠라. " +
    "사실·수치·약물명·족보 표시(￥)는 지우지 마라. git 명령은 실행하지 마라. " +
    "완료하면 수정한 base 파일 경로만 한 줄씩 출력해라.";

  const command =
    `cmdc.cmd -p ${quote(prompt)}` +
    ` --model ${quote(MODEL)} --effort ${quote(EFFORT)}` +
    ` --permission-mode accept-edits --trust --skip-onboarding --no-auto-update` +
    ` --output-format text`;

  log("base 병합 에이전트 실행 중…");
  const agent = spawnSync(command, {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    timeout: AGENT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  log(`base 에이전트 종료 (status=${agent.status})`);

  // 병합은 문장을 고치므로 '삭제 0' 대신 '내용이 크게 줄지 않았는지' 로 본다.
  const diff = run("git", ["diff", "--numstat", "--", "base"]);
  const rows = diff.out
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 3);
  const shrunk = rows.filter((cols) => {
    const removed = Number(cols[1]);
    const added = Number(cols[0]);
    return removed > 0 && added < removed * 0.6;
  });

  if (!diff.out.trim()) {
    log("base 변경 없음");
  } else if (shrunk.length) {
    log(`base 내용이 크게 줄었다 → 되돌림: ${shrunk.map((c) => c[2]).join(", ")}`);
    run("git", ["checkout", "--", "base"]);
  } else {
    const content = run("python", ["-3", "scripts/check_content.py", "--changed", "--quiet"]);
    if (!content.ok) {
      const bad = run("git", ["diff", "--name-only", "--", "base"]).out.split("\n").filter(Boolean);
      log(`내용 유실 감지 → 되돌림: ${bad.join(", ")}`);
      run("git", ["checkout", "--", "base"]);
    } else {
      log(`base 병합: ${rows.length}개 파일 (내용 보존 확인)`);
      markMerged(targets);
    }
  }

  fs.rmSync(BASE_QUEUE, { force: true });
}

function polishedUnmerged() {
  if (!fs.existsSync(NOTES)) return [];
  return fs
    .readdirSync(NOTES)
    .filter((name) => fs.existsSync(path.join(NOTES, name, "polished.md")))
    .filter((name) => String(readFrontMatter(path.join(NOTES, name, "entry.md")).merged).toLowerCase() !== "true")
    .sort();
}

function commitAndPush(message) {
  run("git", ["add", "base", "notes"]);
  const staged = run("git", ["diff", "--cached", "--name-only"]);
  if (!staged.out) {
    log("변경 사항 없음. 종료.");
    return;
  }
  const commit = run("git", ["commit", "-m", message]);
  if (!commit.ok) {
    log(`커밋 실패: ${commit.out}`);
    process.exit(1);
  }
  log(`${staged.out.split("\n").length}개 파일 변경`);
  const push = run("git", ["push"]);
  log(push.ok ? "push 완료 → Action이 Pages에 배포" : `push 실패: ${push.out}`);
  const mergedCount = (() => {
    try {
      return fs
        .readdirSync(NOTES)
        .filter((name) => String(readFrontMatter(path.join(NOTES, name, "entry.md")).merged).toLowerCase() === "true")
        .length;
    } catch {
      return 0;
    }
  })();
  notify(
    push.ok
      ? `fm_board_enhance 04:00 작업 완료 — 위계 정리 ${hierarchyReport}건 · 기록 ${targets.length}건 병합(누적 ${mergedCount}) · 사이트·PDF 갱신`
      : `fm_board_enhance 04:00 작업 실패 — push 거부: ${push.out.slice(0, 120)}`,
  );
}

function main() {
  let hierarchyReport = 0;

  if (process.argv.includes("--merge-only")) {
    log("=== base 병합만 실행 ===");
    const targets = polishedUnmerged();
    if (!targets.length) {
      log("병합할 기록 없음. 종료.");
      return;
    }
    log(`대상 ${targets.length}건: ${targets.join(", ")}`);
    syncBase(targets);

    const build = runNode("scripts/build.mjs", ["--no-pdf"]);
    if (!build.ok) {
      log(`빌드 실패 → 커밋하지 않고 중단:\n${build.out}`);
      process.exit(1);
    }
    commitAndPush(`merge: ${targets.length} note(s) into base`);
    return;
  }

  log("=== daily triage 시작 ===");
  log(`model=${MODEL} effort=${EFFORT}`);

  const pull = run("git", ["pull", "--ff-only"]);
  if (!pull.ok) {
    log(`git pull 실패, 중단: ${pull.out}`);
    process.exit(1);
  }
  const upToDate = pull.out.includes("Already up to date");
  log(upToDate ? "pull: 원격에 새 커밋 없음" : "pull: 갱신됨");

  const targets = pendingNotes();
  if (upToDate && !targets.length) {
    // 원격도 그대로, 다듬을 기록도 없으면 아무것도 만들지 않는다(LLM·빌드 비용 0)
    log("변경 없음 → 스킬 로드·빌드 없이 종료.");
    return;
  }
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
    "이 저장소 루트의 TRIAGE.md 와 STYLE.md 를 읽고 그 규칙대로 작업해라. " +
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

  // ① 위계 점검 먼저 — 규칙 승격 → 기호 조판 → LLM 계층 정리
  const hierarchy = run("python", ["-3", "scripts/normalize_hierarchy.py"]);
  if (hierarchy.ok) log(hierarchy.out.split("\n").slice(-2).join(" "));

  const symbols = run("python", ["-3", "scripts/typeset_symbols.py"]);
  if (symbols.ok) log(symbols.out.split("\n").slice(-1).join(""));

  const hierarchyLlm = runNode("scripts/hierarchy_llm.mjs", ["--limit", "3"]);
  if (hierarchyLlm.out) log(hierarchyLlm.out.split("\n").slice(-3).join(" "));
  hierarchyReport = (hierarchyLlm.out || "").split("\n").filter((line) => line.includes("✓")).length;

  // ② 그다음 기록 병합
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
  const mergedCount = (() => {
    try {
      return fs
        .readdirSync(NOTES)
        .filter((name) => String(readFrontMatter(path.join(NOTES, name, "entry.md")).merged).toLowerCase() === "true")
        .length;
    } catch {
      return 0;
    }
  })();
  notify(
    push.ok
      ? `fm_board_enhance 04:00 작업 완료 — 위계 정리 ${hierarchyReport}건 · 기록 ${targets.length}건 병합(누적 ${mergedCount}) · 사이트·PDF 갱신`
      : `fm_board_enhance 04:00 작업 실패 — push 거부: ${push.out.slice(0, 120)}`,
  );
  log("=== daily triage 끝 ===");
}

main();
