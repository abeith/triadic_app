#!/usr/bin/env node
// Export runtime data to a tar.gz archive.
// Usage: node bin/export-runtime.js [--out path]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[i + 1] ?? null;
  }
  return args;
}

function safeStamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

const args = parseArgs(process.argv.slice(2));
const root = process.cwd();
const exportDir = path.join(root, "runtime_exports");
const outPath = args.out || path.join(exportDir, `runtime_${safeStamp()}.tgz`);

const candidates = [
  "state",
  "data",
  "print",
  path.join("public", "images"),
  ".env",
  ".printignore",
];

const existing = candidates.filter((p) => fs.existsSync(path.join(root, p)));
if (!existing.length) {
  console.error("No runtime paths found to export.");
  process.exit(1);
}

fs.mkdirSync(exportDir, { recursive: true });

const argsTar = ["-czf", outPath, ...existing];
const res = spawnSync("tar", argsTar, { cwd: root, stdio: "inherit" });
if (res.status !== 0) {
  process.exit(res.status ?? 1);
}

console.log(`Exported runtime data to ${outPath}`);
