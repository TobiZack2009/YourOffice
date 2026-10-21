/**
 * Reference scanning and text editing for formulas.
 *
 * Every rewrite in the sheet layer (row/column shifts, fills, moves, renames, page
 * moves) works on the user's formula *text*, token by token, so spacing, strings
 * and operators survive. This module is the shared machinery:
 *
 *   scanUnits(tokens)         group tokens into reference units:
 *                               address  `A1`, `A1:B2`, `Expenses!B2`, `Page!T!B2:C3`
 *                               name     `Summary`, `Page!Table`, `'Q3 Budget'!Notes`
 *   rewriteFormula(text, fn)  tokenize, let `fn` return edits, splice them in
 *
 * An edit replaces the source between two tokens (inclusive) with new text, so the
 * gaps between tokens are never touched.
 */

import { tokenize, formulaBody } from "./tokenizer.js";
import { parseA1 } from "./references.js";

/** @typedef {import("./tokenizer.js").Token} Token */
/** @typedef {import("./references.js").CellRef} CellRef */

/**
 * @typedef {object} ReferenceUnit
 * @property {"address" | "name"} kind
 * @property {string[]} segments Qualifier names, outermost first (empty when unqualified).
 * @property {number[]} segmentTokens Token index of each segment.
 * @property {number} from First token index of the unit.
 * @property {number} to Last token index of the unit.
 * @property {CellRef | null} first First cell of the address (address units).
 * @property {number} firstToken Token index of `first`, or -1.
 * @property {CellRef | null} second Second cell of a range, or null.
 * @property {number} secondToken Token index of `second`, or -1.
 */

/**
 * @typedef {object} Edit
 * @property {number} from First token index replaced.
 * @property {number} to Last token index replaced (inclusive).
 * @property {string} text Replacement source.
 */

/**
 * @param {Token | undefined} token
 * @returns {boolean}
 */
function isNameToken(token) {
  return !!token && (token.type === "word" || token.type === "qname");
}

/**
 * Group a token stream into reference units. Function names (a word followed by
 * `(`) are not units.
 * @param {Token[]} tokens Tokens without the trailing eof.
 * @returns {ReferenceUnit[]}
 */
export function scanUnits(tokens) {
  /** @type {ReferenceUnit[]} */
  const units = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!isNameToken(token)) {
      i += 1;
      continue;
    }
    if (token.type === "word" && tokens[i + 1]?.type === "lparen") {
      i += 1;
      continue;
    }

    /** @param {number} at @returns {CellRef | null} */
    const cellAt = (at) => (tokens[at]?.type === "word" ? parseA1(/** @type {string} */ (tokens[at].value)) : null);

    // Unqualified address: A1 or A1:B2.
    const lead = token.type === "word" ? parseA1(/** @type {string} */ (token.value)) : null;
    if (lead) {
      const second = tokens[i + 1]?.type === "colon" ? cellAt(i + 2) : null;
      units.push({
        kind: "address",
        segments: [],
        segmentTokens: [],
        from: i,
        to: second ? i + 2 : i,
        first: lead,
        firstToken: i,
        second,
        secondToken: second ? i + 2 : -1
      });
      i = second ? i + 3 : i + 1;
      continue;
    }

    // Path: name ("!" name)* ("!" address)?
    /** @type {string[]} */
    const segments = [/** @type {string} */ (token.value)];
    /** @type {number[]} */
    const segmentTokens = [i];
    let j = i + 1;
    /** @type {ReferenceUnit | null} */
    let unit = null;
    while (tokens[j]?.type === "bang") {
      const k = j + 1;
      const target = tokens[k];
      if (!isNameToken(target)) break;
      const address = target.type === "word" ? parseA1(/** @type {string} */ (target.value)) : null;
      if (address) {
        const second = tokens[k + 1]?.type === "colon" ? cellAt(k + 2) : null;
        unit = {
          kind: "address",
          segments,
          segmentTokens,
          from: i,
          to: second ? k + 2 : k,
          first: address,
          firstToken: k,
          second,
          secondToken: second ? k + 2 : -1
        };
        j = second ? k + 3 : k + 1;
        break;
      }
      segments.push(/** @type {string} */ (target.value));
      segmentTokens.push(k);
      j = k + 1;
    }
    units.push(
      unit ?? {
        kind: "name",
        segments,
        segmentTokens,
        from: i,
        to: j - 1,
        first: null,
        firstToken: -1,
        second: null,
        secondToken: -1
      }
    );
    i = j;
  }
  return units;
}

/**
 * Tokenize formula text and scan its units. Returns null for text that does not tokenize.
 * @param {string} text
 * @returns {{ body: string, tokens: Token[], units: ReferenceUnit[] } | null}
 */
export function analyzeFormula(text) {
  try {
    const tokens = tokenize(text).filter((token) => token.type !== "eof");
    return { body: formulaBody(text), tokens, units: scanUnits(tokens) };
  } catch {
    return null;
  }
}

/**
 * Splice edits into formula text. Edits must be sorted and non-overlapping.
 * @param {string} body Formula text without the leading "=".
 * @param {Token[]} tokens
 * @param {Edit[]} edits
 * @returns {string}
 */
export function applyEdits(body, tokens, edits) {
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    output += body.slice(cursor, tokens[edit.from].pos) + edit.text;
    cursor = tokens[edit.to].end;
  }
  return output + body.slice(cursor);
}

/**
 * Rewrite formula text. `makeEdits` sees the scanned formula and returns edits;
 * with none the original text comes back untouched (malformed text too).
 * Otherwise the result always carries a leading "=".
 * @param {string} text
 * @param {(scan: { body: string, tokens: Token[], units: ReferenceUnit[] }) => Edit[]} makeEdits
 * @returns {string}
 */
export function rewriteFormula(text, makeEdits) {
  const scan = analyzeFormula(text);
  if (!scan) return text;
  const edits = makeEdits(scan);
  if (edits.length === 0) return text;
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  return "=" + applyEdits(scan.body, scan.tokens, sorted);
}

/** Default target test: only unqualified references point into the table that owns the formula. */
export const isLocalReference = (/** @type {string[]} */ segments) => segments.length === 0;
