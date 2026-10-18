/**
 * Relative-reference offsetting for fill, copy and move (spec §6.4).
 *
 * When a formula is copied, filled or moved by `(dCol, dRow)` cells, every
 * *relative* reference moves by the same amount, so `=A1*2` filled one row down
 * becomes `=A2*2`. A `$` marker pins that axis: `$A1` keeps its column, `A$1`
 * its row, `$A$1` both. A reference pushed off the sheet becomes `#REF!`.
 *
 * Like `shift.js` this rewrites reference tokens only; the rest of the user's
 * formula text (spacing, strings, operators) is preserved verbatim.
 *
 * Positions in the model are 0-based; A1 text is 1-based. Offsets are in cells, so
 * the base does not matter here.
 */

import { MAX_COLUMN, MAX_ROW, formatA1, parseA1 } from "./references.js";
import { rewriteFormula } from "./refscan.js";

/** @typedef {import("./model.js").Cell} Cell */
/** @typedef {{ col: number, row: number }} Position */
/** @typedef {{ start: Position, end: Position }} CellRect */

/**
 * @param {string} text Formula text (with or without "=").
 * @param {number} deltaCol
 * @param {number} deltaRow
 * @param {{ target?: (segments: string[]) => boolean }} [options] Which references move (default: all, qualified or not).
 * @returns {string} The formula with relative references moved. Malformed text is returned unchanged.
 */
export function offsetFormulaReferences(text, deltaCol, deltaRow, options = {}) {
  if (deltaCol === 0 && deltaRow === 0) return text;
  const target = options.target ?? (() => true);
  return rewriteFormula(text, ({ units }) => {
    /** @type {import("./refscan.js").Edit[]} */
    const edits = [];
    for (const unit of units) {
      if (unit.kind !== "address" || !target(unit.segments)) continue;
      for (const [ref, index] of [[unit.first, unit.firstToken], [unit.second, unit.secondToken]]) {
        if (!ref) continue;
        const col = ref.absCol ? ref.col : ref.col + deltaCol;
        const row = ref.absRow ? ref.row : ref.row + deltaRow;
        if (col === ref.col && row === ref.row) continue;
        const inside = col >= 1 && col <= MAX_COLUMN && row >= 1 && row <= MAX_ROW;
        edits.push({
          from: /** @type {number} */ (index),
          to: /** @type {number} */ (index),
          text: inside ? formatA1({ ...ref, col, row }) : "#REF!"
        });
      }
    }
    return edits;
  });
}

/**
 * A copy of a cell as if it were moved by an offset: formulas have their
 * relative references moved, literals are copied as they are.
 * @param {Cell} cell
 * @param {number} deltaCol
 * @param {number} deltaRow
 * @returns {Cell}
 */
export function offsetCell(cell, deltaCol, deltaRow) {
  if (typeof cell.formula !== "string") return { ...cell };
  return { ...cell, formula: offsetFormulaReferences(cell.formula, deltaCol, deltaRow) };
}

/**
 * The source cell that fills a target position when a rectangular source is
 * tiled over a target area. The pattern is anchored at the source's top-left, so
 * positions inside the source map to themselves.
 * @param {CellRect} source
 * @param {Position} target
 * @returns {Position}
 */
export function tileSourceFor(source, target) {
  const width = source.end.col - source.start.col + 1;
  const height = source.end.row - source.start.row + 1;
  const wrap = (/** @type {number} */ value, /** @type {number} */ size) => ((value % size) + size) % size;
  return {
    col: source.start.col + wrap(target.col - source.start.col, width),
    row: source.start.row + wrap(target.row - source.start.row, height)
  };
}
