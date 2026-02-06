#!/usr/bin/env node
// Quick read-only sanity checks for recent DB events.
// Usage: node bin/check-db.js [--db path] [--session id] [--limit n] [--table state|display|annotation|submission|both] [--raw] [--normalized]

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
    session: null,
    limit: 30,
    table: "both",
    raw: false,
    normalized: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--db") args.db = argv[i + 1] ?? null;
    if (arg === "--session") args.session = argv[i + 1] ?? null;
    if (arg === "--limit") args.limit = Number.parseInt(argv[i + 1] ?? "30", 10);
    if (arg === "--table") args.table = (argv[i + 1] ?? "both").toLowerCase();
    if (arg === "--raw") args.raw = true;
    if (arg === "--normalized") args.normalized = true;
    if (arg === "--help" || arg === "-h") args.help = true;
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) args.limit = 30;
  if (
    !["state", "display", "annotation", "submission", "both"].includes(
      args.table,
    )
  ) {
    args.table = "both";
  }

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node bin/check-db.js [options]",
      "",
      "Options:",
      "  --db <path>           Database path (default: DB_FILE or data/experiment.db)",
      "  --session <id>        Session id to inspect (default: latest session)",
      "  --limit <n>           Max rows per table (default: 30)",
      "  --table <name>        state | display | annotation | submission | both",
      "                        (default: both)",
      "  --raw                 Include raw JSON payloads",
      "  --normalized          Include derived normalized labels (versioned)",
      "  -h, --help            Show help",
      "",
    ].join("\n"),
  );
}

function safeParseJson(value, fallback) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function fmtTs(ts) {
  if (!ts) return "-";
  return String(ts).replace("T", " ").replace("Z", "");
}

function fmtTriad(triad) {
  if (!triad || typeof triad !== "object") return "-";
  const a = triad.a ? String(triad.a) : "?";
  const b = triad.b ? String(triad.b) : "?";
  const c = triad.c ? String(triad.c) : "?";
  return `${a}/${b}/${c}`;
}

function fmtTriadFromColumns(a, b, c) {
  return `${a || "?"}/${b || "?"}/${c || "?"}`;
}

function padLabel(label, width = 11) {
  if (label.length >= width) return label;
  return `${label}${" ".repeat(width - label.length)}`;
}

function normalizeLabelCell(value) {
  if (value === null || value === undefined) return "-";
  const text = String(value).trim();
  return text || "-";
}

function normalizeLabelCellForAnalysis(value) {
  const normalized = normalizeLabelForAnalysis(value);
  return normalized || "-";
}

function buildLabelColumns(row) {
  const columns = {
    a: "-",
    b: "-",
    c: "-",
    ab: "-",
    ac: "-",
    bc: "-",
  };

  const parsed = safeParseJson(row.labels_json, null);
  if (parsed && typeof parsed === "object") {
    for (const key of Object.keys(columns)) {
      if (Object.prototype.hasOwnProperty.call(parsed, key)) {
        columns[key] = normalizeLabelCell(parsed[key]);
      }
    }
  }

  const selection = row.selection ? String(row.selection) : null;
  const pairLabel = normalizeLabelCell(row.pair_label);
  if (pairLabel !== "-" && selection && Object.prototype.hasOwnProperty.call(columns, selection)) {
    columns[selection] = pairLabel;
  }

  const odd = row.odd ? String(row.odd) : null;
  const oddLabel = normalizeLabelCell(row.odd_label);
  if (oddLabel !== "-" && odd && Object.prototype.hasOwnProperty.call(columns, odd)) {
    columns[odd] = oddLabel;
  }

  return columns;
}

