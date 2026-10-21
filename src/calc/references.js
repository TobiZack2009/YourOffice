/**
 * A1-style reference utilities (spec §6.4).
 *
 * A reference is stored as a plain struct so absolute/mixed markers survive
 * round-trips and later copy/fill operations. Parsing accepts only what Excel
 * accepts for the classic A1 form; everything else returns null.
 *
 *   A1    → { col: 1, row: 1, absCol: false, absRow: false }
 *   $A1   → absolute column
 *   A$1   → absolute row
 *   $A$1  → both absolute
 */

export const MAX_COLUMN = 16384; // XFD
export const MAX_ROW = 1048576;

/**
 * @typedef {object} CellRef
 * @property {number} col 1-based column index.
 * @property {number} row 1-based row index.
 * @property {boolean} absCol
 * @property {boolean} absRow
 */

const A1_PATTERN = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/;
const KEY_PATTERN = /^([0-9]+),([0-9]+)$/;

/**
 * Convert column letters to a 1-based index. "A" → 1, "Z" → 26, "AA" → 27.
 * @param {string} letters
 * @returns {number | null}
 */
export function columnToIndex(letters) {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return null;
  let index = 0;
  for (const upper of letters.toUpperCase()) {
    index = index * 26 + (upper.charCodeAt(0) - 64);
  }
  return index >= 1 && index <= MAX_COLUMN ? index : null;
}

/**
 * Convert a 1-based column index to letters. 1 → "A", 27 → "AA".
 * @param {number} index
 * @returns {string}
 */
export function indexToColumn(index) {
  let remaining = index;
  let letters = "";
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return letters;
}

/**
 * Parse A1 text into a CellRef.
 * @param {string} text
 * @returns {CellRef | null}
 */
export function parseA1(text) {
  const match = A1_PATTERN.exec(text);
  if (!match) return null;
  const col = columnToIndex(match[2]);
  const row = Number(match[4]);
  if (col === null || row < 1 || row > MAX_ROW) return null;
  return { col, row, absCol: match[1] === "$", absRow: match[3] === "$" };
}

/**
 * Format a CellRef as A1 text.
 * @param {{ col: number, row: number, absCol?: boolean, absRow?: boolean }} ref
 * @returns {string}
 */
export function formatA1(ref) {
  return `${ref.absCol ? "$" : ""}${indexToColumn(ref.col)}${ref.absRow ? "$" : ""}${ref.row}`;
}

/**
 * Stable map key for a cell position. Absolute markers are ignored: a reference
 * *target* is a position, not a syntax.
 * A position may carry a `scope` (a table id) when one engine holds several tables.
 * @param {{ col: number, row: number, scope?: string }} ref
 * @returns {string} e.g. "3,12" or "tbl_1|3,12"
 */
export function refKey(ref) {
  return ref.scope ? `${ref.scope}|${ref.col},${ref.row}` : `${ref.col},${ref.row}`;
}

/**
 * Inverse of refKey.
 * @param {string} key
 * @returns {{ col: number, row: number } | null}
 */
export function keyToRef(key) {
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  return { col: Number(match[1]), row: Number(match[2]) };
}

/**
 * Whether two positions are the same cell.
 * @param {{ col: number, row: number }} a
 * @param {{ col: number, row: number }} b
 * @returns {boolean}
 */
export function sameCell(a, b) {
  return a.col === b.col && a.row === b.row;
}

/**
 * Normalised inclusive rectangle from two corners.
 * @param {{ col: number, row: number }} a
 * @param {{ col: number, row: number }} b
 * @returns {{ start: { col: number, row: number }, end: { col: number, row: number } }}
 */
export function normaliseRange(a, b) {
  return {
    start: { col: Math.min(a.col, b.col), row: Math.min(a.row, b.row) },
    end: { col: Math.max(a.col, b.col), row: Math.max(a.row, b.row) }
  };
}

/**
 * Whether a position falls inside an inclusive rectangle.
 * @param {{ col: number, row: number }} cell
 * @param {{ col: number, row: number }} start
 * @param {{ col: number, row: number }} end
 * @returns {boolean}
 */
export function rangeContains(cell, start, end) {
  return (
    cell.col >= start.col &&
    cell.col <= end.col &&
    cell.row >= start.row &&
    cell.row <= end.row
  );
}
