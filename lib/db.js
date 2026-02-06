// lib/db.js
// SQLite persistence for the Triadic Comparison Presentation App.
// ES module (package.json sets "type": "module").
//
// Contract (used by app.js):
//   initDb(dbFilePath) -> Promise<void>
//   createSession(dbFilePath) -> Promise<number | null>
//   logStateEvent({ dbFile, state, warnings, sourcePath, reason, sessionId }) -> Promise<number | null>
//   createDisplayEvent({...}) -> Promise<number | null>
//   getDisplayEventById(dbFilePath, id) -> Promise<object | null>
//   logAnnotationSubmission({...}) -> Promise<number | null>
//
// Notes:
// - Uses better-sqlite3 (synchronous driver) behind an async-friendly API.
// - Designed to be robust: logging failures should never crash the server.

import fs from "node:fs";
import path from "node:path";

/** @type {Map<string, import("better-sqlite3").Database>} */
const DB_CACHE = new Map();

/**
 * Serialize defensively; never throw on circular refs.
 * @param {any} value
 * @returns {string}
 */
function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (_k, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    },
    2,
  );
}

/**
 * Ensure directory exists for a given file path.
 * @param {string} filePath
 */
function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Open (or reuse) a DB connection for the given file path.
 * @param {string} dbFile
 * @returns {Promise<import("better-sqlite3").Database>}
 */
async function getDb(dbFile) {
  const abs = path.resolve(dbFile);
  const cached = DB_CACHE.get(abs);
  if (cached) return cached;

  ensureDirForFile(abs);

  const mod = await import("better-sqlite3");
  const Database = mod.default ?? mod;

  const db = new Database(abs);

  // Pragmas tuned for local, single-machine usage.
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // Some environments may not allow WAL; ignore.
  }
  try {
    db.pragma("synchronous = NORMAL");
  } catch {
    // Ignore.
  }
  try {
    db.pragma("foreign_keys = ON");
  } catch {
    // Ignore.
  }

  DB_CACHE.set(abs, db);
  return db;
}

/**
 * Create tables and indices if they do not already exist.
 * Safe to call multiple times.
 *
 * @param {string} dbFile
 * @returns {Promise<void>}
 */
export async function initDb(dbFile) {
  const db = await getDb(dbFile);

  // Schema is intentionally minimal and append-only.
  // - state_json stores the fully normalized state as rendered.
  // - warnings_json stores any non-fatal state warnings (array of strings).
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,                 -- ISO-8601 timestamp (UTC)
      trial_id INTEGER,                 -- may be NULL
      session_id INTEGER,               -- may be NULL
      reason TEXT,                      -- e.g. "startup", "file-change"
      source_path TEXT,                 -- state file path for provenance
      intended_by TEXT,                 -- convenience copy for quick filtering
      state_json TEXT NOT NULL,
      warnings_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_state_events_ts ON state_events(ts);
    CREATE INDEX IF NOT EXISTS idx_state_events_trial_id ON state_events(trial_id);
    CREATE INDEX IF NOT EXISTS idx_state_events_session_id ON state_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_state_events_reason ON state_events(reason);
  `);

  // Add session_id column for older DBs.
  try {
    const cols = db
      .prepare("PRAGMA table_info(state_events)")
      .all()
      .map((row) => row.name);
    if (!cols.includes("session_id")) {
      db.exec("ALTER TABLE state_events ADD COLUMN session_id INTEGER;");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_state_events_session_id ON state_events(session_id);",
      );
    }
  } catch {
    // Ignore migration errors.
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS annotation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      session_id INTEGER,
      triad_json TEXT,
      selection TEXT,
      pair_label TEXT,
      odd TEXT,
      odd_label TEXT,
      labels_json TEXT,
      raw_input_json TEXT NOT NULL,
      source TEXT,
      errors_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_annotation_events_ts ON annotation_events(ts);
    CREATE INDEX IF NOT EXISTS idx_annotation_events_session_id ON annotation_events(session_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS display_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      ts TEXT NOT NULL,
      triad_a TEXT,
      triad_b TEXT,
      triad_c TEXT,
      selection TEXT CHECK (selection IN ('ab', 'ac', 'bc') OR selection IS NULL),
      reason TEXT,
      state_event_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_display_events_session_id ON display_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_display_events_ts ON display_events(ts);
    CREATE INDEX IF NOT EXISTS idx_display_events_state_event_id ON display_events(state_event_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS annotation_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      submission_mode TEXT NOT NULL CHECK (submission_mode IN ('current-view', 'override')),
      input_started_at TEXT,
      submitted_at TEXT NOT NULL,
      display_event_id INTEGER,
      triad_a TEXT,
      triad_b TEXT,
      triad_c TEXT,
      selection TEXT CHECK (selection IN ('ab', 'ac', 'bc', 'override') OR selection IS NULL),
      odd TEXT CHECK (odd IN ('a', 'b', 'c') OR odd IS NULL),
      pair_label TEXT,
      odd_label TEXT,
      a_label TEXT,
      b_label TEXT,
      c_label TEXT,
      ab_label TEXT,
      ac_label TEXT,
      bc_label TEXT,
      link_status TEXT NOT NULL CHECK (link_status IN ('linked', 'last-view', 'unlinked')),
      link_note TEXT,
      source TEXT,
      raw_input_json TEXT NOT NULL,
      errors_json TEXT NOT NULL,
      FOREIGN KEY(display_event_id) REFERENCES display_events(id)
    );

    CREATE INDEX IF NOT EXISTS idx_annotation_submissions_session_id ON annotation_submissions(session_id);
    CREATE INDEX IF NOT EXISTS idx_annotation_submissions_submitted_at ON annotation_submissions(submitted_at);
    CREATE INDEX IF NOT EXISTS idx_annotation_submissions_display_event_id ON annotation_submissions(display_event_id);
    CREATE INDEX IF NOT EXISTS idx_annotation_submissions_submission_mode ON annotation_submissions(submission_mode);
  `);

  // Add labels_json column for older DBs.
  try {
    const cols = db
      .prepare("PRAGMA table_info(annotation_events)")
      .all()
      .map((row) => row.name);
    if (!cols.includes("labels_json")) {
      db.exec("ALTER TABLE annotation_events ADD COLUMN labels_json TEXT;");
    }
  } catch {
    // Ignore migration errors.
  }
}

