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
//   syncConstructsFromAnnotations({...}) -> Promise<{ inserted: number, scanned: number, session_ids: number[] | null }>
//   listConstructs({...}) -> Promise<object[]>
//   createConstruct({...}) -> Promise<object | null>
//   logConstructVoteEvent({...}) -> Promise<{ id: number, score: number } | null>
//   logConstructVisibilityEvent({...}) -> Promise<number | null>
//   logConstructPolarityEvent({...}) -> Promise<number | null>
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

const ALLOWED_PAIR_VALUES = new Set(["ab", "ac", "bc"]);
const ALLOWED_POLARITY_VALUES = new Set([
  "unknown",
  "positive",
  "negative",
  "neutral",
  "positive-absence-presence",
  "negative-absence-presence",
]);

function normaliseTriadValue(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text || "";
}

function toStoredTriad(triad) {
  if (!triad || typeof triad !== "object") return null;
  const stored = {
    a: normaliseTriadValue(triad.a),
    b: normaliseTriadValue(triad.b),
    c: normaliseTriadValue(triad.c),
  };
  if (!stored.a || !stored.b || !stored.c) return null;
  return stored;
}

function normalisePair(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return ALLOWED_PAIR_VALUES.has(text) ? text : null;
}

function deriveOddFromPair(pair) {
  if (pair === "ab") return "c";
  if (pair === "ac") return "b";
  if (pair === "bc") return "a";
  return null;
}

function normalisePolarity(value) {
  if (value === null || value === undefined) return "unknown";
  const text = String(value).trim().toLowerCase();
  return ALLOWED_POLARITY_VALUES.has(text) ? text : "unknown";
}

function normalizePositiveSessionIds(sessionIds) {
  if (!Array.isArray(sessionIds)) return [];
  const normalized = [];
  for (const value of sessionIds) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    if (!normalized.includes(parsed)) normalized.push(parsed);
  }
  return normalized;
}

