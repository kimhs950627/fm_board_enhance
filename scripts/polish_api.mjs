#!/usr/bin/env node
/**
 * polish_api.mjs — 새 기록(entry.md)을 다듬어 polished.md 를 만든다. (API 직접 호출, cmdc 불필요)
 *
 * TRIAGE.md 의 규칙(대단원/소단원 분류 + 문체 정리 + front matter)을 프롬프트에 옮겨 넣고,
 * 모델이 돌려준 마크다운을 notes/<id>/polished.md 로 저장한다.
 * 이미 polished.md 가 있거나 merged: true 인 기록은 건너뛴다.
 *
 *   node scripts/polish_api.mjs [--dry-run] [--id notes/<id>]
 */

import fs from "node:fs";
import path from "node:path";
import { complete } from "./llm.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const NOTES = path.join(ROOT, "notes");
const BASE = path.join(ROOT, "base");
const argv = process.argv.slice(2);
const dry = argv.includes("--dry-run");
const onlyId = argv.includes("--id") ? argv[argv.indexOf("--id") + 1] : "";

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
  return { data, body: text.slice(match ? match[0].length : 0).trim(), raw: text };
}

function pending() {
  if (!fs.existsSync(NOTES)) return [];
  return fs
    .readdirSync(NOTES)
    .filter((id) => !onlyId || `notes/${id}` === onlyId)
    .filter((id) => fs.existsSync(path.join(NOTES, id, "entry.md")))
    .filter((id) => !fs.existsSync(path.join(NOTES, id, "polished.md")))
    .filter((id) => String(frontMatter(path.join(NOTES, id, "entry.md")).data.locked).toLowerCase() !== "true")
    .filter((id) => String(frontMatter(path.join(NOTES, id, "entry.md")).data.merged).toLowerCase() !== "true");
}

/** base/categories.json 에서 대단원·소단원 후보를 뽑아 프롬프트에 넣는다. */
function categoryList() {
  try {
    const categories = JSON.parse(fs.readFileSync(path.join(BASE, "categories.json"), "utf8"));
    return Object.entries(categories)
      .map(([division, parts]) => {
        const topics = [...new Set(Object.values(parts).flat())];
        return `## ${division}\n${topics.map((topic) => `- ${topic}`).join("\n")}`;
      })
      .join("\n");
  } catch {
    return "";
  }
}

function promptFor(entry, categories) {
  return [
    "너는 가정의학과 기출 교재의 편집자다. 아래 기록을 'polished.md' 로 다듬는다.",
    "",
    "할 일",
    "1) 대단원(division)을 고른다. 아래 목록의 이름을 그대로 쓴다.",
    "2) 소단원(topics)을 고른다. 목록 이름과 글자까지 같게, 여러 개면 쉼표로.",
    "   맞는 것이 없으면 가장 가까운 것을 쓰고 새 이름을 하나 만든다.",
    "3) 본문을 시험장에서 읽기 좋게 정리한다: 결론 먼저, 한 문장에 한 가지, 중복 제거.",
    "   수치·단위·약물명·검사명은 그대로 둔다. 원문의 각 불릿은 반드시 대응되는 불릿으로 남긴다(빠뜨리면 실패).",
    "   족보 표시(￥)는 그대로 둔다.",
    "",
    "출력은 아래 형식의 마크다운만. 설명·코드펜스 금지.",
    "---",
    "id: <entry 의 id>",
    "title: <제목>",
    "created: <entry 의 created>",
    "division: <대단원>",
    "topics: <소단원[, 소단원]>",
    "keywords: <핵심어 3~6개, 쉼표>",
    `polished: ${new Date().toISOString().slice(0, 10)}`,
    "---",
    "",
    "<정리한 본문>",
    "",
    "대단원·소단원 목록:",
    categories,
    "",
    "기록:",
    "```markdown",
    entry,
    "```",
  ].join("\n");
}

