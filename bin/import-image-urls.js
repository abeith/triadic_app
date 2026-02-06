#!/usr/bin/env node
// Import images from a URL list into public/images, removing processed/bad URLs.
// Usage: node bin/import-image-urls.js [--file path] [--dir path]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const IMAGE_EXT_RE = /\.(jpg|jpeg|png)$/i;
const CONTENT_TYPE_MAP = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
};

function parseArgs(argv) {
  const args = { file: null, dir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file") args.file = argv[i + 1] ?? null;
    if (a === "--dir") args.dir = argv[i + 1] ?? null;
  }
  return args;
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function pickExt(url, contentType) {
  const extFromUrl = path.extname(new URL(url).pathname);
  if (IMAGE_EXT_RE.test(extFromUrl)) return extFromUrl.toLowerCase();
  if (contentType && CONTENT_TYPE_MAP[contentType.toLowerCase()]) {
    return CONTENT_TYPE_MAP[contentType.toLowerCase()];
  }
  return null;
}

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "";
  const ext = pickExt(url, contentType);
  if (!ext) throw new Error("Unsupported content type");
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, ext };
}

const args = parseArgs(process.argv.slice(2));
const listFile = args.file || path.join(process.cwd(), ".imageurls");
const outDir = args.dir || path.join(process.cwd(), "public", "images");

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const lines = readLines(listFile);
if (!lines.length) {
  console.log("No URLs found.");
  process.exit(0);
}

const kept = [];
for (const url of lines) {
  try {
    const { buffer, ext } = await fetchImage(url);
    const stamp = Date.now();
    const rand = Math.floor(Math.random() * 1e6)
      .toString()
      .padStart(6, "0");
    const filename = `import_${stamp}_${rand}${ext}`;
    const outPath = path.join(outDir, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`Imported ${url} -> ${filename}`);
  } catch (err) {
    console.warn(`Skipped ${url} (${err?.message ?? err})`);
    // Drop invalid URLs from the list as requested.
    continue;
  }
}

// Rewrite list file with only unprocessed entries (none, by design).
fs.writeFileSync(listFile, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
