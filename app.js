// app.js
// Triadic Comparison Presentation App (Node + Express)
// ES module entrypoint (see package.json: { "type": "module" }).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Optional dependency loading (keeps error messages actionable if deps are missing).
 * The project README describes Express/EJS/SQLite usage; install deps accordingly.
 */
async function optionalImport(specifier, installHint) {
  try {
    return await import(specifier);
  } catch (err) {
    const msg =
      `Failed to import '${specifier}'.\n` +
      (installHint ? `${installHint}\n` : "") +
      `Original error: ${err?.message ?? String(err)}`;
    const e = new Error(msg);
    e.cause = err;
    throw e;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Load .env if present ----------------------------------------------------
let dotenv;
try {
  dotenv = await import("dotenv");
  dotenv.config();
} catch {
  // .env is optional; fall back to process.env only.
}

// --- Core runtime deps -------------------------------------------------------
const { default: express } = await optionalImport(
  "express",
  "Install with: npm i express",
);

// EJS is the default template engine assumed by README/proposal.
await optionalImport("ejs", "Install with: npm i ejs");

// --- Project modules ---------------------------------------------------------
const { resolveTriadImages } = await optionalImport(
  "./lib/images.js",
  "Missing ./lib/images.js. Create it per README.md.",
);

const {
  initDb,
  logStateEvent,
  logAnnotationEvent,
  createDisplayEvent,
  getDisplayEventById,
  logAnnotationSubmission,
  createSession,
  listDisplayEventsBySession,
  syncConstructsFromAnnotations,
  listConstructs,
  createConstruct,
  logConstructVoteEvent,
  logConstructVisibilityEvent,
  logConstructPolarityEvent,
} = await optionalImport(
  "./lib/db.js",
  "Missing ./lib/db.js. Create it per README.md / proposal.",
);

// --- Configuration -----------------------------------------------------------
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "127.0.0.1";
const IMAGES_DIR =
  process.env.IMAGES_DIR ?? path.join(__dirname, "public", "images");
const DB_FILE =
  process.env.DB_FILE ?? path.join(__dirname, "data", "experiment.db");
let SESSION_ID = null;
let CURRENT_VIEW = {
  triad: null,
  triadId: null,
  selection: null,
  displayEventId: null,
};

// --- Express setup -----------------------------------------------------------
const app = express();
app.use(express.json());

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Static assets (CSS, placeholder, logo, images)
app.use(express.static(path.join(__dirname, "public")));

const VALID_PAIR_SELECTIONS = new Set(["ab", "ac", "bc"]);
const VALID_SELECTIONS = new Set(["ab", "ac", "bc", "override"]);
const VALID_POLARITY_VALUES = new Set([
  "unknown",
  "positive",
  "negative",
  "neutral",
  "positive-absence-presence",
  "negative-absence-presence",
]);

const cleanLabel = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text || "";
};

const normalisePair = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  return VALID_PAIR_SELECTIONS.has(text) ? text : null;
};

const normalisePolarity = (value) => {
  if (value === null || value === undefined) return "unknown";
  const text = String(value).trim().toLowerCase();
  return VALID_POLARITY_VALUES.has(text) ? text : "unknown";
};

const deriveOddFromPair = (pair) => {
  if (pair === "ab") return "c";
  if (pair === "ac") return "b";
  if (pair === "bc") return "a";
  return null;
};

const parseTriadPayload = (triadCandidate) => {
  if (!triadCandidate || typeof triadCandidate !== "object") return null;
  const triad = {
    a: cleanLabel(triadCandidate.a),
    b: cleanLabel(triadCandidate.b),
    c: cleanLabel(triadCandidate.c),
  };
  if (!triad.a || !triad.b || !triad.c) return null;
  return triad;
};

const triadsMatch = (left, right) =>
  Boolean(
    left &&
    right &&
    left.a === right.a &&
    left.b === right.b &&
    left.c === right.c,
  );

const resolveTriadImageMap = (triad) => {
  if (!triad) return null;
  return resolveTriadImages(triad, {
    imagesDir: IMAGES_DIR,
  });
};

