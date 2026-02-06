#!/usr/bin/env node
// Export SQLite rows to JSON or CSV.
// Usage: node bin/export-db.js [--db path] [--table state|submission] [--format json|csv] [--normalized] [--out path]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  LABEL_NORMALIZATION_VERSION,
  normalizeLabelForAnalysis,
} from "../lib/label-normalize.js";

async function optionalDotenv() {
  try {
    const dotenv = await import("dotenv");
    dotenv.config();
  } catch {
    // Optional.
  }
}

function parseArgs(argv) {
  const args = {
    db: null,
    table: "state",
    format: "json",
    normalized: false,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--db") args.db = argv[i + 1] ?? null;
    if (a === "--table") args.table = (argv[i + 1] ?? "state").toLowerCase();
    if (a === "--format") args.format = (argv[i + 1] ?? "json").toLowerCase();
    if (a === "--normalized") args.normalized = true;
    if (a === "--out") args.out = argv[i + 1] ?? null;
    if (a === "--help" || a === "-h") args.help = true;
  }
  if (!["state", "submission"].includes(args.table)) args.table = "state";
  if (!["json", "csv"].includes(args.format)) args.format = "json";
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node bin/export-db.js [options]",
      "",
      "Options:",
      "  --db <path>           Database path (default: DB_FILE or data/experiment.db)",
      "  --table <name>        state | submission (default: state)",
      "  --format <name>       json | csv (default: json)",
      "  --normalized          Include derived normalized label columns",
      "                        (only applies to --table submission)",
      "  --out <path>          Write output file instead of stdout",
      "  -h, --help            Show help",
      "",
    ].join("\n"),
  );
}

function escapeCsv(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function normalizeValue(value) {
  const normalized = normalizeLabelForAnalysis(value);
  return normalized || null;
}

await optionalDotenv();

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const defaultDb = path.join(process.cwd(), "data", "experiment.db");
const dbFile = args.db || process.env.DB_FILE || defaultDb;

if (!fs.existsSync(dbFile)) {
  console.error(`DB not found: ${dbFile}`);
  process.exit(1);
}

const mod = await import("better-sqlite3");
const Database = mod.default ?? mod;
const db = new Database(dbFile, { readonly: true });

const tableExists = (name) => {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(name);
  return Boolean(row?.name);
};

let rows = [];
let header = [];

if (args.table === "state") {
  if (!tableExists("state_events")) {
    console.error("Table not found: state_events");
    process.exit(1);
  }
  header = [
    "id",
    "ts",
    "trial_id",
    "session_id",
    "reason",
    "source_path",
    "intended_by",
    "state_json",
    "warnings_json",
  ];
  rows = db
    .prepare(
      `SELECT id, ts, trial_id, session_id, reason, source_path, intended_by, state_json, warnings_json
       FROM state_events
       ORDER BY id ASC`,
    )
    .all();
} else {
  if (!tableExists("annotation_submissions")) {
    console.error("Table not found: annotation_submissions");
    process.exit(1);
  }
  header = [
    "id",
    "submitted_at",
    "input_started_at",
    "session_id",
    "submission_mode",
    "display_event_id",
    "triad_a",
    "triad_b",
    "triad_c",
    "selection",
    "odd",
    "pair_label",
    "odd_label",
    "a_label",
    "b_label",
    "c_label",
    "ab_label",
    "ac_label",
    "bc_label",
    "link_status",
    "link_note",
    "source",
    "raw_input_json",
    "errors_json",
  ];
  rows = db
    .prepare(
      `SELECT id, submitted_at, input_started_at, session_id, submission_mode, display_event_id,
              triad_a, triad_b, triad_c, selection, odd, pair_label, odd_label,
              a_label, b_label, c_label, ab_label, ac_label, bc_label,
              link_status, link_note, source, raw_input_json, errors_json
       FROM annotation_submissions
       ORDER BY id ASC`,
    )
    .all();

  if (args.normalized) {
    rows = rows.map((row) => ({
      ...row,
      pair_label_norm: normalizeValue(row.pair_label),
      odd_label_norm: normalizeValue(row.odd_label),
      a_label_norm: normalizeValue(row.a_label),
      b_label_norm: normalizeValue(row.b_label),
      c_label_norm: normalizeValue(row.c_label),
      ab_label_norm: normalizeValue(row.ab_label),
      ac_label_norm: normalizeValue(row.ac_label),
      bc_label_norm: normalizeValue(row.bc_label),
      normalization_version: LABEL_NORMALIZATION_VERSION,
    }));
    header = [
      ...header,
      "pair_label_norm",
      "odd_label_norm",
      "a_label_norm",
      "b_label_norm",
      "c_label_norm",
      "ab_label_norm",
      "ac_label_norm",
      "bc_label_norm",
      "normalization_version",
    ];
  }
}

let output = "";
if (args.format === "csv") {
  output += `${header.join(",")}\n`;
  for (const row of rows) {
    const line = header.map((k) => escapeCsv(row[k])).join(",");
    output += `${line}\n`;
  }
} else {
  output = JSON.stringify(rows, null, 2);
}

if (args.out) {
  fs.writeFileSync(args.out, output, "utf8");
  console.log(`Wrote ${args.out}`);
} else {
  process.stdout.write(output);
}
