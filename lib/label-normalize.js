// Deterministic normalization rules for offline analysis/export workflows.
// Do not use these rules during ingest; raw labels remain source of truth.

export const LABEL_NORMALIZATION_VERSION = "v1-lower-trim-collapse-space";

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLabelForAnalysis(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim().replace(/\s+/g, " ").toLowerCase();
  return text || "";
}
