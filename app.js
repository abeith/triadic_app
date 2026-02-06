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
} =
  await optionalImport(
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
    CURRENT_VIEW = {
      triad: queryTriad,
      selection: null,
      displayEventId,
    };
  } else {
    CURRENT_VIEW = {
      triad: null,
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

app.post("/display/log", async (req, res) => {
  const body = req.body ?? {};
  const triad = body.triad ?? null;
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

  const validSelection =
    selectedPair && ["ab", "ac", "bc"].includes(String(selectedPair))
      ? String(selectedPair)
      : null;
  const displayEventId = await createDisplayEvent({
    dbFile: DB_FILE,
    sessionId: SESSION_ID,
    triad,
    selection: validSelection,
    reason: selectedPair ? "selection-change" : "selection-clear",
    stateEventId,
  });

  if (
    triad &&
    CURRENT_VIEW.triad &&
    triad.a === CURRENT_VIEW.triad.a &&
    triad.b === CURRENT_VIEW.triad.b &&
    triad.c === CURRENT_VIEW.triad.c
  ) {
    CURRENT_VIEW.selection = validSelection;
    CURRENT_VIEW.displayEventId = displayEventId;
  }

  res.json({ ok: true });
});

const cleanLabel = (value) => {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text || "";
};

app.post("/annotate/log", async (req, res) => {
  const body = req.body ?? {};
  const errors = [];
  const allowedSelections = new Set(["ab", "ac", "bc", "override"]);
  const allowedOdd = new Set(["a", "b", "c"]);

  let triad = null;
  if (body.triad && typeof body.triad === "object") {
    triad = {
      a: body.triad.a ? String(body.triad.a) : "",
      b: body.triad.b ? String(body.triad.b) : "",
      c: body.triad.c ? String(body.triad.c) : "",
    };
    if (!triad.a || !triad.b || !triad.c) {
      errors.push("triad-incomplete");
    }
  } else if (body.triad) {
    errors.push("triad-invalid");
  } else if (CURRENT_VIEW.triad) {
    triad = CURRENT_VIEW.triad;
  }

  const selectionRaw = body.selection ?? body.pair ?? body.selectedPair ?? null;
  const selectionNormalized =
    selectionRaw === null || selectionRaw === undefined
      ? null
      : String(selectionRaw).trim().toLowerCase();
  const selectionFromBody =
    selectionNormalized && allowedSelections.has(selectionNormalized)
      ? selectionNormalized
      : null;
  if (selectionNormalized && !selectionFromBody) {
    errors.push("selection-invalid");
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
  if (!odd && selectionFromBody !== "override" && !labelsJson) {
    const selectionForOdd =
      selectionRaw === null || selectionRaw === undefined
        ? CURRENT_VIEW.selection
        : selectionFromBody;
    if (selectionForOdd === "ab") odd = "c";
    if (selectionForOdd === "ac") odd = "b";
    if (selectionForOdd === "bc") odd = "a";
  }

  const pairLabel = cleanLabel(body.pair_label ?? body.pairLabel ?? "");
  const oddLabel = cleanLabel(body.odd_label ?? body.oddLabel ?? "");

  const selectionForLog = labelsJson
    ? selectionFromBody ?? "override"
    : selectionRaw === null || selectionRaw === undefined
      ? CURRENT_VIEW.selection ?? null
      : selectionFromBody;

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
    selectionForLog &&
    selectionForLog !== "override" &&
    linkedDisplayEvent.selection &&
    selectionForLog !== linkedDisplayEvent.selection
  ) {
    errors.push("display-selection-mismatch");
    linkNote = linkNote ? `${linkNote};display-selection-mismatch` : "display-selection-mismatch";
  }

  const submissionMode = labelsJson ? "override" : "current-view";
  const inputStartedAtRaw =
    body.input_started_at ?? body.inputStartedAt ?? body.input_started ?? null;
  const inputStartedAt = inputStartedAtRaw
    ? String(inputStartedAtRaw)
    : null;

  await logAnnotationSubmission({
    dbFile: DB_FILE,
    sessionId: SESSION_ID,
    submissionMode,
    inputStartedAt,
    submittedAt: new Date().toISOString(),
    displayEventId,
    triad,
    selection: selectionForLog,
    odd,
    pairLabel,
    oddLabel,
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
    pairLabel: cleanLabel(pairLabel),
    odd,
    oddLabel: cleanLabel(oddLabel),
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
  res.json({
    triad: CURRENT_VIEW.triad,
    selection: CURRENT_VIEW.selection,
    display_event_id: CURRENT_VIEW.displayEventId,
    session_id: SESSION_ID,
  });
});

app.get("/status/now", (_req, res) => {
  res.json({
    session_id: SESSION_ID,
    has_active_display: Boolean(CURRENT_VIEW.triad),
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
          console.log(`  http://${ip}:${PORT}/display`)
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
