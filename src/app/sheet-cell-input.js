/**
 * Cell text <-> cell payload: what the formula bar shows and what a cell stores.
 */

/** @typedef {import("../calc/model.js").Cell} Cell */

/**
 * Turn formula-bar text into a cell payload (or null to clear).
 * Numeric-looking input becomes a number, "TRUE"/"FALSE" booleans, a leading "="
 * a formula, everything else text.
 * @param {string} raw
 * @returns {Cell | null}
 */
export function parseCellInput(raw) {
  if (raw === "") return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("=")) return { formula: raw };
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) return { value: Number(trimmed) };
  if (trimmed.toUpperCase() === "TRUE") return { value: true };
  if (trimmed.toUpperCase() === "FALSE") return { value: false };
  return { value: raw };
}

/**
 * Raw text shown in the formula bar for a cell.
 * @param {Cell | undefined} cell
 * @returns {string}
 */
export function rawCellText(cell) {
  if (!cell) return "";
  if (typeof cell.formula === "string") return cell.formula;
  if (cell.value === undefined || cell.value === null) return "";
  return String(cell.value);
}