function stripFence(text) {
  return text.replace(/^```(?:markdown)?\n/, "").replace(/\n```$/, "").trim();
}

/** 문장을 다듬어도 사라지면 안 되는 '내용어'만 남긴다. 목록 번호·흔한 접속사는 검사에서 뺀다. */
const STOP_LATIN = new Set([
  "the", "and", "or", "vs", "with", "without", "from", "to", "in", "of", "a", "an", "is", "are", "be",
  "for", "by", "on", "as", "per", "via", "if", "then", "not", "no", "all", "was", "it", "this", "that",
  "can", "may", "use", "used", "etc", "ie", "eg",
]);
/** 줄 맨 앞의 '1.' '2)' 같은 목록 번호는 내용이 아니라 서식이다. */
function listOrdinals(text) {
  const found = new Set();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)[.)]\s/.exec(line);
    if (match) found.add(match[1]);
  }
  return found;
}

/** `{.underline}` 같은 pandoc 서식 표식은 내용이 아니다 — 비교 전에 걷어낸다. */
function unmarkup(text) {
  return text.replace(/\{\s*\.[A-Za-z-]+\s*\}/g, "").replace(/\*\*/g, "");
}

/** 원문의 수치·영문 고유명이 결과에도 남아 있는지 확인한다(내용 삭제 방지). */
function entityLoss(sourceText, answer) {
  const source = unmarkup(sourceText);
  const ordinals = listOrdinals(source);
  const numbers = (text) => new Set((text.match(/\d+(?:[.,]\d+)?/g) || []));
  const latin = (text) => new Set((text.match(/[A-Za-z][A-Za-z0-9]{1,}/g) || []).map((w) => w.toLowerCase()));
  const answerNumbers = numbers(unmarkup(answer));
  const answerLatin = latin(unmarkup(answer));
  const missingNumbers = [...numbers(source)]
    .filter((token) => !ordinals.has(token))
    .filter((token) => !answerNumbers.has(token));
  const missingLatin = [...latin(source)]
    .filter((token) => !STOP_LATIN.has(token))
    .filter((token) => !answerLatin.has(token));
  return { missingNumbers, missingLatin };
}

async function polishOne(id, categories) {
  const entryPath = path.join(NOTES, id, "entry.md");
  const { raw, body } = frontMatter(entryPath);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = stripFence(await complete(promptFor(raw, categories), { maxTokens: 8000 }));
    if (!answer.startsWith("---")) return { ok: false, reason: "형식 위반" };
    if (!/^division:\s*\S/m.test(answer)) return { ok: false, reason: "division 없음" };

    const answerBody = answer.replace(/^---[\s\S]*?---\s*/, "");
    const loss = entityLoss(body, answerBody);
    if (!loss.missingNumbers.length && !loss.missingLatin.length) {
      fs.writeFileSync(path.join(NOTES, id, "polished.md"), `${answer}\n`, "utf8");
      return { ok: true, reason: "polished.md 생성" };
    }
    if (attempt === 1) {
      return { ok: false, reason: `내용 누락(수치 ${loss.missingNumbers.slice(0, 3).join(",") || "-"} / 고유명 ${loss.missingLatin.slice(0, 3).join(",") || "-"})` };
    }
  }
  return { ok: false, reason: "재시도 실패" };
}

async function main() {
  const ids = pending();
  if (!ids.length) {
    console.log("다듬을 기록이 없다.");
    return;
  }
  for (const id of ids) console.log(`대상: notes/${id}`);
  if (dry) return;

  const categories = categoryList();
  for (const id of ids) {
    try {
      const result = await polishOne(id, categories);
      console.log(`  ${result.ok ? "✓" : "✗"} ${id} — ${result.reason}`);
    } catch (error) {
      console.log(`  ✗ ${id} — ${error.message.slice(0, 140)}`);
    }
  }
  console.log("다듬기 종료");
}

main();
