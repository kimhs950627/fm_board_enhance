#!/usr/bin/env node
/**
 * llm.mjs — Command Code Provider API 로 텍스트를 받아 온다. (cmdc CLI 불필요)
 *
 *   echo "질문" | node scripts/llm.mjs
 *   node scripts/llm.mjs --prompt "질문" [--model deepseek/deepseek-v4.1-flash] [--effort low]
 *
 * 키: COMMANDCODE_API_KEY (Studio > API keys). 없으면 조용히 실패한다.
 * 엔드포인트: https://api.commandcode.ai/provider/v1/chat/completions (OpenAI 호환)
 */

const ENDPOINT = process.env.CM_API_URL || "https://api.commandcode.ai/provider/v1/chat/completions";
const KEY = process.env.COMMANDCODE_API_KEY || "";
const DEFAULT_MODEL = process.env.FM_MODEL || "deepseek/deepseek-v4.1-flash";
const DEFAULT_EFFORT = process.env.FM_EFFORT || "low";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const ALLOWED_MODEL = /deepseek-v4\.1-flash/;

export async function complete(prompt, { model = DEFAULT_MODEL, effort = DEFAULT_EFFORT, maxTokens = 12000, temperature = 0 } = {}) {
  if (!KEY) throw new Error("COMMANDCODE_API_KEY 가 없다");
  // 이 프로젝트는 deepseek-v4.1-flash · low 만 쓴다(다른 모델 호출 금지)
  if (!ALLOWED_MODEL.test(model) && process.env.FM_ALLOW_OTHER !== "1") {
    throw new Error(`허용되지 않은 모델: ${model} (deepseek-v4.1-flash 만 사용)`);
  }
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
      reasoning_effort: effort,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`API ${response.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  // 추론 토큰이 max_tokens 를 먹어 본문이 비는 경우가 있다 → 한 번 더 넉넉히 재시도
  if (!content && choice?.finish_reason === "length") {
    const retry = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens * 2,
        temperature,
        reasoning_effort: effort,
      }),
    });
    const again = JSON.parse(await retry.text());
    const second = again?.choices?.[0]?.message?.content;
    if (second) return second.trim();
  }
  if (!content) throw new Error(`응답이 비었다 (finish=${choice?.finish_reason})`);
  return content.trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prompt = arg("prompt", "") || (await readStdin());
  if (!prompt.trim()) {
    console.error("프롬프트가 없다. --prompt 또는 stdin");
    process.exit(2);
  }
  try {
    const out = await complete(prompt, { model: arg("model", DEFAULT_MODEL), effort: arg("effort", DEFAULT_EFFORT) });
    console.log(out);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
