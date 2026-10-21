/**
 * Row/column index shifting (spec §6.5: "update references correctly when rows or
 * columns are inserted or deleted").
 *
 * Inserting or deleting a row or column changes the *positions* of cells, so
 * every formula reference in the table has to move with them. References are
 * rewritten textually, token by token, so the user's formula text is preserved
 * apart from the reference tokens that actually change — never reparsed and
 * reformatted wholesale.
 *
 * Absolute markers (`$A$1`) do not protect a reference from an insert/delete:
 * Excel and Sheets shift them too, because the position itself moved. Markers
 * matter for copy/fill, not structural edits.
 *
 * Positions here are 0-based (matching the engine's keys); A1 text is 1-based.
 */

import { formatA1, parseA1 } from "../calc/references.js";
import { parseCellKey } from "../calc/model.js";
import { rewriteFormula, isLocalReference } from "../calc/refscan.js";

/** @typedef {import("../calc/references.js").CellRef} CellRef */
/** @typedef {import("../calc/model.js").Merge} Merge */

/**
 * @typedef {object} IndexShift
 * @property {"insert" | "delete"} mode
 * @property {"row" | "column"} axis
 * @property {number} index 0-based index the operation starts at.
 * @property {number} count Number of rows/columns affected.
 */

/**
 * Apply an index shift to a 1-based reference, or return null when the target
 * was deleted (`#REF!`).
 * @param {IndexShift} shift
 * @param {CellRef} ref
 * @returns {CellRef | null}
 */
export function shiftRef(shift, ref) {
  const isRow = shift.axis === "row";
  const position = isRow ? ref.row : ref.col;
  const start = shift.index + 1; // convert to 1-based
  const end = start + shift.count - 1;

  if (shift.mode === "insert") {
    if (position < start) return ref;
    const moved = position + shift.count;
    return isRow ? { ...ref, row: moved } : { ...ref, col: moved };
  }

  if (position < start) return ref;
  if (position <= end) return null; // the referenced line was deleted
  const moved = position - shift.count;
  return isRow ? { ...ref, row: moved } : { ...ref, col: moved };
}

/**
 * Rewrite the references in formula text according to an index shift.
 * Deleted targets become the `#REF!` error literal, exactly as Excel does.
 * Malformed formulas are returned unchanged. Only references that point into the
 * shifted table are touched: unqualified ones by default, or whatever
 * `options.target(segments)` accepts (cross-table formulas pass a predicate that
 * recognises `Expenses!B2` as pointing at the table being edited).
 *
 * @param {string} text Formula text, with or without a leading "=".
 * @param {IndexShift} shift
 * @param {{ target?: (segments: string[]) => boolean }} [options]
 * @returns {string}
 */
export function shiftFormulaReferences(text, shift, options = {}) {
  const target = options.target ?? isLocalReference;
  return rewriteFormula(text, ({ units }) => {
    /** @type {import("../calc/refscan.js").Edit[]} */
    const edits = [];
    for (const unit of units) {
      if (unit.kind !== "address" || !target(unit.segments)) continue;
      /** @type {import("../calc/refscan.js").Edit[]} */
      const unitEdits = [];
      for (const [ref, index] of [[unit.first, unit.firstToken], [unit.second, unit.secondToken]]) {
        if (!ref) continue;
        const moved = shiftRef(shift, /** @type {CellRef} */ (ref));
        if (moved && moved.col === ref.col && moved.row === ref.row) continue;
        unitEdits.push({
          from: /** @type {number} */ (index),
          to: /** @type {number} */ (index),
          text: moved ? formatA1(moved) : "#REF!"
        });
      }
      // A qualifier in front of an error literal would not parse: the whole unit goes.
      if (unit.segments.length > 0 && unitEdits.some((edit) => edit.text === "#REF!")) {
        edits.push({ from: unit.from, to: unit.to, text: "#REF!" });
      } else {
        edits.push(...unitEdits);
      }
    }
    return edits;
  });
}

/**
 * Shift the sparse cell store for an index operation.
 * @param {Record<string, import("../calc/model.js").Cell>} cells
 * @param {IndexShift} shift
 * @returns {Record<string, import("../calc/model.js").Cell>} A new sparse store.
 */
