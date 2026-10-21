/** Pure helpers over inline runs for the block editor. */

import { mergeRuns } from "./inline.js";

/** @typedef {import("../document/model.js").InlineRun} InlineRun */

/**
 * Split runs at a plain-text offset, keeping marks on both halves.
 * @param {InlineRun[]} runs
 * @param {number} offset
 * @returns {{ left: InlineRun[], right: InlineRun[] }}
 */
export function splitRunsAt(runs, offset) {
  /** @type {InlineRun[]} */
  const left = [];
  /** @type {InlineRun[]} */
  const right = [];
  let consumed = 0;
  for (const run of runs) {
    const end = consumed + run.text.length;
    if (end <= offset) {
      left.push(run);
    } else if (consumed >= offset) {
      right.push(run);
    } else {
      const local = offset - consumed;
      const before = run.text.slice(0, local);
      const after = run.text.slice(local);
      if (before) left.push(run.marks ? { text: before, marks: { ...run.marks } } : { text: before });
      if (after) right.push(run.marks ? { text: after, marks: { ...run.marks } } : { text: after });
    }
    consumed = end;
  }
  return { left: mergeRuns(left), right: mergeRuns(right) };
}

/**
 * @param {InlineRun[]} runs
 * @returns {boolean} True when nothing readable and no reference is in the runs.
 */
export function isBlankRuns(runs) {
  return runs.every((run) => !run.ref && run.text.trim().length === 0);
}

/**
 * @param {InlineRun[]} runs
 * @returns {number} Length as caret offsets count it (a reference is one character).
 */
export function runLength(runs) {
  return runs.reduce((total, run) => total + run.text.length, 0);
}