const buildCurrentViewPayload = () => ({
  triad: CURRENT_VIEW.triad,
  triad_id: CURRENT_VIEW.triadId,
  triad_images: resolveTriadImageMap(CURRENT_VIEW.triad),
  selection: CURRENT_VIEW.selection,
  display_event_id: CURRENT_VIEW.displayEventId,
  session_id: SESSION_ID,
});

const toConstructPayload = (row) => {
  const label1 = String(row.positive_label ?? "").trim();
  const label2 = String(row.negative_label ?? "").trim();
  return {
    id: row.id,
    label1,
    label2,
    label1_polarity: row.label1_polarity ?? "unknown",
    label2_polarity: row.label2_polarity ?? "unknown",
    origin_type: row.origin_type,
    source_annotation_submission_id:
      row.origin_annotation_submission_id ?? null,
    source_session_id: row.origin_session_id ?? null,
    derived_from_construct_id: row.created_from_construct_id ?? null,
    vote_score: Number(row.vote_score ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const parseLimitedPositiveInt = (value, fallback, max) => {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const parseSessionTokens = (value) => {
  if (value === null || value === undefined) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .flatMap((part) => String(part).split(","))
    .map((part) => part.trim())
    .filter(Boolean);
};

const resolveSessionScope = ({ values, defaultSessionId = null }) => {
  const tokens = values.flatMap((value) => parseSessionTokens(value));
  const requestAll = tokens.some((token) => token.toLowerCase() === "all");
  if (requestAll) return { sessionIds: null };

  const sessionIds = [];
  for (const token of tokens) {
    const parsed = Number.parseInt(token, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    if (!sessionIds.includes(parsed)) sessionIds.push(parsed);
  }

  if (sessionIds.length) return { sessionIds };
  if (
    typeof defaultSessionId === "number" &&
    Number.isFinite(defaultSessionId) &&
    defaultSessionId > 0
  ) {
    return { sessionIds: [defaultSessionId] };
  }

  return { sessionIds: null };
};

// --- Routes -----------------------------------------------------------------
app.get("/", (_req, res) => res.redirect("/display"));

app.get("/display", async (_req, res) => {
  const hasQueryParams =
    Object.prototype.hasOwnProperty.call(_req.query, "a") ||
    Object.prototype.hasOwnProperty.call(_req.query, "b") ||
    Object.prototype.hasOwnProperty.call(_req.query, "c");

  const queryTriad = {
    a:
      hasQueryParams && _req.query.a !== undefined
        ? String(_req.query.a).trim()
        : "",
    b:
      hasQueryParams && _req.query.b !== undefined
        ? String(_req.query.b).trim()
        : "",
    c:
      hasQueryParams && _req.query.c !== undefined
        ? String(_req.query.c).trim()
        : "",
  };

  const state = {
    triad: hasQueryParams ? queryTriad : { a: "", b: "", c: "" },
  };

  // Derived fields for the template.
  const mode = "triad";
  const triadImages = resolveTriadImages(state?.triad, {
    imagesDir: IMAGES_DIR,
  });

  const triadErrors = {};
  if (hasQueryParams) {
    if (!triadImages.a) triadErrors.a = "Image not found";
    if (!triadImages.b) triadErrors.b = "Image not found";
    if (!triadImages.c) triadErrors.c = "Image not found";
  }

  const hasTriadErrors = Object.keys(triadErrors).length > 0;
  if (hasQueryParams && hasTriadErrors) {
    await logStateEvent({
      dbFile: DB_FILE,
      state: { triad: queryTriad, errors: triadErrors },
      warnings: [],
      sourcePath: "client",
      reason: "invalid-form",
      sessionId: SESSION_ID,
    });
  }

  if (hasQueryParams && !hasTriadErrors) {
    const displayEventId = await createDisplayEvent({
      dbFile: DB_FILE,
      sessionId: SESSION_ID,
      triad: queryTriad,
      selection: null,
      reason: "display-load",
    });
    const displayEvent = displayEventId
      ? await getDisplayEventById(DB_FILE, displayEventId)
      : null;
    CURRENT_VIEW = {
      triad: queryTriad,
      triadId: displayEvent?.triad_id ?? null,
      selection: null,
      displayEventId,
    };
  } else {
    CURRENT_VIEW = {
      triad: null,
      triadId: null,
      selection: null,
      displayEventId: null,
    };
  }

  // Single template for the combinations flow.
  const template = "combinations";

  return res.render(template, {
    state,
    mode,
    triadImages,
    triadErrors,
    showForm: !hasQueryParams || hasTriadErrors,
    sessionId: SESSION_ID,
  });
});

app.get("/annotate", (_req, res) => {
  return res.render("annotate", {
    mode: "annotate",
    sessionId: SESSION_ID,
  });
});

app.get("/constructs", async (req, res) => {
  const limit = parseLimitedPositiveInt(req.query.limit, 200, 1000);
  const { sessionIds } = resolveSessionScope({
    values: [req.query.session, req.query.session_id],
    defaultSessionId: SESSION_ID,
  });

  const syncResult = await syncConstructsFromAnnotations({
    dbFile: DB_FILE,
    sessionIds,
    limit: 10000,
  });

  const rows = await listConstructs({
    dbFile: DB_FILE,
    sessionIds,
    viewerSessionId: SESSION_ID,
    limit,
  });
  const constructs = rows.map(toConstructPayload);

  return res.render("constructs", {
    mode: "constructs",
    constructs,
    limit,
    count: constructs.length,
    syncResult,
    sessionId:
      Array.isArray(sessionIds) && sessionIds.length === 1
        ? sessionIds[0]
        : null,
    sessionIds: Array.isArray(sessionIds) ? sessionIds : null,
  });
});

app.post("/display/log", async (req, res) => {
  const body = req.body ?? {};
  const triad = parseTriadPayload(body.triad);
  const selectedPair = body.selectedPair ?? null;
  const order = body.order ?? null;

  const stateEventId = await logStateEvent({
    dbFile: DB_FILE,
    state: {
      triad,
      selectedPair,
      order,
    },
    warnings: [],
    sourcePath: "client",
    reason: "combination-view",
    sessionId: SESSION_ID,
  });

  const validSelection = normalisePair(selectedPair);
  const displayEventId = await createDisplayEvent({
    dbFile: DB_FILE,
    sessionId: SESSION_ID,
    triad,
    selection: validSelection,
    reason: selectedPair ? "selection-change" : "selection-clear",
    stateEventId,
  });

  const displayEvent = displayEventId
    ? await getDisplayEventById(DB_FILE, displayEventId)
    : null;
  if (triad) CURRENT_VIEW.triad = triad;
  CURRENT_VIEW.selection = validSelection;
  CURRENT_VIEW.displayEventId = displayEventId;
  CURRENT_VIEW.triadId = displayEvent?.triad_id ?? null;

  res.json({ ok: true });
});

app.post("/annotate/log", async (req, res) => {
  const body = req.body ?? {};
  const errors = [];
  const allowedOdd = new Set(["a", "b", "c"]);

  let triad = parseTriadPayload(body.triad);
  if (!triad && body.triad !== null && body.triad !== undefined) {
    errors.push("triad-invalid");
  }
  if (!triad && CURRENT_VIEW.triad) triad = CURRENT_VIEW.triad;

  const selectionRaw = body.selection ?? body.selectedPair ?? null;
  const selectionNormalized =
    selectionRaw === null || selectionRaw === undefined
      ? null
      : String(selectionRaw).trim().toLowerCase();
  const selectionFromBody =
    selectionNormalized && VALID_SELECTIONS.has(selectionNormalized)
      ? selectionNormalized
      : null;
  if (selectionNormalized && !selectionFromBody) {
    errors.push("selection-invalid");
  }

  const pairRaw = body.pair ?? null;
  const pairFromBody = normalisePair(pairRaw);
  if (
    pairRaw !== null &&
    pairRaw !== undefined &&
    String(pairRaw).trim() &&
    !pairFromBody
  ) {
    errors.push("pair-invalid");
  }

  let labelsJson = null;
  const labelsRaw = body.labels_json ?? body.labelsJson ?? null;
  if (labelsRaw && typeof labelsRaw === "object") {
    const labels = {
      a: cleanLabel(labelsRaw.a ?? ""),
      b: cleanLabel(labelsRaw.b ?? ""),
      c: cleanLabel(labelsRaw.c ?? ""),
      ab: cleanLabel(labelsRaw.ab ?? ""),
      ac: cleanLabel(labelsRaw.ac ?? ""),
      bc: cleanLabel(labelsRaw.bc ?? ""),
    };
    if (Object.values(labels).some((value) => value)) {
      labelsJson = labels;
    }
  } else if (labelsRaw) {
    errors.push("labels-json-invalid");
  }

  const oddRaw = body.odd ?? null;
  const oddNormalized =
    oddRaw === null || oddRaw === undefined ? null : String(oddRaw).trim();
  let odd =
    oddNormalized && allowedOdd.has(oddNormalized.toLowerCase())
      ? oddNormalized.toLowerCase()
      : null;
  if (oddNormalized && !odd) errors.push("odd-invalid");

  let pairForLog =
    pairFromBody ??
    (selectionFromBody && VALID_PAIR_SELECTIONS.has(selectionFromBody)
      ? selectionFromBody
      : null);
  if (
    !pairForLog &&
    pairRaw === null &&
    (selectionRaw === null || selectionRaw === undefined) &&
    CURRENT_VIEW.selection
  ) {
    pairForLog = normalisePair(CURRENT_VIEW.selection);
  }

  if (!odd) odd = deriveOddFromPair(pairForLog);

  const label1 = cleanLabel(body.label1 ?? body.pair_label ?? body.pairLabel);
  const label2 = cleanLabel(body.label2 ?? body.odd_label ?? body.oddLabel);
  const notes = cleanLabel(body.notes ?? body.note);

  const selectionForLog = labelsJson
    ? (selectionFromBody ?? "override")
    : (pairForLog ?? (selectionFromBody === "override" ? "override" : null));

  const displayEventIdRaw =
    body.display_event_id ?? body.displayEventId ?? CURRENT_VIEW.displayEventId;
  const parsedDisplayEventId = Number.parseInt(
    String(displayEventIdRaw ?? ""),
    10,
  );
  let displayEventId =
    Number.isFinite(parsedDisplayEventId) && parsedDisplayEventId > 0
      ? parsedDisplayEventId
      : null;
  let linkStatus = "unlinked";
  let linkNote = null;
  let linkedDisplayEvent = null;

  if (displayEventId !== null) {
    linkedDisplayEvent = await getDisplayEventById(DB_FILE, displayEventId);
    if (!linkedDisplayEvent) {
      linkStatus = "unlinked";
      linkNote = "display-event-missing";
      errors.push("display-event-missing");
      displayEventId = null;
    } else if (
      linkedDisplayEvent.session_id !== null &&
      SESSION_ID !== null &&
      Number(linkedDisplayEvent.session_id) !== Number(SESSION_ID)
    ) {
      linkStatus = "unlinked";
      linkNote = "display-event-session-mismatch";
      errors.push("display-event-session-mismatch");
      displayEventId = null;
      linkedDisplayEvent = null;
    } else {
      linkStatus =
        displayEventIdRaw === null || displayEventIdRaw === undefined
          ? "last-view"
          : "linked";
    }
  }

  if (!triad && linkedDisplayEvent) {
    triad = {
      a: linkedDisplayEvent.triad_a ?? "",
      b: linkedDisplayEvent.triad_b ?? "",
      c: linkedDisplayEvent.triad_c ?? "",
    };
  }

  if (
    linkedDisplayEvent &&
    pairForLog &&
    linkedDisplayEvent.selection &&
    pairForLog !== linkedDisplayEvent.selection
  ) {
    errors.push("display-selection-mismatch");
    linkNote = linkNote
      ? `${linkNote};display-selection-mismatch`
      : "display-selection-mismatch";
  }

  const submissionMode = labelsJson ? "override" : "current-view";
  const inputStartedAtRaw =
    body.input_started_at ?? body.inputStartedAt ?? body.input_started ?? null;
  const inputStartedAt = inputStartedAtRaw ? String(inputStartedAtRaw) : null;
  const triadIdRaw =
    body.triad_id ??
    body.triadId ??
    linkedDisplayEvent?.triad_id ??
    CURRENT_VIEW.triadId;
  const parsedTriadId = Number.parseInt(String(triadIdRaw ?? ""), 10);
  const triadId =
    Number.isFinite(parsedTriadId) && parsedTriadId > 0 ? parsedTriadId : null;

  await logAnnotationSubmission({
    dbFile: DB_FILE,
    sessionId: SESSION_ID,
    submissionMode,
    inputStartedAt,
    submittedAt: new Date().toISOString(),
    displayEventId,
    triadId,
    triad,
    selection: selectionForLog,
    odd,
    label1: label1 || null,
    label2: label2 || null,
    notes: notes || null,
    pair: pairForLog,
    pairLabel: label1 || null,
    oddLabel: label2 || null,
    labels: labelsJson,
    linkStatus,
    linkNote,
    source: body.source ?? "assistant-ui",
    rawInput: body,
    errors,
  });

  await logAnnotationEvent({
    dbFile: DB_FILE,
    sessionId: SESSION_ID,
    triad,
    selection: selectionForLog,
    pairLabel: label1 || null,
    odd,
    oddLabel: label2 || null,
    labelsJson: labelsJson
      ? {
          a: cleanLabel(labelsJson.a ?? ""),
          b: cleanLabel(labelsJson.b ?? ""),
          c: cleanLabel(labelsJson.c ?? ""),
          ab: cleanLabel(labelsJson.ab ?? ""),
          ac: cleanLabel(labelsJson.ac ?? ""),
          bc: cleanLabel(labelsJson.bc ?? ""),
        }
      : null,
    rawInput: body,
    source: body.source ?? "assistant-ui",
    errors,
  });

  res.json({ ok: true });
});

app.get("/display/now", (_req, res) => {
  res.json(buildCurrentViewPayload());
});

app.get("/display/history", async (req, res) => {
  const parsedLimit = Number.parseInt(String(req.query.limit ?? "200"), 10);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 1000)
      : 200;
  const rows = await listDisplayEventsBySession(DB_FILE, SESSION_ID, limit);
  const events = rows.map((row) => {
    const triad = {
      a: row.triad_a ?? "",
      b: row.triad_b ?? "",
      c: row.triad_c ?? "",
    };
    const triadComplete = triad.a && triad.b && triad.c;
    return {
      id: row.id,
      ts: row.ts,
      triad_id: row.triad_id ?? null,
      triad: triadComplete ? triad : null,
      triad_images: triadComplete ? resolveTriadImageMap(triad) : null,
      selection: row.selection ?? null,
      reason: row.reason ?? null,
    };
  });

  res.json({
    session_id: SESSION_ID,
    current_display_event_id: CURRENT_VIEW.displayEventId,
    events,
  });
});

app.get("/api/constructs", async (req, res) => {
  const limit = parseLimitedPositiveInt(req.query.limit, 200, 1000);
  const parsedViewerSessionId = Number.parseInt(
    String(req.query.viewer_session_id ?? SESSION_ID ?? ""),
    10,
  );
  const viewerSessionId =
    Number.isFinite(parsedViewerSessionId) && parsedViewerSessionId > 0
      ? parsedViewerSessionId
      : null;
  const { sessionIds } = resolveSessionScope({
    values: [req.query.session, req.query.session_id],
    defaultSessionId: SESSION_ID,
  });

  const rows = await listConstructs({
    dbFile: DB_FILE,
    sessionIds,
    viewerSessionId,
    limit,
  });

  const constructs = rows.map(toConstructPayload);

  res.json({
    session_id:
      Array.isArray(sessionIds) && sessionIds.length === 1
        ? sessionIds[0]
        : null,
    session_ids: Array.isArray(sessionIds) ? sessionIds : null,
    viewer_session_id: viewerSessionId,
    limit,
    count: constructs.length,
    constructs,
  });
});

app.post("/api/constructs/sync", async (req, res) => {
  const body = req.body ?? {};
  const limit = parseLimitedPositiveInt(
    body.limit ?? req.query.limit,
    1000,
    10000,
  );
  const { sessionIds } = resolveSessionScope({
    values: [
      body.session_ids,
      body.session,
      body.session_id,
      req.query.session,
      req.query.session_id,
    ],
    defaultSessionId: SESSION_ID,
  });

  const syncResult = await syncConstructsFromAnnotations({
    dbFile: DB_FILE,
    sessionIds,
    limit,
  });

  res.json({
    ok: true,
    limit,
    inserted: syncResult.inserted,
    scanned: syncResult.scanned,
    session_id:
      Array.isArray(syncResult.session_ids) &&
      syncResult.session_ids.length === 1
        ? syncResult.session_ids[0]
        : null,
    session_ids: syncResult.session_ids,
  });
});

app.post("/api/constructs", async (req, res) => {
  const body = req.body ?? {};
  const label1 = cleanLabel(body.label1 ?? body.positive_label);
  const label2 = cleanLabel(body.label2 ?? body.negative_label);
  if (!label1 || !label2) {
    return res.status(400).json({
      ok: false,
      error: "invalid-labels",
    });
  }

  const createdFromConstructIdRaw =
    body.created_from_construct_id ?? body.createdFromConstructId ?? null;
  const parsedCreatedFrom = Number.parseInt(
    String(createdFromConstructIdRaw ?? ""),
    10,
  );
  const createdFromConstructId =
    Number.isFinite(parsedCreatedFrom) && parsedCreatedFrom > 0
      ? parsedCreatedFrom
      : null;

  const originSessionIdRaw =
    body.origin_session_id ?? body.originSessionId ?? SESSION_ID ?? null;
  const parsedOriginSessionId = Number.parseInt(
    String(originSessionIdRaw ?? ""),
    10,
  );
  const originSessionId =
    Number.isFinite(parsedOriginSessionId) && parsedOriginSessionId > 0
      ? parsedOriginSessionId
      : null;

  const requestedOriginType = String(body.origin_type ?? body.originType ?? "")
    .trim()
    .toLowerCase();
  const originType =
    requestedOriginType === "derived" ||
    (createdFromConstructId !== null && requestedOriginType !== "manual")
      ? "derived"
      : "manual";

  const row = await createConstruct({
    dbFile: DB_FILE,
    label1,
    label2,
    originType,
    originSessionId,
    createdFromConstructId,
  });

  if (!row) {
    return res.status(400).json({
      ok: false,
      error: "create-failed",
    });
  }

  return res.json({
    ok: true,
    construct: toConstructPayload(row),
  });
});

app.post("/api/constructs/:id/vote", async (req, res) => {
  const constructId = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(constructId) || constructId <= 0) {
    return res.status(400).json({
      ok: false,
      error: "invalid-construct-id",
    });
  }

  const currentSessionId = Number.parseInt(String(SESSION_ID ?? ""), 10);
  if (!Number.isFinite(currentSessionId) || currentSessionId <= 0) {
    return res.status(400).json({
      ok: false,
      error: "invalid-session-id",
    });
  }

  const body = req.body ?? {};
  const voteRaw = Number(body.vote_delta ?? body.vote ?? body.delta ?? 0);
  const voteDelta = voteRaw < 0 ? -1 : 1;
  const sourceRaw = String(body.source ?? "manual")
    .trim()
    .toLowerCase();
  const source = sourceRaw === "inferred" ? "inferred" : "manual";
  const noteRaw = body.note ?? null;
  const note =
    noteRaw === null || noteRaw === undefined ? null : String(noteRaw).trim();

  const voteResult = await logConstructVoteEvent({
    dbFile: DB_FILE,
    constructId,
    sessionId: currentSessionId,
    voteDelta,
    source,
    note: note || null,
  });

  if (!voteResult) {
    return res.status(404).json({
      ok: false,
      error: "construct-not-found",
    });
  }

  return res.json({
    ok: true,
    construct_id: constructId,
    session_id: currentSessionId,
    vote_event_id: voteResult.id,
    vote_delta: voteDelta,
    vote_score: voteResult.score,
  });
});

app.post("/api/constructs/:id/hide", async (req, res) => {
  const constructId = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(constructId) || constructId <= 0) {
    return res.status(400).json({
      ok: false,
      error: "invalid-construct-id",
    });
  }

  const currentSessionId = Number.parseInt(String(SESSION_ID ?? ""), 10);
  if (!Number.isFinite(currentSessionId) || currentSessionId <= 0) {
    return res.status(400).json({
      ok: false,
      error: "invalid-session-id",
    });
  }

  const body = req.body ?? {};
  const sourceRaw = String(body.source ?? "manual")
    .trim()
    .toLowerCase();
  const source = sourceRaw === "inferred" ? "inferred" : "manual";
  const noteRaw = body.note ?? null;
  const note =
    noteRaw === null || noteRaw === undefined ? null : String(noteRaw).trim();

  const eventId = await logConstructVisibilityEvent({
    dbFile: DB_FILE,
    constructId,
    sessionId: currentSessionId,
    visibility: "hidden",
    source,
    note: note || null,
  });

  if (!eventId) {
    return res.status(404).json({
      ok: false,
      error: "construct-not-found",
    });
  }

  return res.json({
    ok: true,
    construct_id: constructId,
    session_id: currentSessionId,
    visibility_event_id: eventId,
    visibility: "hidden",
  });
});

app.post("/api/constructs/:id/polarity", async (req, res) => {
  const constructId = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isFinite(constructId) || constructId <= 0) {
    return res.status(400).json({
      ok: false,
      error: "invalid-construct-id",
    });
  }

  const body = req.body ?? {};
  const label1Polarity = normalisePolarity(
    body.label1_polarity ?? body.label1Polarity,
  );
  const label2Polarity = normalisePolarity(
    body.label2_polarity ?? body.label2Polarity,
  );
  const sourceRaw = String(body.source ?? "manual")
    .trim()
    .toLowerCase();
  const source = sourceRaw === "inferred" ? "inferred" : "manual";
  const noteRaw = body.note ?? null;
  const note =
    noteRaw === null || noteRaw === undefined ? null : String(noteRaw).trim();

  const eventId = await logConstructPolarityEvent({
    dbFile: DB_FILE,
    constructId,
    label1Polarity,
    label2Polarity,
    source,
    note: note || null,
  });

  if (!eventId) {
    return res.status(404).json({
      ok: false,
      error: "construct-not-found",
    });
  }

  return res.json({
    ok: true,
    construct_id: constructId,
    polarity_event_id: eventId,
    label1_polarity: label1Polarity,
    label2_polarity: label2Polarity,
    source,
  });
});

app.get("/status/now", (_req, res) => {
  res.json({
    session_id: SESSION_ID,
    has_active_display: Boolean(CURRENT_VIEW.triad),
    triad_id: CURRENT_VIEW.triadId,
    display_event_id: CURRENT_VIEW.displayEventId,
  });
});

// --- Startup ----------------------------------------------------------------
async function main() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  await initDb(DB_FILE);
  SESSION_ID = await createSession(DB_FILE);
  if (SESSION_ID !== null) console.log(`Session ID: ${SESSION_ID}`);

  app.listen(PORT, HOST, () => {
    console.log(`Triadic app listening on http://${HOST}:${PORT}/display`);
    if (HOST === "0.0.0.0" || HOST === "::") {
      const nets = os.networkInterfaces();
      const candidates = [];
      for (const net of Object.values(nets)) {
        for (const addr of net ?? []) {
          if (addr.internal) continue;
          if (addr.family === "IPv4" || addr.family === 4) {
            candidates.push(addr.address);
          }
        }
      }
      if (candidates.length) {
        console.log("LAN access:");
        candidates.forEach((ip) =>
          console.log(`  http://${ip}:${PORT}/display`),
        );
      }
    }
    console.log(`IMAGES_DIR=${IMAGES_DIR}`);
  });
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
