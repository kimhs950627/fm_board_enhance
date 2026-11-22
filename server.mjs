#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname);
const NOTES = path.join(ROOT, "notes");
const APP = path.join(ROOT, "app");
const PORT = Number(process.env.PORT || 4173);
const APP_TOKEN = process.env.APP_TOKEN || "";
const COOKIE = "fm_key";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function newId(now = new Date()) {
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function readEntryFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const data = {};
  if (!match) return { data, body: text };
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) data[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(match[0].length) };
}

function parseCategories(data) {
  const raw = data.categories || data.category || "";
  return [...new Set(raw.split(",").map((c) => c.trim()).filter(Boolean))];
}

function listNotes() {
  if (!fs.existsSync(NOTES)) return [];
  const notes = [];
  for (const name of fs.readdirSync(NOTES)) {
    const dir = path.join(NOTES, name);
    const file = path.join(dir, "entry.md");
    if (!fs.existsSync(file)) continue;

    const { data, body } = readEntryFrontMatter(fs.readFileSync(file, "utf8"));
    const images = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f)).length;
    notes.push({
      id: data.id || name,
      title: data.title || "(제목 없음)",
      categories: parseCategories(data),
      created: data.created || "",
      images,
      excerpt: body
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/[#>*_\[\]{}]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 70),
    });
  }
  return notes.sort((a, b) => (b.created || "").localeCompare(a.created || ""));
}

function saveNote(payload) {
  const now = new Date();
  const id = newId(now);
  const dir = path.join(NOTES, id);
  fs.mkdirSync(dir, { recursive: true });

  const images = Array.isArray(payload.images) ? payload.images : [];
  for (const image of images) {
    const safe = path.basename(String(image.name || ""));
    const comma = String(image.dataUrl || "").indexOf(",");
    if (!/^[\w.-]+$/.test(safe) || comma < 0) continue;
    fs.writeFileSync(path.join(dir, safe), Buffer.from(String(image.dataUrl).slice(comma + 1), "base64"));
  }

  const created =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const title = String(payload.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const categories = [
    ...new Set(
      (Array.isArray(payload.categories) ? payload.categories : String(payload.category || "").split(","))
        .map((c) => String(c).replace(/[\r\n]/g, " ").trim())
        .filter(Boolean),
    ),
  ];

  const front = [
    "---",
    `id: ${id}`,
    `title: ${title || "(제목 없음)"}`,
    `created: ${created}`,
    `categories: ${categories.join(", ")}`,
    "---",
    "",
  ].join("\n");

  fs.writeFileSync(path.join(dir, "entry.md"), front + String(payload.markdown || "") + "\n", "utf8");
  return { id, dir };
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function hasKey(req) {
  if (!APP_TOKEN) return true;
  const cookies = req.headers.cookie || "";
  return cookies.split(";").some((part) => part.trim() === `${COOKIE}=${APP_TOKEN}`);
}

function readJson(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("요청이 너무 큽니다"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function runBuild() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "build.mjs")], { cwd: ROOT });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ ok: code === 0, output: out.trim() }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const extra = {};
  if (!hasKey(req)) {
    if (url.searchParams.get("k") === APP_TOKEN) {
      extra["Set-Cookie"] = `${COOKIE}=${APP_TOKEN}; Path=/; HttpOnly; Max-Age=31536000; SameSite=Lax`;
    } else {
      return send(res, 401, "text/plain; charset=utf-8", "비밀 링크(?k=...)가 필요합니다.");
    }
  }

  try {
    if (url.pathname === "/api/notes" && req.method === "GET") {
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(listNotes()), extra);
    }

    if (url.pathname === "/api/notes" && req.method === "POST") {
      const payload = await readJson(req);
      const saved = saveNote(payload);
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, ...saved }), extra);
    }

    if (url.pathname === "/api/build" && req.method === "POST") {
      const result = await runBuild();
      return send(res, 200, "application/json; charset=utf-8", JSON.stringify(result), extra);
    }

    if (url.pathname.startsWith("/notes/")) {
      const rel = decodeURIComponent(url.pathname.slice("/notes/".length));
      const file = path.resolve(NOTES, rel);
      const inside = file === NOTES || file.startsWith(NOTES + path.sep);
      if (inside && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
        return send(res, 200, type, fs.readFileSync(file), extra);
      }
      return send(res, 404, "text/plain; charset=utf-8", "not found", extra);
    }

    const page = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(APP, path.basename(page));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
      return send(res, 200, type, fs.readFileSync(file), extra);
    }

    return send(res, 404, "text/plain; charset=utf-8", "not found", extra);
  } catch (error) {
    send(res, 500, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: error.message }), extra);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`입력 앱: http://127.0.0.1:${PORT}`);
  if (process.argv.includes("--open")) {
    spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${PORT}`], { detached: true, stdio: "ignore" }).unref();
  }
});