function rowCountLabel(count) {
  return count === 1 ? "1 row" : `${count} rows`;
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

const getColumns = (name) => {
  if (!tableExists(name)) return [];
  return db
    .prepare(`PRAGMA table_info(${name})`)
    .all()
    .map((row) => String(row.name));
};

const hasSessions = tableExists("sessions");
const hasStateEvents = tableExists("state_events");
const hasAnnotationEvents = tableExists("annotation_events");
const hasDisplayEvents = tableExists("display_events");
const hasAnnotationSubmissions = tableExists("annotation_submissions");
const stateColumns = getColumns("state_events");
const displayColumns = getColumns("display_events");
const annotationColumns = getColumns("annotation_events");
const submissionColumns = getColumns("annotation_submissions");
const stateHasSession = stateColumns.includes("session_id");
const displayHasSession = displayColumns.includes("session_id");
const annotationHasSession = annotationColumns.includes("session_id");
const submissionHasSession = submissionColumns.includes("session_id");
const annotationHasLabelsJson = annotationColumns.includes("labels_json");

let sessionId = null;
let sessionSource = "";

if (args.session !== null) {
  const parsed = Number.parseInt(String(args.session), 10);
  if (Number.isFinite(parsed)) {
    sessionId = parsed;
    sessionSource = "from --session";
  }
} else if (hasSessions) {
  const latest = db.prepare("SELECT id FROM sessions ORDER BY id DESC LIMIT 1").get();
  if (latest && Number.isFinite(Number(latest.id))) {
    sessionId = Number(latest.id);
    sessionSource = "latest from sessions";
  }
}

if (sessionId === null) {
  if (hasStateEvents && stateHasSession) {
    const latestState = db
      .prepare(
        "SELECT session_id FROM state_events WHERE session_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (latestState?.session_id !== undefined && latestState?.session_id !== null) {
      sessionId = Number(latestState.session_id);
      sessionSource = "latest from state_events";
    }
  }
  if (sessionId === null && hasDisplayEvents && displayHasSession) {
    const latestDisplay = db
      .prepare(
        "SELECT session_id FROM display_events WHERE session_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (latestDisplay?.session_id !== undefined && latestDisplay?.session_id !== null) {
      sessionId = Number(latestDisplay.session_id);
      sessionSource = "latest from display_events";
    }
  }
  if (sessionId === null && hasAnnotationEvents && annotationHasSession) {
    const latestAnnotation = db
      .prepare(
        "SELECT session_id FROM annotation_events WHERE session_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (
      latestAnnotation?.session_id !== undefined &&
      latestAnnotation?.session_id !== null
    ) {
      sessionId = Number(latestAnnotation.session_id);
      sessionSource = "latest from annotation_events";
    }
  }
  if (sessionId === null && hasAnnotationSubmissions && submissionHasSession) {
    const latestSubmission = db
      .prepare(
        "SELECT session_id FROM annotation_submissions WHERE session_id IS NOT NULL ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (
      latestSubmission?.session_id !== undefined &&
      latestSubmission?.session_id !== null
    ) {
      sessionId = Number(latestSubmission.session_id);
      sessionSource = "latest from annotation_submissions";
    }
  }
}

process.stdout.write(`DB: ${dbFile}\n`);
if (sessionId !== null) {
  process.stdout.write(`Session: ${sessionId} (${sessionSource})\n`);
} else {
  process.stdout.write("Session: none found (showing unscoped latest rows)\n");
}
process.stdout.write(`Limit: ${args.limit} rows per table\n`);
process.stdout.write("\n");

let printedAnything = false;

if (args.table === "state" || args.table === "both") {
  if (!hasStateEvents) {
    process.stdout.write("STATE_EVENTS\n");
    process.stdout.write("  table not found\n\n");
  } else {
    const canFilterSession = sessionId !== null && stateHasSession;
    const where = canFilterSession ? "WHERE session_id = @session_id" : "";
    const rows = db
      .prepare(
        `SELECT id, ts, session_id, reason, state_json, warnings_json
         FROM state_events
         ${where}
         ORDER BY id DESC
         LIMIT @limit`,
      )
      .all({
        session_id: sessionId,
        limit: args.limit,
      });

    process.stdout.write("STATE_EVENTS\n");
    if (sessionId !== null && !stateHasSession) {
      process.stdout.write("  note: session_id column missing; showing unscoped rows\n");
    }
    process.stdout.write(`  ${rowCountLabel(rows.length)}\n`);
    if (!rows.length) {
      process.stdout.write("  (none)\n\n");
    } else {
      printedAnything = true;
      for (const row of rows) {
        const state = safeParseJson(row.state_json, {});
        const warnings = safeParseJson(row.warnings_json, []);
        const triad = fmtTriad(state?.triad);
        const selectedPair = state?.selectedPair ? String(state.selectedPair) : "-";
        const reason = row.reason ? String(row.reason) : "-";
        const warningCount = Array.isArray(warnings) ? warnings.length : 0;
        process.stdout.write(
          `  #${row.id} ${fmtTs(row.ts)} ${padLabel(reason)} triad=${triad} pair=${selectedPair} warnings=${warningCount}\n`,
        );
        if (args.raw) {
          process.stdout.write(`    state_json: ${row.state_json}\n`);
          process.stdout.write(`    warnings_json: ${row.warnings_json}\n`);
        }
      }
      process.stdout.write("\n");
    }
  }
}

if (args.table === "display" || args.table === "both") {
  if (!hasDisplayEvents) {
    process.stdout.write("DISPLAY_EVENTS\n");
    process.stdout.write("  table not found\n\n");
  } else {
    const canFilterSession = sessionId !== null && displayHasSession;
    const where = canFilterSession ? "WHERE session_id = @session_id" : "";
    const rows = db
      .prepare(
        `SELECT id, ts, session_id, triad_a, triad_b, triad_c, selection, reason, state_event_id
         FROM display_events
         ${where}
         ORDER BY id DESC
         LIMIT @limit`,
      )
      .all({
        session_id: sessionId,
        limit: args.limit,
      });

    process.stdout.write("DISPLAY_EVENTS\n");
    if (sessionId !== null && !displayHasSession) {
      process.stdout.write(
        "  note: session_id column missing; showing unscoped rows\n",
      );
    }
    process.stdout.write(`  ${rowCountLabel(rows.length)}\n`);
    if (!rows.length) {
      process.stdout.write("  (none)\n\n");
    } else {
      printedAnything = true;
      for (const row of rows) {
        const triad = fmtTriadFromColumns(row.triad_a, row.triad_b, row.triad_c);
        const selection = row.selection ? String(row.selection) : "-";
        const reason = row.reason ? String(row.reason) : "-";
        const stateEventId =
          row.state_event_id !== null && row.state_event_id !== undefined
            ? String(row.state_event_id)
            : "-";
        process.stdout.write(
          `  #${row.id} ${fmtTs(row.ts)} ${padLabel(reason)} triad=${triad} pair=${selection} state_event_id=${stateEventId}\n`,
        );
      }
      process.stdout.write("\n");
    }
  }
}

if (args.table === "annotation" || args.table === "both") {
  if (!hasAnnotationEvents) {
    process.stdout.write("ANNOTATION_EVENTS\n");
    process.stdout.write("  table not found\n\n");
  } else {
    const canFilterSession = sessionId !== null && annotationHasSession;
    const where = canFilterSession ? "WHERE session_id = @session_id" : "";
    const labelsExpr = annotationHasLabelsJson ? "labels_json" : "NULL AS labels_json";
    const rows = db
      .prepare(
        `SELECT id, ts, session_id, selection, pair_label, odd, odd_label, triad_json, ${labelsExpr}, errors_json, raw_input_json
         FROM annotation_events
         ${where}
         ORDER BY id DESC
         LIMIT @limit`,
      )
      .all({
        session_id: sessionId,
        limit: args.limit,
      });

    process.stdout.write("ANNOTATION_EVENTS\n");
    if (sessionId !== null && !annotationHasSession) {
      process.stdout.write("  note: session_id column missing; showing unscoped rows\n");
    }
    process.stdout.write(`  ${rowCountLabel(rows.length)}\n`);
    if (!rows.length) {
      process.stdout.write("  (none)\n\n");
    } else {
      printedAnything = true;
      for (const row of rows) {
        const triad = fmtTriad(safeParseJson(row.triad_json, null));
        const errors = safeParseJson(row.errors_json, []);
        const errorCount = Array.isArray(errors) ? errors.length : 0;
        const selection = row.selection ? String(row.selection) : "-";
        const labels = buildLabelColumns(row);
        process.stdout.write(
          `  #${row.id} ${fmtTs(row.ts)} sel=${selection} triad=${triad} a="${labels.a}" b="${labels.b}" c="${labels.c}" ab="${labels.ab}" ac="${labels.ac}" bc="${labels.bc}" errors=${errorCount}\n`,
        );
        if (args.normalized) {
          process.stdout.write(
            `    normalized(${LABEL_NORMALIZATION_VERSION}): a="${normalizeLabelCellForAnalysis(labels.a)}" b="${normalizeLabelCellForAnalysis(labels.b)}" c="${normalizeLabelCellForAnalysis(labels.c)}" ab="${normalizeLabelCellForAnalysis(labels.ab)}" ac="${normalizeLabelCellForAnalysis(labels.ac)}" bc="${normalizeLabelCellForAnalysis(labels.bc)}"\n`,
          );
        }
        if (args.raw) {
          process.stdout.write(`    triad_json: ${row.triad_json}\n`);
          process.stdout.write(`    labels_json: ${row.labels_json}\n`);
          process.stdout.write(`    errors_json: ${row.errors_json}\n`);
          process.stdout.write(`    raw_input_json: ${row.raw_input_json}\n`);
        }
      }
      process.stdout.write("\n");
    }
  }
}

if (args.table === "submission" || args.table === "both") {
  if (!hasAnnotationSubmissions) {
    process.stdout.write("ANNOTATION_SUBMISSIONS\n");
    process.stdout.write("  table not found\n\n");
  } else {
    const canFilterSession = sessionId !== null && submissionHasSession;
    const where = canFilterSession ? "WHERE session_id = @session_id" : "";
    const rows = db
      .prepare(
        `SELECT id, submitted_at, input_started_at, display_event_id, submission_mode, triad_a, triad_b, triad_c, selection, odd,
                pair_label, odd_label, a_label, b_label, c_label, ab_label, ac_label, bc_label, link_status, link_note, errors_json, raw_input_json
         FROM annotation_submissions
         ${where}
         ORDER BY id DESC
         LIMIT @limit`,
      )
      .all({
        session_id: sessionId,
        limit: args.limit,
      });

    process.stdout.write("ANNOTATION_SUBMISSIONS\n");
    if (sessionId !== null && !submissionHasSession) {
      process.stdout.write(
        "  note: session_id column missing; showing unscoped rows\n",
      );
    }
    process.stdout.write(`  ${rowCountLabel(rows.length)}\n`);
    if (!rows.length) {
      process.stdout.write("  (none)\n\n");
    } else {
      printedAnything = true;
      for (const row of rows) {
        const triad = fmtTriadFromColumns(row.triad_a, row.triad_b, row.triad_c);
        const errors = safeParseJson(row.errors_json, []);
        const errorCount = Array.isArray(errors) ? errors.length : 0;
        const displayEventId =
          row.display_event_id !== null && row.display_event_id !== undefined
            ? String(row.display_event_id)
            : "-";
        const linkNote = row.link_note ? String(row.link_note) : "-";
        process.stdout.write(
          `  #${row.id} ${fmtTs(row.submitted_at)} mode=${row.submission_mode} triad=${triad} sel=${row.selection || "-"} odd=${row.odd || "-"} a="${normalizeLabelCell(row.a_label)}" b="${normalizeLabelCell(row.b_label)}" c="${normalizeLabelCell(row.c_label)}" ab="${normalizeLabelCell(row.ab_label)}" ac="${normalizeLabelCell(row.ac_label)}" bc="${normalizeLabelCell(row.bc_label)}" pair="${normalizeLabelCell(row.pair_label)}" odd_label="${normalizeLabelCell(row.odd_label)}" link=${row.link_status || "-"} link_note=${linkNote} display_event_id=${displayEventId} errors=${errorCount}\n`,
        );
        if (args.normalized) {
          process.stdout.write(
            `    normalized(${LABEL_NORMALIZATION_VERSION}): a="${normalizeLabelCellForAnalysis(row.a_label)}" b="${normalizeLabelCellForAnalysis(row.b_label)}" c="${normalizeLabelCellForAnalysis(row.c_label)}" ab="${normalizeLabelCellForAnalysis(row.ab_label)}" ac="${normalizeLabelCellForAnalysis(row.ac_label)}" bc="${normalizeLabelCellForAnalysis(row.bc_label)}" pair="${normalizeLabelCellForAnalysis(row.pair_label)}" odd_label="${normalizeLabelCellForAnalysis(row.odd_label)}"\n`,
          );
        }
        if (args.raw) {
          process.stdout.write(
            `    input_started_at: ${row.input_started_at || "-"}\n`,
          );
          process.stdout.write(`    link_note: ${row.link_note || "-"}\n`);
          process.stdout.write(`    errors_json: ${row.errors_json}\n`);
          process.stdout.write(`    raw_input_json: ${row.raw_input_json}\n`);
        }
      }
      process.stdout.write("\n");
    }
  }
}

if (!printedAnything) {
  process.stdout.write("No matching rows found.\n");
}

try {
  db.close();
} catch {
  // ignore close errors
}