function getOrCreateTriadId(db, triad) {
  const stored = toStoredTriad(triad);
  if (!stored) return null;

  const existing = db
    .prepare(
      `SELECT id
       FROM triads
       WHERE image_a = ? AND image_b = ? AND image_c = ?
       LIMIT 1`,
    )
    .get(stored.a, stored.b, stored.c);
  if (existing?.id) return Number(existing.id);

  try {
    const inserted = db
      .prepare(
        `INSERT INTO triads (image_a, image_b, image_c, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(stored.a, stored.b, stored.c, new Date().toISOString());
    const insertedId = Number(inserted.lastInsertRowid);
    if (Number.isFinite(insertedId)) return insertedId;
  } catch {
    // Unique collisions are expected if two calls race; fall through to re-read.
  }

  const reread = db
    .prepare(
      `SELECT id
       FROM triads
       WHERE image_a = ? AND image_b = ? AND image_c = ?
       LIMIT 1`,
    )
    .get(stored.a, stored.b, stored.c);
  return reread?.id ? Number(reread.id) : null;
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
    CREATE TABLE IF NOT EXISTS triads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_a TEXT NOT NULL,
      image_b TEXT NOT NULL,
      image_c TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(image_a, image_b, image_c)
    );

    CREATE INDEX IF NOT EXISTS idx_triads_created_at ON triads(created_at);
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
      triad_id INTEGER,
      triad_a TEXT,
      triad_b TEXT,
      triad_c TEXT,
      selection TEXT CHECK (selection IN ('ab', 'ac', 'bc') OR selection IS NULL),
      reason TEXT,
      state_event_id INTEGER,
      FOREIGN KEY(triad_id) REFERENCES triads(id)
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
      triad_id INTEGER,
      triad_a TEXT,
      triad_b TEXT,
      triad_c TEXT,
      selection TEXT CHECK (selection IN ('ab', 'ac', 'bc', 'override') OR selection IS NULL),
      odd TEXT CHECK (odd IN ('a', 'b', 'c') OR odd IS NULL),
      label1 TEXT,
      label2 TEXT,
      notes TEXT,
      pair TEXT CHECK (pair IN ('ab', 'ac', 'bc') OR pair IS NULL),
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
      FOREIGN KEY(triad_id) REFERENCES triads(id),
      FOREIGN KEY(display_event_id) REFERENCES display_events(id)
    );

    CREATE INDEX IF NOT EXISTS idx_annotation_submissions_session_id ON annotation_submissions(session_id);
    CREATE INDEX IF NOT EXISTS idx_annotation_submissions_submitted_at ON annotation_submissions(submitted_at);
    CREATE INDEX IF NOT EXISTS idx_annotation_submissions_display_event_id ON annotation_submissions(display_event_id);
    CREATE INDEX IF NOT EXISTS idx_annotation_submissions_submission_mode ON annotation_submissions(submission_mode);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS constructs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      positive_label TEXT NOT NULL,
      negative_label TEXT NOT NULL,
      origin_type TEXT NOT NULL CHECK (origin_type IN ('annotation', 'manual', 'derived')),
      origin_annotation_submission_id INTEGER UNIQUE,
      origin_session_id INTEGER,
      created_from_construct_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(origin_annotation_submission_id) REFERENCES annotation_submissions(id),
      FOREIGN KEY(created_from_construct_id) REFERENCES constructs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_constructs_origin_session_id ON constructs(origin_session_id);
    CREATE INDEX IF NOT EXISTS idx_constructs_origin_type ON constructs(origin_type);
    CREATE INDEX IF NOT EXISTS idx_constructs_created_from_construct_id ON constructs(created_from_construct_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS construct_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_construct_id INTEGER NOT NULL,
      target_construct_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL CHECK (relation_type IN ('subordinate', 'superordinate', 'unspecified')),
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(source_construct_id) REFERENCES constructs(id),
      FOREIGN KEY(target_construct_id) REFERENCES constructs(id),
      UNIQUE(source_construct_id, target_construct_id, relation_type)
    );

    CREATE INDEX IF NOT EXISTS idx_construct_relationships_source ON construct_relationships(source_construct_id);
    CREATE INDEX IF NOT EXISTS idx_construct_relationships_target ON construct_relationships(target_construct_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS construct_wordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      construct_id INTEGER NOT NULL,
      pole TEXT NOT NULL CHECK (pole IN ('positive', 'negative', 'unspecified')),
      wording TEXT NOT NULL,
      is_preferred INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0, 1)),
      created_at TEXT NOT NULL,
      FOREIGN KEY(construct_id) REFERENCES constructs(id),
      UNIQUE(construct_id, pole, wording)
    );

    CREATE INDEX IF NOT EXISTS idx_construct_wordings_construct_id ON construct_wordings(construct_id);
    CREATE INDEX IF NOT EXISTS idx_construct_wordings_pole ON construct_wordings(pole);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS construct_polarity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      construct_id INTEGER NOT NULL,
      label1_polarity TEXT NOT NULL CHECK (label1_polarity IN ('unknown', 'positive', 'negative', 'neutral', 'positive-absence-presence', 'negative-absence-presence')),
      label2_polarity TEXT NOT NULL CHECK (label2_polarity IN ('unknown', 'positive', 'negative', 'neutral', 'positive-absence-presence', 'negative-absence-presence')),
      source TEXT NOT NULL CHECK (source IN ('manual', 'inferred')),
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(construct_id) REFERENCES constructs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_construct_polarity_events_construct_id ON construct_polarity_events(construct_id);
    CREATE INDEX IF NOT EXISTS idx_construct_polarity_events_created_at ON construct_polarity_events(created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS construct_vote_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      construct_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      vote_delta INTEGER NOT NULL CHECK (vote_delta IN (-1, 1)),
      source TEXT NOT NULL CHECK (source IN ('manual', 'inferred')),
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(construct_id) REFERENCES constructs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_construct_vote_events_construct_id ON construct_vote_events(construct_id);
    CREATE INDEX IF NOT EXISTS idx_construct_vote_events_session_id ON construct_vote_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_construct_vote_events_created_at ON construct_vote_events(created_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS construct_visibility_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      construct_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('hidden', 'visible')),
      source TEXT NOT NULL CHECK (source IN ('manual', 'inferred')),
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(construct_id) REFERENCES constructs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_construct_visibility_events_construct_id ON construct_visibility_events(construct_id);
    CREATE INDEX IF NOT EXISTS idx_construct_visibility_events_session_id ON construct_visibility_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_construct_visibility_events_created_at ON construct_visibility_events(created_at);
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

  // Add triad_id column for older DBs.
  try {
    const cols = db
      .prepare("PRAGMA table_info(display_events)")
      .all()
      .map((row) => row.name);
    if (!cols.includes("triad_id")) {
      db.exec("ALTER TABLE display_events ADD COLUMN triad_id INTEGER;");
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_display_events_triad_id ON display_events(triad_id);",
    );
  } catch {
    // Ignore migration errors.
  }

  // Add new streamlined annotation columns for older DBs.
  try {
    const cols = db
      .prepare("PRAGMA table_info(annotation_submissions)")
      .all()
      .map((row) => row.name);
    if (!cols.includes("triad_id")) {
      db.exec(
        "ALTER TABLE annotation_submissions ADD COLUMN triad_id INTEGER;",
      );
    }
    if (!cols.includes("label1")) {
      db.exec("ALTER TABLE annotation_submissions ADD COLUMN label1 TEXT;");
    }
    if (!cols.includes("label2")) {
      db.exec("ALTER TABLE annotation_submissions ADD COLUMN label2 TEXT;");
    }
    if (!cols.includes("notes")) {
      db.exec("ALTER TABLE annotation_submissions ADD COLUMN notes TEXT;");
    }
    if (!cols.includes("pair")) {
      db.exec("ALTER TABLE annotation_submissions ADD COLUMN pair TEXT;");
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_annotation_submissions_triad_id ON annotation_submissions(triad_id);",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_annotation_submissions_pair ON annotation_submissions(pair);",
    );
  } catch {
    // Ignore migration errors.
  }

  // Ensure optional-column indices are present when those columns exist.
  try {
    const displayCols = db
      .prepare("PRAGMA table_info(display_events)")
      .all()
      .map((row) => row.name);
    if (displayCols.includes("triad_id")) {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_display_events_triad_id ON display_events(triad_id);",
      );
    }

    const submissionCols = db
      .prepare("PRAGMA table_info(annotation_submissions)")
      .all()
      .map((row) => row.name);
    if (submissionCols.includes("triad_id")) {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_annotation_submissions_triad_id ON annotation_submissions(triad_id);",
      );
    }
    if (submissionCols.includes("pair")) {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_annotation_submissions_pair ON annotation_submissions(pair);",
      );
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
 *   triadId?: number | null,
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
    triadId = null,
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
        triad_id,
        triad_a,
        triad_b,
        triad_c,
        selection,
        reason,
        state_event_id
      ) VALUES (
        @session_id,
        @ts,
        @triad_id,
        @triad_a,
        @triad_b,
        @triad_c,
        @selection,
        @reason,
        @state_event_id
      )
    `);

    const storedTriad = toStoredTriad(triad);
    const resolvedTriadId =
      typeof triadId === "number" && Number.isFinite(triadId) && triadId > 0
        ? triadId
        : getOrCreateTriadId(db, storedTriad);

    const res = stmt.run({
      session_id: typeof sessionId === "number" ? sessionId : null,
      ts: new Date().toISOString(),
      triad_id: resolvedTriadId,
      triad_a: storedTriad?.a ?? null,
      triad_b: storedTriad?.b ?? null,
      triad_c: storedTriad?.c ?? null,
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
 *   triad_id: number | null,
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
        `SELECT de.id,
                de.session_id,
                de.ts,
                de.triad_id,
                COALESCE(de.triad_a, t.image_a) AS triad_a,
                COALESCE(de.triad_b, t.image_b) AS triad_b,
                COALESCE(de.triad_c, t.image_c) AS triad_c,
                de.selection
         FROM display_events de
         LEFT JOIN triads t ON t.id = de.triad_id
         WHERE de.id = ?
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
 * Fetch display event history for a session, ordered oldest -> newest.
 *
 * @param {string} dbFile
 * @param {number | null | undefined} sessionId
 * @param {number} [limit=200]
 * @returns {Promise<Array<{
 *   id: number,
 *   session_id: number | null,
 *   ts: string,
 *   triad_id: number | null,
 *   triad_a: string | null,
 *   triad_b: string | null,
 *   triad_c: string | null,
 *   selection: string | null,
 *   reason: string | null
 * }>>}
 */
export async function listDisplayEventsBySession(
  dbFile,
  sessionId,
  limit = 200,
) {
  if (!dbFile) return [];
  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);
    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 1000)
        : 200;
    const hasSession =
      typeof sessionId === "number" && Number.isFinite(sessionId);
    const query = hasSession
      ? `SELECT x.id,
                x.session_id,
                x.ts,
                x.triad_id,
                COALESCE(x.triad_a, t.image_a) AS triad_a,
                COALESCE(x.triad_b, t.image_b) AS triad_b,
                COALESCE(x.triad_c, t.image_c) AS triad_c,
                x.selection,
                x.reason
         FROM (
           SELECT id, session_id, ts, triad_id, triad_a, triad_b, triad_c, selection, reason
           FROM display_events
           WHERE session_id = ?
           ORDER BY id DESC
           LIMIT ?
         ) x
         LEFT JOIN triads t ON t.id = x.triad_id
         ORDER BY x.id ASC`
      : `SELECT x.id,
                x.session_id,
                x.ts,
                x.triad_id,
                COALESCE(x.triad_a, t.image_a) AS triad_a,
                COALESCE(x.triad_b, t.image_b) AS triad_b,
                COALESCE(x.triad_c, t.image_c) AS triad_c,
                x.selection,
                x.reason
         FROM (
           SELECT id, session_id, ts, triad_id, triad_a, triad_b, triad_c, selection, reason
           FROM display_events
           ORDER BY id DESC
           LIMIT ?
         ) x
         LEFT JOIN triads t ON t.id = x.triad_id
         ORDER BY x.id ASC`;
    const rows = hasSession
      ? db.prepare(query).all(sessionId, safeLimit)
      : db.prepare(query).all(safeLimit);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.warn(
      "[db] listDisplayEventsBySession failed:",
      err?.message ?? err,
    );
    return [];
  }
}

/**
 * Sync canonical constructs from annotation submissions.
 * Safe to run repeatedly: existing imported rows are skipped.
 *
 * @param {{
 *   dbFile: string,
 *   sessionIds?: number[] | null,
 *   viewerSessionId?: number | null,
 *   limit?: number
 * }} params
 * @returns {Promise<{
 *   inserted: number,
 *   scanned: number,
 *   session_ids: number[] | null
 * }>}
 */
export async function syncConstructsFromAnnotations(params) {
  const { dbFile, sessionIds = null, limit = 1000 } = params ?? {};
  const normalizedSessionIds = normalizePositiveSessionIds(sessionIds);
  if (!dbFile) {
    return { inserted: 0, scanned: 0, session_ids: normalizedSessionIds };
  }

  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);

    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 10000)
        : 1000;
    const hasSessionFilter = normalizedSessionIds.length > 0;

    const sourceQuery = hasSessionFilter
      ? `SELECT s.id AS submission_id,
                s.session_id AS session_id,
                COALESCE(NULLIF(TRIM(s.label1), ''), NULLIF(TRIM(s.pair_label), '')) AS positive_label,
                COALESCE(NULLIF(TRIM(s.label2), ''), NULLIF(TRIM(s.odd_label), '')) AS negative_label
         FROM annotation_submissions s
         LEFT JOIN constructs c ON c.origin_annotation_submission_id = s.id
         WHERE c.id IS NULL
           AND COALESCE(NULLIF(TRIM(s.label1), ''), NULLIF(TRIM(s.pair_label), '')) IS NOT NULL
           AND COALESCE(NULLIF(TRIM(s.label2), ''), NULLIF(TRIM(s.odd_label), '')) IS NOT NULL
           AND s.session_id IN (${normalizedSessionIds.map(() => "?").join(", ")})
         ORDER BY s.id ASC
         LIMIT ?`
      : `SELECT s.id AS submission_id,
                s.session_id AS session_id,
                COALESCE(NULLIF(TRIM(s.label1), ''), NULLIF(TRIM(s.pair_label), '')) AS positive_label,
                COALESCE(NULLIF(TRIM(s.label2), ''), NULLIF(TRIM(s.odd_label), '')) AS negative_label
         FROM annotation_submissions s
         LEFT JOIN constructs c ON c.origin_annotation_submission_id = s.id
         WHERE c.id IS NULL
           AND COALESCE(NULLIF(TRIM(s.label1), ''), NULLIF(TRIM(s.pair_label), '')) IS NOT NULL
           AND COALESCE(NULLIF(TRIM(s.label2), ''), NULLIF(TRIM(s.odd_label), '')) IS NOT NULL
         ORDER BY s.id ASC
         LIMIT ?`;

    const sourceRows = hasSessionFilter
      ? db.prepare(sourceQuery).all(...normalizedSessionIds, safeLimit)
      : db.prepare(sourceQuery).all(safeLimit);
    const scanned = Array.isArray(sourceRows) ? sourceRows.length : 0;
    if (!scanned) {
      return {
        inserted: 0,
        scanned: 0,
        session_ids: hasSessionFilter ? normalizedSessionIds : null,
      };
    }

    const insertConstructStmt = db.prepare(`
      INSERT OR IGNORE INTO constructs (
        positive_label,
        negative_label,
        origin_type,
        origin_annotation_submission_id,
        origin_session_id,
        created_from_construct_id,
        created_at,
        updated_at
      ) VALUES (
        @positive_label,
        @negative_label,
        'annotation',
        @origin_annotation_submission_id,
        @origin_session_id,
        NULL,
        @created_at,
        @updated_at
      )
    `);

    const insertWordingStmt = db.prepare(`
      INSERT OR IGNORE INTO construct_wordings (
        construct_id,
        pole,
        wording,
        is_preferred,
        created_at
      ) VALUES (
        @construct_id,
        @pole,
        @wording,
        1,
        @created_at
      )
    `);

    const insertRows = db.transaction((rows) => {
      let inserted = 0;
      for (const row of rows) {
        const now = new Date().toISOString();
        const result = insertConstructStmt.run({
          positive_label: String(row.positive_label).trim(),
          negative_label: String(row.negative_label).trim(),
          origin_annotation_submission_id: row.submission_id,
          origin_session_id: row.session_id ?? null,
          created_at: now,
          updated_at: now,
        });
        if (Number(result.changes) !== 1) continue;

        inserted += 1;
        const constructId = Number(result.lastInsertRowid);
        if (!Number.isFinite(constructId) || constructId <= 0) continue;

        insertWordingStmt.run({
          construct_id: constructId,
          pole: "positive",
          wording: String(row.positive_label).trim(),
          created_at: now,
        });
        insertWordingStmt.run({
          construct_id: constructId,
          pole: "negative",
          wording: String(row.negative_label).trim(),
          created_at: now,
        });
      }
      return inserted;
    });

    const inserted = insertRows(sourceRows);
    return {
      inserted,
      scanned,
      session_ids: hasSessionFilter ? normalizedSessionIds : null,
    };
  } catch (err) {
    console.warn(
      "[db] syncConstructsFromAnnotations failed:",
      err?.message ?? err,
    );
    return {
      inserted: 0,
      scanned: 0,
      session_ids: normalizedSessionIds.length ? normalizedSessionIds : null,
    };
  }
}

/**
 * Fetch constructs from canonical construct tables.
 *
 * @param {{
 *   dbFile: string,
 *   sessionIds?: number[] | null,
 *   limit?: number
 * }} params
 * @returns {Promise<Array<{
 *   id: number,
 *   positive_label: string,
 *   negative_label: string,
 *   label1_polarity: "unknown" | "positive" | "negative" | "neutral" | "positive-absence-presence" | "negative-absence-presence",
 *   label2_polarity: "unknown" | "positive" | "negative" | "neutral" | "positive-absence-presence" | "negative-absence-presence",
 *   origin_type: "annotation" | "manual" | "derived",
 *   origin_annotation_submission_id: number | null,
 *   origin_session_id: number | null,
 *   created_from_construct_id: number | null,
 *   vote_score: number,
 *   created_at: string,
 *   updated_at: string
 * }>>}
 */
export async function listConstructs(params) {
  const {
    dbFile,
    sessionIds = null,
    viewerSessionId = null,
    limit = 200,
  } = params ?? {};
  if (!dbFile) return [];

  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);

    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 1000)
        : 200;
    const normalizedSessionIds = normalizePositiveSessionIds(sessionIds);
    const hasSessionFilter = normalizedSessionIds.length > 0;
    const parsedViewerSessionId = Number.parseInt(
      String(viewerSessionId ?? ""),
      10,
    );
    const normalizedViewerSessionId =
      Number.isFinite(parsedViewerSessionId) && parsedViewerSessionId > 0
        ? parsedViewerSessionId
        : null;
    const hasViewerSession = normalizedViewerSessionId !== null;

    const selectClause = `
      SELECT c.id,
             c.positive_label,
             c.negative_label,
             COALESCE(pe.label1_polarity, 'unknown') AS label1_polarity,
             COALESCE(pe.label2_polarity, 'unknown') AS label2_polarity,
             c.origin_type,
             c.origin_annotation_submission_id,
             c.origin_session_id,
             c.created_from_construct_id,
             COALESCE((
               SELECT SUM(v.vote_delta)
               FROM construct_vote_events v
               WHERE v.construct_id = c.id
             ), 0) AS vote_score,
             c.created_at,
             c.updated_at
      FROM constructs c
      ${
        hasViewerSession
          ? `LEFT JOIN construct_visibility_events ve
              ON ve.id = (
                SELECT ve2.id
                FROM construct_visibility_events ve2
                WHERE ve2.construct_id = c.id
                  AND ve2.session_id = ?
                ORDER BY ve2.id DESC
                LIMIT 1
              )`
          : ""
      }
      LEFT JOIN construct_polarity_events pe
        ON pe.id = (
          SELECT pe2.id
          FROM construct_polarity_events pe2
          WHERE pe2.construct_id = c.id
          ORDER BY pe2.id DESC
          LIMIT 1
        )
    `;

    const where = [];
    if (hasSessionFilter) {
      where.push(
        `c.origin_session_id IN (${normalizedSessionIds.map(() => "?").join(", ")})`,
      );
    }
    if (hasViewerSession) {
      where.push(`COALESCE(ve.visibility, 'visible') <> 'hidden'`);
    }

    const query = `${selectClause}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY vote_score DESC, c.id DESC
      LIMIT ?`;

    const queryParams = [];
    if (hasViewerSession) queryParams.push(normalizedViewerSessionId);
    if (hasSessionFilter) queryParams.push(...normalizedSessionIds);
    queryParams.push(safeLimit);

    const rows = db.prepare(query).all(...queryParams);

    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.warn("[db] listConstructs failed:", err?.message ?? err);
    return [];
  }
}

/**
 * Insert one canonical construct row (manual or derived) and preferred wording rows.
 *
 * @param {{
 *   dbFile: string,
 *   label1: string,
 *   label2: string,
 *   originType?: "manual" | "derived",
 *   originSessionId?: number | null,
 *   createdFromConstructId?: number | null,
 *   createdAt?: string | null
 * }} params
 * @returns {Promise<{
 *   id: number,
 *   positive_label: string,
 *   negative_label: string,
 *   label1_polarity: "unknown",
 *   label2_polarity: "unknown",
 *   origin_type: "manual" | "derived",
 *   origin_annotation_submission_id: null,
 *   origin_session_id: number | null,
 *   created_from_construct_id: number | null,
 *   vote_score: number,
 *   created_at: string,
 *   updated_at: string
 * } | null>}
 */
export async function createConstruct(params) {
  const {
    dbFile,
    label1,
    label2,
    originType = "manual",
    originSessionId = null,
    createdFromConstructId = null,
    createdAt = null,
  } = params ?? {};

  if (!dbFile) return null;

  const positiveLabel = normaliseTriadValue(label1);
  const negativeLabel = normaliseTriadValue(label2);
  if (!positiveLabel || !negativeLabel) return null;

  const normalizedOriginType = originType === "derived" ? "derived" : "manual";

  const parsedSessionId = Number.parseInt(String(originSessionId ?? ""), 10);
  const normalizedSessionId =
    Number.isFinite(parsedSessionId) && parsedSessionId > 0
      ? parsedSessionId
      : null;

  const parsedParentId = Number.parseInt(
    String(createdFromConstructId ?? ""),
    10,
  );
  const normalizedParentId =
    Number.isFinite(parsedParentId) && parsedParentId > 0
      ? parsedParentId
      : null;

  const now = createdAt ? String(createdAt) : new Date().toISOString();

  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);

    const runInsert = db.transaction(() => {
      if (normalizedParentId !== null) {
        const parentExists = db
          .prepare("SELECT id FROM constructs WHERE id = ? LIMIT 1")
          .get(normalizedParentId);
        if (!parentExists?.id) return null;
      }

      const insertConstruct = db.prepare(`
        INSERT INTO constructs (
          positive_label,
          negative_label,
          origin_type,
          origin_annotation_submission_id,
          origin_session_id,
          created_from_construct_id,
          created_at,
          updated_at
        ) VALUES (
          @positive_label,
          @negative_label,
          @origin_type,
          NULL,
          @origin_session_id,
          @created_from_construct_id,
          @created_at,
          @updated_at
        )
      `);

      const result = insertConstruct.run({
        positive_label: positiveLabel,
        negative_label: negativeLabel,
        origin_type: normalizedOriginType,
        origin_session_id: normalizedSessionId,
        created_from_construct_id: normalizedParentId,
        created_at: now,
        updated_at: now,
      });

      const constructId = Number(result.lastInsertRowid);
      if (!Number.isFinite(constructId) || constructId <= 0) return null;

      const insertWording = db.prepare(`
        INSERT OR IGNORE INTO construct_wordings (
          construct_id,
          pole,
          wording,
          is_preferred,
          created_at
        ) VALUES (
          @construct_id,
          @pole,
          @wording,
          1,
          @created_at
        )
      `);

      insertWording.run({
        construct_id: constructId,
        pole: "positive",
        wording: positiveLabel,
        created_at: now,
      });
      insertWording.run({
        construct_id: constructId,
        pole: "negative",
        wording: negativeLabel,
        created_at: now,
      });

      return {
        id: constructId,
        positive_label: positiveLabel,
        negative_label: negativeLabel,
        label1_polarity: "unknown",
        label2_polarity: "unknown",
        origin_type: normalizedOriginType,
        origin_annotation_submission_id: null,
        origin_session_id: normalizedSessionId,
        created_from_construct_id: normalizedParentId,
        vote_score: 0,
        created_at: now,
        updated_at: now,
      };
    });

    return runInsert();
  } catch (err) {
    console.warn("[db] createConstruct failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Append one construct vote event and return updated aggregate score.
 *
 * @param {{
 *   dbFile: string,
 *   constructId: number,
 *   sessionId: number,
 *   voteDelta: -1 | 1,
 *   source?: "manual" | "inferred",
 *   note?: string | null,
 *   createdAt?: string | null
 * }} params
 * @returns {Promise<{ id: number, score: number } | null>}
 */
export async function logConstructVoteEvent(params) {
  const {
    dbFile,
    constructId,
    sessionId,
    voteDelta,
    source = "manual",
    note = null,
    createdAt = null,
  } = params ?? {};

  if (!dbFile) return null;
  const parsedConstructId = Number.parseInt(String(constructId), 10);
  const parsedSessionId = Number.parseInt(String(sessionId), 10);
  if (!Number.isFinite(parsedConstructId) || parsedConstructId <= 0)
    return null;
  if (!Number.isFinite(parsedSessionId) || parsedSessionId <= 0) return null;

  const normalizedVoteDelta = Number(voteDelta) === -1 ? -1 : 1;
  const normalizedSource = source === "inferred" ? "inferred" : "manual";

  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);

    const runInsert = db.transaction(() => {
      const exists = db
        .prepare("SELECT id FROM constructs WHERE id = ? LIMIT 1")
        .get(parsedConstructId);
      if (!exists?.id) return null;

      const stmt = db.prepare(`
        INSERT INTO construct_vote_events (
          construct_id,
          session_id,
          vote_delta,
          source,
          note,
          created_at
        ) VALUES (
          @construct_id,
          @session_id,
          @vote_delta,
          @source,
          @note,
          @created_at
        )
      `);

      const result = stmt.run({
        construct_id: parsedConstructId,
        session_id: parsedSessionId,
        vote_delta: normalizedVoteDelta,
        source: normalizedSource,
        note: note ? String(note) : null,
        created_at: createdAt ? String(createdAt) : new Date().toISOString(),
      });

      const eventId = Number(result.lastInsertRowid);
      if (!Number.isFinite(eventId) || eventId <= 0) return null;

      const scoreRow = db
        .prepare(
          `SELECT COALESCE(SUM(vote_delta), 0) AS score
           FROM construct_vote_events
           WHERE construct_id = ?`,
        )
        .get(parsedConstructId);
      const score = Number(scoreRow?.score ?? 0);
      return {
        id: eventId,
        score: Number.isFinite(score) ? score : 0,
      };
    });

    return runInsert();
  } catch (err) {
    console.warn("[db] logConstructVoteEvent failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Append one construct visibility event.
 *
 * @param {{
 *   dbFile: string,
 *   constructId: number,
 *   sessionId: number,
 *   visibility?: "hidden" | "visible",
 *   source?: "manual" | "inferred",
 *   note?: string | null,
 *   createdAt?: string | null
 * }} params
 * @returns {Promise<number | null>}
 */
export async function logConstructVisibilityEvent(params) {
  const {
    dbFile,
    constructId,
    sessionId,
    visibility = "hidden",
    source = "manual",
    note = null,
    createdAt = null,
  } = params ?? {};

  if (!dbFile) return null;
  const parsedConstructId = Number.parseInt(String(constructId), 10);
  const parsedSessionId = Number.parseInt(String(sessionId), 10);
  if (!Number.isFinite(parsedConstructId) || parsedConstructId <= 0)
    return null;
  if (!Number.isFinite(parsedSessionId) || parsedSessionId <= 0) return null;

  const normalizedVisibility = visibility === "visible" ? "visible" : "hidden";
  const normalizedSource = source === "inferred" ? "inferred" : "manual";

  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);

    const exists = db
      .prepare("SELECT id FROM constructs WHERE id = ? LIMIT 1")
      .get(parsedConstructId);
    if (!exists?.id) return null;

    const stmt = db.prepare(`
      INSERT INTO construct_visibility_events (
        construct_id,
        session_id,
        visibility,
        source,
        note,
        created_at
      ) VALUES (
        @construct_id,
        @session_id,
        @visibility,
        @source,
        @note,
        @created_at
      )
    `);

    const result = stmt.run({
      construct_id: parsedConstructId,
      session_id: parsedSessionId,
      visibility: normalizedVisibility,
      source: normalizedSource,
      note: note ? String(note) : null,
      created_at: createdAt ? String(createdAt) : new Date().toISOString(),
    });

    const id = Number(result.lastInsertRowid);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    console.warn(
      "[db] logConstructVisibilityEvent failed:",
      err?.message ?? err,
    );
    return null;
  }
}

/**
 * Append one construct polarity event.
 *
 * @param {{
 *   dbFile: string,
 *   constructId: number,
 *   label1Polarity?: "unknown" | "positive" | "negative" | "neutral" | "positive-absence-presence" | "negative-absence-presence",
 *   label2Polarity?: "unknown" | "positive" | "negative" | "neutral" | "positive-absence-presence" | "negative-absence-presence",
 *   source?: "manual" | "inferred",
 *   note?: string | null,
 *   createdAt?: string | null
 * }} params
 * @returns {Promise<number | null>}
 */
export async function logConstructPolarityEvent(params) {
  const {
    dbFile,
    constructId,
    label1Polarity = "unknown",
    label2Polarity = "unknown",
    source = "manual",
    note = null,
    createdAt = null,
  } = params ?? {};

  if (!dbFile) return null;
  const parsedConstructId = Number.parseInt(String(constructId), 10);
  if (!Number.isFinite(parsedConstructId) || parsedConstructId <= 0)
    return null;

  try {
    const db = await getDb(dbFile);
    await initDb(dbFile);

    const exists = db
      .prepare("SELECT id FROM constructs WHERE id = ? LIMIT 1")
      .get(parsedConstructId);
    if (!exists?.id) return null;

    const stmt = db.prepare(`
      INSERT INTO construct_polarity_events (
        construct_id,
        label1_polarity,
        label2_polarity,
        source,
        note,
        created_at
      ) VALUES (
        @construct_id,
        @label1_polarity,
        @label2_polarity,
        @source,
        @note,
        @created_at
      )
    `);

    const result = stmt.run({
      construct_id: parsedConstructId,
      label1_polarity: normalisePolarity(label1Polarity),
      label2_polarity: normalisePolarity(label2Polarity),
      source: source === "inferred" ? "inferred" : "manual",
      note: note ? String(note) : null,
      created_at: createdAt ? String(createdAt) : new Date().toISOString(),
    });

    const id = Number(result.lastInsertRowid);
    return Number.isFinite(id) ? id : null;
  } catch (err) {
    console.warn("[db] logConstructPolarityEvent failed:", err?.message ?? err);
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
 *   triadId?: number | null,
 *   triad?: { a?: string, b?: string, c?: string } | null,
 *   label1?: string | null,
 *   label2?: string | null,
 *   notes?: string | null,
 *   pair?: string | null,
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
    triadId = null,
    triad = null,
    label1 = null,
    label2 = null,
    notes = null,
    pair = null,
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
        triad_id,
        triad_a,
        triad_b,
        triad_c,
        selection,
        odd,
        label1,
        label2,
        notes,
        pair,
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
        @triad_id,
        @triad_a,
        @triad_b,
        @triad_c,
        @selection,
        @odd,
        @label1,
        @label2,
        @notes,
        @pair,
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
    const pairVal = normalisePair(pair);
    const sel =
      selection && ["ab", "ac", "bc", "override"].includes(String(selection))
        ? String(selection)
        : pairVal;
    const oddVal =
      odd && ["a", "b", "c"].includes(String(odd)) ? String(odd) : null;
    const legacyPairLabel =
      pairLabel !== null && pairLabel !== undefined
        ? String(pairLabel)
        : label1 !== null && label1 !== undefined
          ? String(label1)
          : null;
    const legacyOddLabel =
      oddLabel !== null && oddLabel !== undefined
        ? String(oddLabel)
        : label2 !== null && label2 !== undefined
          ? String(label2)
          : null;
    const storedTriad = toStoredTriad(triad);
    const resolvedTriadId =
      typeof triadId === "number" && Number.isFinite(triadId) && triadId > 0
        ? triadId
        : getOrCreateTriadId(db, storedTriad);

    const res = stmt.run({
      session_id: typeof sessionId === "number" ? sessionId : null,
      submission_mode: mode,
      input_started_at: inputStartedAt ? String(inputStartedAt) : null,
      submitted_at: submittedAt
        ? String(submittedAt)
        : new Date().toISOString(),
      display_event_id:
        typeof displayEventId === "number" ? displayEventId : null,
      triad_id: resolvedTriadId,
      triad_a: storedTriad?.a ?? null,
      triad_b: storedTriad?.b ?? null,
      triad_c: storedTriad?.c ?? null,
      selection: sel,
      odd: oddVal ?? deriveOddFromPair(pairVal),
      label1: label1 ? String(label1) : null,
      label2: label2 ? String(label2) : null,
      notes: notes ? String(notes) : null,
      pair: pairVal,
      pair_label: legacyPairLabel,
      odd_label: legacyOddLabel,
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
