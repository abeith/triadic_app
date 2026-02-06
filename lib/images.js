// lib/images.js
// Image resolution utilities for triadic display
// ES module

import fs from "node:fs";
import path from "node:path";

/**
 * Resolve a single image identifier to a public-facing URL path.
 *
 * Assumptions (per app.js / README):
 * - Images are served statically from <project>/public
 * - imagesDir points to <project>/public/images
 * - Triad values (a, b, c) are image identifiers, typically basenames
 *
 * Resolution strategy:
 * 1. If the identifier starts with "/", treat it as an explicit URL path.
 * 2. If an extension is present, check that file directly.
 * 3. Otherwise, try common image extensions.
 * 4. If nothing resolves, return null.
 */
function resolveOneImage(id, { imagesDir }) {
  if (id === null || id === undefined) return null;

  const raw = typeof id === "string" ? id : String(id);
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Explicit public path (e.g. "/images/foo.jpg")
  if (trimmed.startsWith("/")) return trimmed;

  const candidates = [];
  const ext = path.extname(trimmed);
  const isDigits = /^\d+$/.test(trimmed);

  if (ext) {
    candidates.push(trimmed);
  } else {
    const bases = [trimmed];
    if (isDigits && trimmed.length < 4) {
      bases.push(trimmed.padStart(4, "0"));
    }
    if (isDigits && trimmed.length < 3) {
      bases.push(trimmed.padStart(3, "0"));
    }

    for (const base of bases) {
      candidates.push(
        `${base}.jpg`,
        `${base}.jpeg`,
        `${base}.png`,
        `${base}.webp`,
      );
    }
  }

  for (const rel of candidates) {
    const abs = path.join(imagesDir, rel);
    try {
      if (fs.existsSync(abs)) {
        // Public URL mirrors /public/images
        return path.posix.join("/images", rel);
      }
    } catch {
      // Ignore fs errors and continue
    }
  }

  return null;
}

/**
 * Resolve triad images for rendering.
 *
 * @param {{a?: string, b?: string, c?: string}} triad
 * @param {{ imagesDir: string }} options
 * @returns {{ a: string|null, b: string|null, c: string|null }}
 */
export function resolveTriadImages(triad, { imagesDir }) {
  const safeTriad = triad ?? {};

  return {
    a: resolveOneImage(safeTriad.a, { imagesDir }),
    b: resolveOneImage(safeTriad.b, { imagesDir }),
    c: resolveOneImage(safeTriad.c, { imagesDir }),
  };
}
