#!/usr/bin/env node
// Rename all non-matching images to the next 4-digit sequence numbers.
// Usage: node bin/rename-next-image.js [--dir path]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|tif|tiff|bmp)$/i;
const PADDED_RE = /^(\d{4})\.(jpg|jpeg|png|webp|gif|tif|tiff|bmp)$/i;

function parseArgs(argv) {
  const args = { dir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[i + 1] ?? null;
  }
  return args;
}

function nextIndex(files) {
  let max = -1;
  for (const f of files) {
    const m = f.match(PADDED_RE);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return max + 1;
}

const args = parseArgs(process.argv.slice(2));
const dir = args.dir || path.join(process.cwd(), "public", "images");

if (!fs.existsSync(dir)) {
  console.error(`Directory not found: ${dir}`);
  process.exit(1);
}

const entries = fs.readdirSync(dir).filter((f) => IMAGE_EXT_RE.test(f));
entries.sort((a, b) => a.localeCompare(b));

const targets = entries.filter((f) => !PADDED_RE.test(f));
if (!targets.length) {
  console.log("No non-matching images found.");
  process.exit(0);
}

let next = nextIndex(entries);
const renamed = [];

for (const target of targets) {
  const ext = path.extname(target).toLowerCase();
  let newName = `${String(next).padStart(4, "0")}${ext}`;
  let dst = path.join(dir, newName);

  while (fs.existsSync(dst)) {
    next += 1;
    newName = `${String(next).padStart(4, "0")}${ext}`;
    dst = path.join(dir, newName);
  }

  const src = path.join(dir, target);
  fs.renameSync(src, dst);
  renamed.push(`${target} -> ${newName}`);
  next += 1;
}

renamed.forEach((line) => console.log(`Renamed ${line}`));