/**
 * Insert a single state snapshot event into the database.
 * Failures are swallowed (and logged to console.warn) so the app keeps running.
 *
 * @param {{
 *   dbFile: string,
 *   state: any,
 *   warnings?: string[],
 *   sourcePath?: string,
 *   reason?: string
 * }} params
 * @returns {Promise<number | null>}
 */
export async function logStateEvent(params) {
  const {
    dbFile,
    state,
    warnings = [],
    sourcePath = "",
    reason = "reload",
    sessionId = null,
  } = params ?? {};

  if (!dbFile) return;

  try {
    const db = await getDb(dbFile);

    // Ensure schema exists (defensive: callers may forget to await initDb).
    await initDb(dbFile);

    const stmt = db.prepare(`
      INSERT INTO state_events (
        ts, trial_id, session_id, reason, source_path, intended_by, state_json, warnings_json
      ) VALUES (
        @ts, @trial_id, @session_id, @reason, @source_path, @intended_by, @state_json, @warnings_json
      )
    `);

    const ts = new Date().toISOString();
    const trialId =
      state && typeof state === "object" && state.trial_id !== undefined
        ? state.trial_id
        : null;

    const intendedBy =
      state && typeof state === "object" ? String(state.intended_by ?? "") : "";

    const res = stmt.run({
      ts,
      trial_id: typeof trialId === "number" ? trialId : null,
      session_id: typeof sessionId === "number" ? sessionId : null,
      reason: reason ? String(reason) : null,
      source_path: sourcePath ? String(sourcePath) : null,
      intended_by: intendedBy,
      state_json: safeStringify(state ?? {}),
      warnings_json: safeStringify(
        Array.isArray(warnings) ? warnings : [String(warnings)],
      ),
    });
    const id = Number(res.lastInsertRowid);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    // Logging should be non-fatal; emit a concise warning.
    console.warn("[db] logStateEvent failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Insert a single annotation event into the database.
 * Failures are swallowed (and logged to console.warn) so the app keeps running.
 *
 * @param {{
 *   dbFile: string,
 *   sessionId?: number | null,
 *   triad?: { a?: string, b?: string, c?: string } | null,
 *   selection?: string | null,
 *   pairLabel?: string,
 *   odd?: string | null,
 *   oddLabel?: string,
 *   labelsJson?: any,
 *   rawInput?: any,
 *   source?: string,
 *   errors?: string[]
 * }} params
 * @returns {Promise<void>}
 */
export async function logAnnotationEvent(params) {
  const {
    dbFile,
    sessionId = null,
    triad = null,
    selection = null,
    pairLabel = "",
    odd = null,
    oddLabel = "",
    labelsJson = null,
    rawInput = null,
    source = "assistant-ui",
    errors = [],
  } = params ?? {};

  if (!dbFile) return;

  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);

    const stmt = db.prepare(`
      INSERT INTO annotation_events (
        ts,
        session_id,
        triad_json,
        selection,
        pair_label,
        odd,
        odd_label,
        labels_json,
        raw_input_json,
        source,
        errors_json
      ) VALUES (
        @ts,
        @session_id,
        @triad_json,
        @selection,
        @pair_label,
        @odd,
        @odd_label,
        @labels_json,
        @raw_input_json,
        @source,
        @errors_json
      )
    `);

    stmt.run({
      ts: new Date().toISOString(),
      session_id: typeof sessionId === "number" ? sessionId : null,
      triad_json: triad ? safeStringify(triad) : null,
      selection: selection ? String(selection) : null,
      pair_label: pairLabel ? String(pairLabel) : null,
      odd: odd ? String(odd) : null,
      odd_label: oddLabel ? String(oddLabel) : null,
      labels_json: labelsJson ? safeStringify(labelsJson) : null,
      raw_input_json: safeStringify(rawInput ?? {}),
      source: source ? String(source) : null,
      errors_json: safeStringify(
        Array.isArray(errors) ? errors : [String(errors)],
      ),
    });
  } catch (err) {
    console.warn("[db] logAnnotationEvent failed:", err?.message ?? err);
  }
}

/**
 * Insert a display event row and return inserted id.
 *
 * @param {{
 *   dbFile: string,
 *   sessionId?: number | null,
 *   triad?: { a?: string, b?: string, c?: string } | null,
 *   selection?: string | null,
 *   reason?: string,
 *   stateEventId?: number | null
 * }} params
 * @returns {Promise<number | null>}
 */
export async function createDisplayEvent(params) {
  const {
    dbFile,
    sessionId = null,
    triad = null,
    selection = null,
    reason = "",
    stateEventId = null,
  } = params ?? {};

  if (!dbFile) return null;

  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);

    const stmt = db.prepare(`
      INSERT INTO display_events (
        session_id,
        ts,
        triad_a,
        triad_b,
        triad_c,
        selection,
        reason,
        state_event_id
      ) VALUES (
        @session_id,
        @ts,
        @triad_a,
        @triad_b,
        @triad_c,
        @selection,
        @reason,
        @state_event_id
      )
    `);

    const res = stmt.run({
      session_id: typeof sessionId === "number" ? sessionId : null,
      ts: new Date().toISOString(),
      triad_a: triad?.a ? String(triad.a) : null,
      triad_b: triad?.b ? String(triad.b) : null,
      triad_c: triad?.c ? String(triad.c) : null,
      selection:
        selection && ["ab", "ac", "bc"].includes(String(selection))
          ? String(selection)
          : null,
      reason: reason ? String(reason) : null,
      state_event_id: typeof stateEventId === "number" ? stateEventId : null,
    });

    const id = Number(res.lastInsertRowid);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    console.warn("[db] createDisplayEvent failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Fetch one display event by id.
 *
 * @param {string} dbFile
 * @param {number | null | undefined} id
 * @returns {Promise<{
 *   id: number,
 *   session_id: number | null,
 *   ts: string,
 *   triad_a: string | null,
 *   triad_b: string | null,
 *   triad_c: string | null,
 *   selection: string | null
 * } | null>}
 */
export async function getDisplayEventById(dbFile, id) {
  if (!dbFile) return null;
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);
    const row = db
      .prepare(
        `SELECT id, session_id, ts, triad_a, triad_b, triad_c, selection
         FROM display_events
         WHERE id = ?
         LIMIT 1`,
      )
      .get(id);
    return row ?? null;
  } catch (err) {
    console.warn("[db] getDisplayEventById failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Insert one annotation submission row and return inserted id.
 *
 * @param {{
 *   dbFile: string,
 *   sessionId?: number | null,
 *   submissionMode: "current-view" | "override",
 *   inputStartedAt?: string | null,
 *   submittedAt?: string | null,
 *   displayEventId?: number | null,
 *   triad?: { a?: string, b?: string, c?: string } | null,
 *   selection?: string | null,
 *   odd?: string | null,
 *   pairLabel?: string | null,
 *   oddLabel?: string | null,
 *   labels?: { a?: string, b?: string, c?: string, ab?: string, ac?: string, bc?: string } | null,
 *   linkStatus?: "linked" | "last-view" | "unlinked",
 *   linkNote?: string | null,
 *   source?: string | null,
 *   rawInput?: any,
 *   errors?: string[]
 * }} params
 * @returns {Promise<number | null>}
 */
export async function logAnnotationSubmission(params) {
  const {
    dbFile,
    sessionId = null,
    submissionMode = "current-view",
    inputStartedAt = null,
    submittedAt = null,
    displayEventId = null,
    triad = null,
    selection = null,
    odd = null,
    pairLabel = null,
    oddLabel = null,
    labels = null,
    linkStatus = "unlinked",
    linkNote = null,
    source = "assistant-ui",
    rawInput = null,
    errors = [],
  } = params ?? {};

  if (!dbFile) return null;
  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);

    const stmt = db.prepare(`
      INSERT INTO annotation_submissions (
        session_id,
        submission_mode,
        input_started_at,
        submitted_at,
        display_event_id,
        triad_a,
        triad_b,
        triad_c,
        selection,
        odd,
        pair_label,
        odd_label,
        a_label,
        b_label,
        c_label,
        ab_label,
        ac_label,
        bc_label,
        link_status,
        link_note,
        source,
        raw_input_json,
        errors_json
      ) VALUES (
        @session_id,
        @submission_mode,
        @input_started_at,
        @submitted_at,
        @display_event_id,
        @triad_a,
        @triad_b,
        @triad_c,
        @selection,
        @odd,
        @pair_label,
        @odd_label,
        @a_label,
        @b_label,
        @c_label,
        @ab_label,
        @ac_label,
        @bc_label,
        @link_status,
        @link_note,
        @source,
        @raw_input_json,
        @errors_json
      )
    `);

    const mode = submissionMode === "override" ? "override" : "current-view";
    const sel =
      selection && ["ab", "ac", "bc", "override"].includes(String(selection))
        ? String(selection)
        : null;
    const oddVal =
      odd && ["a", "b", "c"].includes(String(odd)) ? String(odd) : null;

    const res = stmt.run({
      session_id: typeof sessionId === "number" ? sessionId : null,
      submission_mode: mode,
      input_started_at: inputStartedAt ? String(inputStartedAt) : null,
      submitted_at: submittedAt ? String(submittedAt) : new Date().toISOString(),
      display_event_id: typeof displayEventId === "number" ? displayEventId : null,
      triad_a: triad?.a ? String(triad.a) : null,
      triad_b: triad?.b ? String(triad.b) : null,
      triad_c: triad?.c ? String(triad.c) : null,
      selection: sel,
      odd: oddVal,
      pair_label: pairLabel ? String(pairLabel) : null,
      odd_label: oddLabel ? String(oddLabel) : null,
      a_label: labels?.a ? String(labels.a) : null,
      b_label: labels?.b ? String(labels.b) : null,
      c_label: labels?.c ? String(labels.c) : null,
      ab_label: labels?.ab ? String(labels.ab) : null,
      ac_label: labels?.ac ? String(labels.ac) : null,
      bc_label: labels?.bc ? String(labels.bc) : null,
      link_status: ["linked", "last-view", "unlinked"].includes(linkStatus)
        ? linkStatus
        : "unlinked",
      link_note: linkNote ? String(linkNote) : null,
      source: source ? String(source) : null,
      raw_input_json: safeStringify(rawInput ?? {}),
      errors_json: safeStringify(
        Array.isArray(errors) ? errors : [String(errors)],
      ),
    });

    const id = Number(res.lastInsertRowid);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    console.warn("[db] logAnnotationSubmission failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Create a new session row and return its auto-incremented ID.
 *
 * @param {string} dbFile
 * @returns {Promise<number | null>}
 */
export async function createSession(dbFile) {
  if (!dbFile) return null;
  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);
    const stmt = db.prepare("INSERT INTO sessions (ts) VALUES (?)");
    const res = stmt.run(new Date().toISOString());
    const id = Number(res.lastInsertRowid);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    console.warn("[db] createSession failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Optional helper for tests/maintenance: closes all cached DB connections.
 * Not used by app.js, but useful in scripts.
 */
export function closeAllDbs() {
  for (const db of DB_CACHE.values()) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
  DB_CACHE.clear();
}
