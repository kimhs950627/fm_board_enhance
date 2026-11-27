#!/usr/bin/env node
/**
 * group_hierarchy.mjs — 본문 없는 ### 을 중분류(##)로 세우고 자식을 그 아래로 내린다.
 *
 * 모델은 제목 목록만 보고 "어느 빈 제목이 부모이고, 어디까지가 그 범위인지(마지막 자식 제목)"만 정한다.
 * 실제 레벨 계산과 파일 수정은 이 스크립트가 결정적으로 한다 — 글자는 건드리지 않고 '#' 개수만 바꾼다.
 * 파일마다 단어 목록을 대조해 다르면 그 파일은 되돌린다.
 *
 *   node scripts/group_hierarchy.mjs            # 제안만 출력 (기본)
 *   node scripts/group_hierarchy.mjs --apply    # 적용
 *   node scripts/group_hierarchy.mjs --file base/내분비.md
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { complete } from "./llm.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BASE = path.join(ROOT, "base");
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const apply = argv.includes("--apply");
const onlyFile = arg("file", "");
const retry = Number(arg("retry", "1")) || 1;

const HEAD = /^(#{2,6})\s+(.*\S)\s*$/;
const SHELL = new Set(["기타", "총론", "서두"]);

function headingsOf(text) {
  const lines = text.split("\n");
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = HEAD.exec(lines[i]);
    if (m) heads.push({ index: i, level: m[1].length, title: m[2].trim() });
  }
  for (let k = 0; k < heads.length; k += 1) {
    const end = k + 1 < heads.length ? heads[k + 1].index : lines.length;
    heads[k].body = lines.slice(heads[k].index + 1, end).filter((l) => l.trim()).length;
    heads[k].pos = k;
  }
  return { lines, heads };
}

function tokens(text) {
  return text
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*]|\d+\))\s*/gm, "")
    .replace(/\*\*/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

function promptFor(file, heads) {
  const list = heads
    .map((h) => `${"#".repeat(h.level)} ${h.title}${h.body === 0 && !heads[h.pos + 1] ? "  [본문없음]" : h.body === 0 ? "  [본문없음]" : ""}`)
    .join("\n");

  return [
    "한국어 의학 교재의 목차다. `[본문없음]` 은 그 제목 아래에 본문 없이 바로 다음 제목들이 이어진다는 뜻이고,",
    "대개 아래 항목들의 묶음 제목(중분류)이다.",
    "",
    "할 일: `[본문없음]` 제목을 부모로 세우고, 그 범위가 어디까지인지 정해라.",
    "",
    "규칙",
    "1) 범위는 부모 다음 제목부터 `until` 제목까지다(둘 다 포함).",
    "2) `until` 은 같은 묶음에 속하는 **마지막 항목**의 제목을 그대로 쓴다. 다른 묶음 제목은 범위에 넣지 마라.",
    "3) 자식이 1개여도 부모로 남겨라. 제목의 맥락을 잃으면 안 된다.",
    "4) 중첩은 반드시 하라. `[본문없음]` 바로 다음이 또 `[본문없음]` 이면 바깥이 바깥 부모다.",
    "   예: '당뇨' ⊃ ('당뇨병 진단' ⊃ ①·②·③·④, '당뇨병 치료' ⊃ Metformin·…).",
    "   이때 groups 에 두 줄을 넣는다 — {parent:'당뇨', until:'당뇨병의 합병증: 만성 합병증'},",
    "   {parent:'당뇨병 진단', until:'④ 무작위 혈당 …'}.",
    "5) 의미가 없는 껍데기만 drop 에 넣어라 — '기타', '총론' 처럼 분류 이름뿐인 것.",
    "6) 의미상 남의 하위 항목인 것(예: 골다공증 아래의 이상지질혈증)은 넣지 마라. 확신이 없으면 빼라.",
    "",
    "출력은 JSON 만. 설명·코드펜스 금지.",
    '{"groups":[{"parent":"부모 제목","until":"마지막 자식 제목"}],"drop":["껍데기 제목"]}',
    "",
    `파일: base/${file}`,
    "",
    list,
  ].join("\n");
}

function parseJson(text) {
  const clean = text.replace(/^```(?:json)?\n/, "").replace(/\n```$/, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("JSON 없음");
  return JSON.parse(clean.slice(start, end + 1));
}

/** 부모 범위(p..u)를 확정한다. 겹치면 안쪽이 더 깊은 계층이 된다. */
function resolveGroups(heads, proposal) {
  const pos = new Map();
  for (const h of heads) if (!pos.has(h.title)) pos.set(h.title, h.pos);
  const problems = [];
  const groups = [];

  for (const g of proposal.groups || []) {
    const p = pos.get(String(g.parent || "").trim());
    const u = pos.get(String(g.until || "").trim());
    if (p === undefined) { problems.push(`부모 없음: ${g.parent}`); continue; }
    if (u === undefined) { problems.push(`until 없음: ${g.until}`); continue; }
    if (heads[p].body !== 0) { problems.push(`본문 있는 제목: ${g.parent}`); continue; }
    // 기존 ## 는 이미 중분류다. ### 만 새 부모 후보로 삼는다.
    if (heads[p].level !== 3) { problems.push(`### 아님: ${g.parent}`); continue; }
    // '기타'·'총론' 같은 껍데기는 부모로 세우지 않는다
    if (SHELL.has(heads[p].title)) { problems.push(`껍데기 부모: ${g.parent}`); continue; }
    if (u <= p) { problems.push(`범위 역전: ${g.parent}`); continue; }
    groups.push({ p, u, title: heads[p].title, explicit: true });
  }

  // 같은 부모 중복 제거
  const seen = new Set();
  const unique = groups.filter((g) => {
    const key = `${g.p}:${g.u}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // [본문없음] 바로 다음이 또 부모면 바깥 제목도 부모다 — 예: '당뇨' ⊃ '당뇨병 진단' ⊃ ①②③④.
  // 바깥 부모는 '연속한 형제 부모들'을 모두 흡수한다.
  const parentStarts = new Set(unique.map((g) => g.p));
  for (let pass = 0; pass < 5; pass += 1) {
    let added = false;
    for (const h of heads) {
      if (h.level !== 3 || h.body !== 0) continue;
      if (parentStarts.has(h.pos)) continue;
      if (!unique.some((g) => g.p === h.pos + 1)) continue;
      // 지금까지 확인된 모든 부모 범위를 흡수해 끝을 정한다
      let maxU = h.pos;
      for (let changed = true; changed; ) {
        changed = false;
        for (const o of unique) {
          if (o.p > h.pos && o.p <= maxU + 1 && (o.origU ?? o.u) > maxU) {
            maxU = o.origU ?? o.u;
            changed = true;
          }
        }
      }
      unique.push({ p: h.pos, u: maxU, title: h.title, explicit: true });
      parentStarts.add(h.pos);
      added = true;
    }
    if (!added) break;
  }

  // 범위 겹침 정리. 앞선 부모가 뒤 부모의 시작에서 끊긴다.
  unique.sort((a, b) => a.p - b.p || b.u - a.u);
  const trimmed = [];
  for (const g of unique) {
    const cur = { p: g.p, u: g.u, origU: g.u, title: g.title, parent: null };
    for (let i = trimmed.length - 1; i >= 0; i -= 1) {
      const anc = trimmed[i];
      if (!(anc.p < cur.p && cur.p <= anc.origU)) continue;
      if (cur.origU <= anc.origU) {
        // 완전히 품긴다 → 자식으로 중첩. 부모 범위는 그대로 두고 자식은 자기 범위만 표시한다.
        cur.parent = anc;
      } else {
        // 일부만 걸친다 → 형제다. 부모 범위를 내 시작 앞에서 끊는다
        anc.u = Math.min(anc.u, cur.p - 1);
      }
      break;
    }
    trimmed.push(cur);
  }
  // 범위가 비어 버린 부모는 원래 범위를 되살린다(자식이 있어도 제목은 남긴다)
  for (const g of trimmed) if (g.u <= g.p && g.origU > g.p) g.u = g.p;
  const valid = trimmed.filter((g) => g.u > g.p);

  const shellDrop = [];
  const owner = new Map();
  for (const h of heads) owner.set(h.pos, null);
  for (let i = 0; i < trimmed.length; i += 1) {
    const g = trimmed[i];
    for (let k = g.p + 1; k <= g.u; k += 1) if (!owner.get(k)) owner.set(k, i);
  }
  // 껍데기 제목은 자식이 있어도 지운다 — 자식은 상위 레벨로 올라간다.
  for (const h of heads) {
    if (h.level !== 3 || h.body !== 0 || !SHELL.has(h.title)) continue;
    shellDrop.push(h.title);
  }
  return { groups: trimmed.filter((g) => g.u > g.p), problems, drop: [...new Set(shellDrop)] };
}

/** 기존 ## 섹션(암묵 부모) 범위. 소화기의 '위장관'·'간' 처럼 이미 중분류가 있는 경우. */
function implicitParents(heads) {
  const out = [];
  for (let i = 0; i < heads.length; i += 1) {
    if (heads[i].level !== 2) continue;
    let end = heads.length - 1;
    for (let k = i + 1; k < heads.length; k += 1) {
      if (heads[k].level <= 2) { end = k - 1; break; }
    }
    out.push({ p: heads[i].pos, u: end });
  }
  return out;
}

/** 부모 깊이 = 자기를 품은 다른 부모(새 부모 + 기존 ##) 수 + 1 */
function levelMap(groups, heads, drop = []) {
  const implicit = implicitParents(heads).filter((imp) => !drop.includes(heads[imp.p].title));
  const depth = new Map();
  for (const g of groups) {
    let d = 1;
    let anc = g.parent;
    while (anc) {
      if (!drop.includes(anc.title)) d += 1;
      anc = anc.parent;
    }
    for (const imp of implicit) {
      if (imp.p < g.p && g.p <= imp.u) d += 1;
    }
    depth.set(g.p, d);
  }
  return { depth, implicit };
}

function applyTo(lines, heads, groups, drop) {
  const droppos = new Set(heads.filter((h) => h.level === 3 && h.body === 0 && drop.includes(h.title)).map((h) => h.pos));
  const { depth, implicit } = levelMap(groups, heads, drop);
  const newLevel = new Map();
  for (const [p, d] of depth) newLevel.set(p, Math.min(6, d + 1));

  // 자식 레벨 = 그 자식을 품은 가장 안쪽 부모(새 부모 또는 기존 ##) 레벨 + 1
  for (const h of heads) {
    if (newLevel.has(h.pos)) continue;
    let innerDepth = 0;
    for (const g of groups) {
      if (g.p < h.pos && h.pos <= g.origU) {
        const d = depth.get(g.p) || 1;
        if (d > innerDepth) innerDepth = d;
      }
    }
    if (!innerDepth) {
      for (const imp of implicit) {
        if (imp.p < h.pos && h.pos <= imp.u) { innerDepth = 1; break; }
      }
    }
    if (innerDepth) newLevel.set(h.pos, Math.min(6, innerDepth + 2));
  }

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = heads.find((h) => h.index === i);
    if (!head) { out.push(lines[i]); continue; }
    if (droppos.has(head.pos)) continue;
    // 이미 부모가 없는 #### 이하는 그대로 둔다(기존 계층 보존)
    const level = newLevel.get(head.pos);
    out.push(level ? `${"#".repeat(level)} ${head.title}` : lines[i]);
  }
  return out.join("\n");
}

function tidy(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (HEAD.test(line)) {
      while (out.length && !out[out.length - 1].trim()) out.pop();
      if (out.length && out[out.length - 1] !== "---") out.push("");
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

async function planFor(file) {
  const text = fs.readFileSync(path.join(BASE, file), "utf8");
  const { lines, heads } = headingsOf(text);
  const empties = heads.filter((h) => h.level === 3 && h.body === 0);
  if (!empties.length) return null;

  for (let attempt = 0; attempt <= retry; attempt += 1) {
    try {
      const answer = await complete(promptFor(file, heads), { maxTokens: 12000 });
      const proposal = parseJson(answer);
      const { groups, problems, drop } = resolveGroups(heads, proposal);
      return { text, lines, heads, groups, problems, drop };
    } catch (error) {
      if (attempt === retry) return { error: error.message.slice(0, 80) };
    }
  }
  return null;
}

async function main() {
  const files = fs
    .readdirSync(BASE)
    .filter((n) => n.endsWith(".md"))
    .filter((n) => !onlyFile || `base/${n}` === onlyFile)
    .sort();

  let totalGroups = 0;
  let totalDrop = 0;
  let totalFiles = 0;

  for (const file of files) {
    const plan = await planFor(file);
    if (!plan) continue;
    if (plan.error) { console.log(`! ${file}: ${plan.error}`); continue; }
    const { text, lines, heads, groups, problems, drop } = plan;
    if (!groups.length && !drop.length) {
      console.log(`- ${file}: 묶을 묶음 없음`);
      continue;
    }

    const updated = tidy(applyTo(lines, heads, groups, drop));
    const before = tokens(text);
    const expected = before.slice();
    for (const t of drop) {
      for (const w of t.split(/\s+/).filter(Boolean)) {
        const at = expected.indexOf(w);
        if (at !== -1) expected.splice(at, 1);
      }
    }
    const after = tokens(updated);
    if (after.length !== expected.length || after.some((w, i) => w !== expected[i])) {
      console.log(`! ${file}: 글자가 달라져 건너뜀`);
      continue;
    }

    console.log(`## ${file}`);
    const { depth } = levelMap(groups, heads, drop);
    for (const g of groups) {
      const n = g.u - g.p;
      const hashes = "#".repeat(Math.min(6, (depth.get(g.p) || 1) + 1));
      console.log(`  ${hashes} ${g.title}  ⊃  ${n}개 (… ${heads[g.origU]?.title.slice(0, 28) ?? "?"})`);
    }
    for (const t of drop) console.log(`  - 껍데기 제거: ${t}`);
    if (problems.length) console.log(`  (제외 ${problems.length}: ${problems.slice(0, 3).join("; ")})`);
    totalGroups += groups.length;
    totalDrop += drop.length;
    totalFiles += 1;

    if (apply) {
      fs.writeFileSync(path.join(BASE, file), updated, "utf8");
      const check = spawnSync("python3", ["scripts/check_content.py", `base/${file}`, "--quiet", "--ignore-titles"], { cwd: ROOT, encoding: "utf8" });
      if (check.status !== 0) {
        fs.writeFileSync(path.join(BASE, file), text, "utf8");
        console.log("  ! 내용 검사 실패 → 되돌림");
      }
    }
  }

  console.log(`\n${totalFiles}개 파일 · 묶음 ${totalGroups}개 · 껍데기 ${totalDrop}개${apply ? " 적용" : " (--apply 로 적용)"}`);
}

main();
