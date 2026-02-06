#!/usr/bin/env node
// Import runtime data from a tar.gz archive.
// Usage: node bin/import-runtime.js --file path

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = { file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--file") args.file = argv[i + 1] ?? null;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const file = args.file;
if (!file) {
  console.error("Missing --file path to runtime archive.");
  process.exit(1);
}

const absFile = path.resolve(file);
if (!fs.existsSync(absFile)) {
  console.error(`Archive not found: ${absFile}`);
  process.exit(1);
}

const root = process.cwd();
const res = spawnSync("tar", ["-xzf", absFile, "-C", root], {
  stdio: "inherit",
});
if (res.status !== 0) {
  process.exit(res.status ?? 1);
}

console.log(`Imported runtime data from ${absFile}`);
