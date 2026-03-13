import fs from "node:fs";
import path from "node:path";

const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"];

function formatSnapshotStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    pad(date.getMilliseconds(), 3),
  ].join("");
}

function normalizeToken(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildSnapshotFilePath(dbFile, snapshotsDir, stamp, tokens) {
  const parsed = path.parse(dbFile);
  const suffix = tokens.length ? `-${tokens.join("-")}` : "";
  const ext = parsed.ext || ".db";
  return path.join(snapshotsDir, `${parsed.name}-${stamp}${suffix}${ext}`);
}

export function getDefaultSnapshotsDir(dbFile) {
  const absDbFile = path.resolve(dbFile);
  return path.join(path.dirname(absDbFile), "snapshots");
}

export function createDbSnapshot(params) {
  const { dbFile, reason = "snapshot", sessionId = null } = params ?? {};
  if (!dbFile) return null;

  const absDbFile = path.resolve(dbFile);
  if (!fs.existsSync(absDbFile)) return null;

  const snapshotsDir = path.resolve(getDefaultSnapshotsDir(absDbFile));
  fs.mkdirSync(snapshotsDir, { recursive: true });

  const tokens = [];
  const normalizedReason = normalizeToken(reason);
  if (normalizedReason) tokens.push(normalizedReason);

  const parsedSessionId = Number.parseInt(String(sessionId ?? ""), 10);
  if (Number.isFinite(parsedSessionId) && parsedSessionId > 0) {
    tokens.push(`session-${parsedSessionId}`);
  }

  const stamp = formatSnapshotStamp();
  const snapshotPath = buildSnapshotFilePath(
    absDbFile,
    snapshotsDir,
    stamp,
    tokens,
  );
  fs.copyFileSync(absDbFile, snapshotPath, fs.constants.COPYFILE_EXCL);

  const copiedSidecars = [];
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${absDbFile}${suffix}`;
    if (!fs.existsSync(sidecarPath)) continue;

    const snapshotSidecarPath = `${snapshotPath}${suffix}`;
    fs.copyFileSync(
      sidecarPath,
      snapshotSidecarPath,
      fs.constants.COPYFILE_EXCL,
    );
    copiedSidecars.push(snapshotSidecarPath);
  }

  return {
    path: snapshotPath,
    sidecars: copiedSidecars,
  };
}
