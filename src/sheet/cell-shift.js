/**
 * Shifting part of a table (right-click "insert cells" / "delete cells").
 *
 * Unlike a whole-row insert, only a *band* of the table moves: inserting cells
 * shifting down moves just the columns of the selected range, and everything
 * from the range's top row down in those columns. Cells keep their contents
 * as they are, and every formula in the table that points into the moving band
 * is retargeted so it keeps following the cell it referred to (a formula that
 * itself moves keeps its text; its references are retargeted like any other).
 *
 * A region is described by the axis the cells slide along, where the slide
 * starts, how far, and the band of the other axis that takes part. Positions are
 * 0-based; A1 text is 1-based.
 */

import { MAX_COLUMN, MAX_ROW, formatA1, parseA1 } from "./references.js";
import { parseCellKey } from "./model.js";
import { tokenize } from "./tokenizer.js";

/** @typedef {import("./model.js").Cell} Cell */
/** @typedef {import("./model.js").Merge} Merge */

/**
 * @typedef {object} CellRegionShift
 * @property {"insert" | "delete"} mode Insert opens a gap; delete removes the range and closes it.
 * @property {"row" | "column"} axis The axis the cells slide along.
 * @property {number} index 0-based index on that axis where the gap starts.
 * @property {number} count Size of the gap.
 * @property {number} lo First index of the band on the other axis.
 * @property {number} hi Last index of the band on the other axis (inclusive).
 */

/**
 * Where an index on the sliding axis ends up, or null when it was deleted.
 * @param {number} index
 * @param {CellRegionShift} shift
 * @returns {number | null}
 */
function slideIndex(index, shift) {
  if (index < shift.index) return index;
  if (shift.mode === "insert") return index + shift.count;
  if (index < shift.index + shift.count) return null;
  return index - shift.count;
}

/**
 * New [start, end] of a span on the sliding axis, or null when it was deleted.
 * An insert inside a span grows it; a delete trims what was removed.
 * @param {number} start
 * @param {number} end
 * @param {CellRegionShift} shift
 * @returns {[number, number] | null}
 */
function slideSpan(start, end, shift) {
  const { index, count } = shift;
  if (shift.mode === "insert") {
    if (end < index) return [start, end];
    return [start >= index ? start + count : start, end + count];
  }
  const last = index + count - 1;
  if (end < index) return [start, end];
  if (start > last) return [start - count, end - count];
  if (start >= index && end <= last) return null;
  return [start < index ? start : index, end <= last ? index - 1 : end - count];
}

/**
 * @param {{ col: number, row: number }} position
 * @param {CellRegionShift} shift
 * @returns {boolean}
 */
function inBand(position, shift) {
  const cross = shift.axis === "row" ? position.col : position.row;
  return cross >= shift.lo && cross <= shift.hi;
}

/**
 * Where a cell at `position` ends up, or null when it falls in a deleted gap.
 * @param {{ col: number, row: number }} position
 * @param {CellRegionShift} shift
 * @returns {{ col: number, row: number } | null}
 */
export function shiftPosition(position, shift) {
  if (!inBand(position, shift)) return position;
  const moved = slideIndex(shift.axis === "row" ? position.row : position.col, shift);
  if (moved === null) return null;
  return shift.axis === "row" ? { col: position.col, row: moved } : { col: moved, row: position.row };
}

/**
 * Retarget the references in formula text. A lone reference follows its cell;
 * a range follows only when it sits wholly inside the band (a range that
 * straddles the band's edge is left alone, as spreadsheets do); a target that
 * was deleted becomes `#REF!`. Malformed text is returned unchanged.
 * @param {string} text Formula text (with or without "=").
 * @param {CellRegionShift} shift
 * @returns {string}
 */