export function shiftCells(cells, shift) {
  /** @type {Record<string, import("../calc/model.js").Cell>} */
  const next = {};
  for (const [key, cell] of Object.entries(cells)) {
    const position = parseCellKey(key);
    if (!position) continue;
    const moved = shiftIndexPosition(position, shift);
    if (!moved) continue;
    next[`${moved.col},${moved.row}`] = shiftCellFormula(cell, shift);
  }
  return next;
}

/**
 * Shift the overrides map (`{"3": {height}}`) for an index operation.
 * @param {Record<string, Record<string, number>>} overrides
 * @param {IndexShift} shift
 * @returns {Record<string, Record<string, number>>}
 */
export function shiftOverrides(overrides, shift) {
  /** @type {Record<string, Record<string, number>>} */
  const next = {};
  for (const [key, override] of Object.entries(overrides)) {
    const index = Number(key);
    if (!Number.isInteger(index)) continue;
    const moved = shiftIndexValue(index, shift);
    if (moved === null) continue;
    next[String(moved)] = { ...override };
  }
  return next;
}

/**
 * Shift merged ranges for an index operation. Merges wholly inside a deleted
 * band are dropped; merges straddling it are clamped to what remains.
 * @param {Merge[]} merges
 * @param {IndexShift} shift
 * @returns {Merge[]}
 */
export function shiftMerges(merges, shift) {
  const isRow = shift.axis === "row";
  const start = shift.index;
  const end = shift.index + shift.count - 1;
  /** @type {Merge[]} */
  const next = [];

  for (const merge of merges) {
    const lo = isRow ? merge.start.row : merge.start.col;
    const hi = isRow ? merge.end.row : merge.end.col;
    const moveIndex = (value) => shiftIndexValue(value, shift);

    if (shift.mode === "insert") {
      const movedLo = lo >= start ? lo + shift.count : lo;
      const movedHi = hi >= start ? hi + shift.count : hi;
      next.push(rebuildMerge(merge, isRow, movedLo, movedHi));
      continue;
    }

    if (lo >= start && hi <= end) continue; // fully deleted
    if (hi < start) {
      next.push(cloneMerge(merge));
      continue;
    }
    if (lo > end) {
      next.push(rebuildMerge(merge, isRow, lo - shift.count, hi - shift.count));
      continue;
    }
    // Straddles the deleted band: clamp to the surviving span.
    const movedLo = lo < start ? lo : start;
    const movedHi = hi > end ? moveIndex(hi) : start - 1;
    if (movedHi === null || movedHi < movedLo) continue;
    next.push(rebuildMerge(merge, isRow, movedLo, movedHi));
  }

  return next;
}

/**
 * @param {Merge} merge
 * @param {boolean} isRow
 * @param {number} lo
 * @param {number} hi
 * @returns {Merge}
 */
function rebuildMerge(merge, isRow, lo, hi) {
  const clone = cloneMerge(merge);
  if (isRow) {
    clone.start.row = lo;
    clone.end.row = hi;
  } else {
    clone.start.col = lo;
    clone.end.col = hi;
  }
  return clone;
}

/**
 * @param {Merge} merge
 * @returns {Merge}
 */
function cloneMerge(merge) {
  return {
    start: { ...merge.start },
    end: { ...merge.end }
  };
}

/**
 * @param {{ col: number, row: number }} position
 * @param {IndexShift} shift
 * @returns {{ col: number, row: number } | null}
 */
function shiftIndexPosition(position, shift) {
  const moved = shiftIndexValue(shift.axis === "row" ? position.row : position.col, shift);
  if (moved === null) return null;
  return shift.axis === "row" ? { ...position, row: moved } : { ...position, col: moved };
}

/**
 * @param {number} index
 * @param {IndexShift} shift
 * @returns {number | null} null when the line was deleted.
 */
function shiftIndexValue(index, shift) {
  const { index: at, count, mode } = shift;
  if (index < at) return index;
  if (mode === "insert") return index + count;
  if (index < at + count) return null;
  return index - count;
}

/**
 * Formula text inside a shifted cell follows its new position.
 * @param {import("../calc/model.js").Cell} cell
 * @param {IndexShift} shift
 * @returns {import("../calc/model.js").Cell}
 */
function shiftCellFormula(cell, shift) {
  if (typeof cell.formula !== "string") return { ...cell };
  return { ...cell, formula: shiftFormulaReferences(cell.formula, shift) };
}
