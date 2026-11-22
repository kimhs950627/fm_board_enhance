#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT || 4173);
const TOKEN = crypto.randomBytes(6).toString("hex");

const CLOUDFLARED_CANDIDATES = [
  process.env.CLOUDFLARED_PATH,
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
  "cloudflared",
].filter(Boolean);

const cloudflared = CLOUDFLARED_CANDIDATES.find(
  (candidate) => !candidate.includes(path.sep) || fs.existsSync(candidate),
);

if (!cloudflared) {
  console.error("cloudflared를 찾지 못했습니다. https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  process.exit(1);
}

console.log("로컬 서버 시작…");
const server = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), APP_TOKEN: TOKEN },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (data) => process.stdout.write(`  ${data}`));
server.stderr.on("data", (data) => process.stderr.write(`  ${data}`));

console.log("클라우드 터널 연결 중… (10~20초)");
const tunnel = spawn(cloudflared, ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"], {
  stdio: ["ignore", "pipe", "pipe"],
});

let printed = false;
const onTunnelOutput = (chunk) => {
  const text = chunk.toString();
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);

  if (!printed && match) {
    printed = true;
    const publicUrl = `${match[0]}/?k=${TOKEN}`;
    console.log("");
    console.log("  ────────────────────────────────────────────");
    console.log(`  외부 접속 주소 (휴대폰/다른 PC):`);
    console.log(`  ${publicUrl}`);
    console.log("  ────────────────────────────────────────────");
    console.log("  같은 와이파이에서만 쓸 때: http://127.0.0.1:" + PORT);
    console.log("  Ctrl+C 로 종료");
    console.log("");
  }
  if (!printed) process.stderr.write(text);
};

tunnel.stdout.on("data", onTunnelOutput);
tunnel.stderr.on("data", onTunnelOutput);

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  console.log("\n종료 중…");
  server.kill();
  tunnel.kill();
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);