export function shiftRegionReferences(text, shift) {
  const body = text.startsWith("=") ? text.slice(1) : text;
  let tokens;
  try {
    tokens = tokenize(text).filter((token) => token.type !== "eof");
  } catch {
    return text;
  }

  const rawOf = (/** @type {number} */ i) =>
    body.slice(tokens[i].pos, tokens[i + 1] ? tokens[i + 1].pos : body.length);
  const wordOf = (/** @type {number} */ i) => (typeof tokens[i].value === "string" ? tokens[i].value : "");
  const refAt = (/** @type {number} */ i) =>
    tokens[i] && tokens[i].type === "word" ? parseA1(wordOf(i)) : null;
  const toPosition = (/** @type {{ col: number, row: number }} */ ref) => ({ col: ref.col - 1, row: ref.row - 1 });
  const valid = (/** @type {{ col: number, row: number }} */ ref) =>
    ref.col >= 1 && ref.col <= MAX_COLUMN && ref.row >= 1 && ref.row <= MAX_ROW;

  let output = "=" + (tokens.length > 0 ? body.slice(0, tokens[0].pos) : "");
  for (let i = 0; i < tokens.length; i++) {
    const first = refAt(i);
    if (!first) {
      output += rawOf(i);
      continue;
    }

    // `A1:B2` — handle both ends together so the range keeps its shape.
    const second = tokens[i + 1]?.type === "colon" ? refAt(i + 2) : null;
    if (second) {
      const a = toPosition(first);
      const b = toPosition(second);
      const inside = inBand(a, shift) && inBand(b, shift);
      let replaced = null;
      if (inside) {
        const axisOf = (/** @type {{ col: number, row: number }} */ p) => (shift.axis === "row" ? p.row : p.col);
        const lo = Math.min(axisOf(a), axisOf(b));
        const hi = Math.max(axisOf(a), axisOf(b));
        const span = slideSpan(lo, hi, shift);
        if (!span) {
          output += "#REF!" + rawOf(i + 2).slice(wordOf(i + 2).length);
          i += 2;
          continue;
        }
        const reversed = axisOf(a) > axisOf(b);
        const [newLo, newHi] = span;
        const place = (/** @type {typeof first} */ ref, /** @type {number} */ value) =>
          shift.axis === "row" ? { ...ref, row: value + 1 } : { ...ref, col: value + 1 };
        replaced = [place(first, reversed ? newHi : newLo), place(second, reversed ? newLo : newHi)];
      }
      const [newFirst, newSecond] = replaced ?? [first, second];
      if (!valid(newFirst) || !valid(newSecond)) {
        output += "#REF!" + rawOf(i + 2).slice(wordOf(i + 2).length);
      } else {
        output +=
          (replaced ? formatA1(newFirst) : wordOf(i)) +
          rawOf(i).slice(wordOf(i).length) +
          rawOf(i + 1) +
          (replaced ? formatA1(newSecond) : wordOf(i + 2)) +
          rawOf(i + 2).slice(wordOf(i + 2).length);
      }
      i += 2;
      continue;
    }

    const moved = shiftPosition(toPosition(first), shift);
    const next = moved ? { ...first, col: moved.col + 1, row: moved.row + 1 } : null;
    output += (next && valid(next) ? formatA1(next) : "#REF!") + rawOf(i).slice(wordOf(i).length);
  }
  return output;
}

/**
 * Retarget the references in a formula that sits *outside* a block of cells
 * being moved, so it keeps pointing at the cells it referred to: a lone
 * reference into the block follows its cell by the move offset; a range follows
 * only when it lies wholly inside the block (one that straddles the edge is left
 * alone). Absolute markers do not exempt a reference, as with row/column edits.
 * A target pushed off the table becomes `#REF!`. Malformed text is unchanged.
 * @param {string} text Formula text (with or without "=").
 * @param {{ start: { col: number, row: number }, end: { col: number, row: number } }} block
 * @param {number} deltaCol
 * @param {number} deltaRow
 * @returns {string}
 */
