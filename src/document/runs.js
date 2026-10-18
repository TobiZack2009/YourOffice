/**
 * Pure helpers over inline runs that the command layer needs (the editor has its own
 * DOM-aware versions in `app/inline.js`).
 */

import { REF_CHAR } from "./model.js";

/** @typedef {import("./model.js").InlineRun} InlineRun */

/**
 * @param {InlineRun} run
 * @returns {boolean}
 */
export function isRefRun(run) {
  return run?.ref !== undefined;
}

/**
 * The text a person reads from runs: references contribute nothing.
 * @param {InlineRun[]} runs
 * @returns {string}
 */
export function plainTextOf(runs) {
  return runs.map((run) => (isRefRun(run) ? "" : run.text)).join("");
}

/**
 * Insert a run at a character offset, splitting the text run it lands in.
 * @param {InlineRun[]} runs
 * @param {number} offset Character offset (a reference counts as one character).
 * @param {InlineRun} insert
 * @returns {InlineRun[]} New runs; the input is not modified.
 */
export function insertRunAt(runs, offset, insert) {
  /** @type {InlineRun[]} */
  const out = [];
  let consumed = 0;
  let placed = false;
  for (const run of runs) {
    const end = consumed + run.text.length;
    if (!placed && offset <= consumed) {
      out.push(insert);
      placed = true;
    }
    if (!placed && offset < end && !isRefRun(run)) {
      const local = offset - consumed;
      out.push(copyWithText(run, run.text.slice(0, local)), insert, copyWithText(run, run.text.slice(local)));
      placed = true;
    } else {
      out.push(structuredClone(run));
    }
    consumed = end;
  }
  if (!placed) out.push(insert);
  return out;
}

/**
 * @param {InlineRun} run
 * @param {string} text
 * @returns {InlineRun}
 */
function copyWithText(run, text) {
  return run.marks ? { text, marks: { ...run.marks } } : { text };
}

export { REF_CHAR };