export function retargetMovedReferences(text, block, deltaCol, deltaRow) {
  const body = text.startsWith("=") ? text.slice(1) : text;
  let tokens;
  try {
    tokens = tokenize(text).filter((token) => token.type !== "eof");
  } catch {
    return text;
  }

  const rawOf = (/** @type {number} */ i) =>
    body.slice(tokens[i].pos, tokens[i + 1] ? tokens[i + 1].pos : body.length);
  const wordOf = (/** @type {number} */ i) => (typeof tokens[i].value === "string" ? tokens[i].value : "");
  const refAt = (/** @type {number} */ i) =>
    tokens[i] && tokens[i].type === "word" ? parseA1(wordOf(i)) : null;
  const inBlock = (/** @type {{ col: number, row: number }} */ ref) =>
    ref.col - 1 >= block.start.col &&
    ref.col - 1 <= block.end.col &&
    ref.row - 1 >= block.start.row &&
    ref.row - 1 <= block.end.row;
  const moved = (/** @type {NonNullable<ReturnType<typeof parseA1>>} */ ref) => ({
    ...ref,
    col: ref.col + deltaCol,
    row: ref.row + deltaRow
  });
  const valid = (/** @type {{ col: number, row: number }} */ ref) =>
    ref.col >= 1 && ref.col <= MAX_COLUMN && ref.row >= 1 && ref.row <= MAX_ROW;

  let output = "=" + (tokens.length > 0 ? body.slice(0, tokens[0].pos) : "");
  for (let i = 0; i < tokens.length; i++) {
    const first = refAt(i);
    if (!first) {
      output += rawOf(i);
      continue;
    }
    const second = tokens[i + 1]?.type === "colon" ? refAt(i + 2) : null;
    if (second) {
      if (inBlock(first) && inBlock(second)) {
        const a = moved(first);
        const b = moved(second);
        output +=
          (valid(a) && valid(b)
            ? formatA1(a) + rawOf(i).slice(wordOf(i).length) + rawOf(i + 1) + formatA1(b)
            : "#REF!") + rawOf(i + 2).slice(wordOf(i + 2).length);
      } else {
        output += rawOf(i) + rawOf(i + 1) + rawOf(i + 2);
      }
      i += 2;
      continue;
    }
    if (!inBlock(first)) {
      output += rawOf(i);
      continue;
    }
    const next = moved(first);
    output += (valid(next) ? formatA1(next) : "#REF!") + rawOf(i).slice(wordOf(i).length);
  }
  return output;
}

/**
 * Apply a region shift to a sparse cell store: cells in the band slide, cells in
 * a deleted gap disappear, and every formula's references are retargeted.
 * @param {Record<string, Cell>} cells
 * @param {CellRegionShift} shift
 * @returns {Record<string, Cell>} A new sparse store.
 */
export function shiftRegionCells(cells, shift) {
  /** @type {Record<string, Cell>} */
  const next = {};
  for (const [key, cell] of Object.entries(cells)) {
    const position = parseCellKey(key);
    if (!position) continue;
    const moved = shiftPosition(position, shift);
    if (!moved) continue;
    next[`${moved.col},${moved.row}`] =
      typeof cell.formula === "string" ? { ...cell, formula: shiftRegionReferences(cell.formula, shift) } : { ...cell };
  }
  return next;
}

/**
 * Whether a merge sits in the way of a region shift (touches the band at or
 * beyond the gap), in which case shifting would tear it apart.
 * @param {Merge} merge
 * @param {CellRegionShift} shift
 * @returns {boolean}
 */
export function mergeBlocksShift(merge, shift) {
  const [crossStart, crossEnd] =
    shift.axis === "row" ? [merge.start.col, merge.end.col] : [merge.start.row, merge.end.row];
  const slideEnd = shift.axis === "row" ? merge.end.row : merge.end.col;
  return crossEnd >= shift.lo && crossStart <= shift.hi && slideEnd >= shift.index;
}
