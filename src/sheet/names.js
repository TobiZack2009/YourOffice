/**
 * Name syntax shared by the formula language and the things it names (tables,
 * sections, pages). Pure and dependency-light.
 *
 * A name is written bare when it is a plain word (`Expenses`, `q3.total`) and in
 * single quotes otherwise (`'Q3 Budget'`, with `''` for a literal quote).
 * A name may not be mistaken for something else the parser reads first: a cell
 * reference (`A1`), a boolean, or a function name followed by `(`.
 */

import { parseA1 } from "./references.js";
import { functions, EMBED_ONLY_FUNCTIONS } from "./functions.js";

/** Bare words the parser accepts as a name. */
export const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * Whether `name` can be written without quotes.
 * @param {string} name
 * @returns {boolean}
 */
export function isPlainName(name) {
  return PLAIN_NAME.test(name) && !parseA1(name) && !/^(TRUE|FALSE)$/i.test(name);
}

/**
 * Source text for a name: bare when possible, else single-quoted.
 * @param {string} name
 * @returns {string}
 */
export function formatName(name) {
  return isPlainName(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/**
 * Why `name` cannot be used as the name of a table or section, or null when it is fine.
 * @param {string} name
 * @returns {string | null}
 */
export function nameProblem(name) {
  const text = typeof name === "string" ? name : "";
  if (text.trim() === "") return "A name cannot be empty.";
  if (text !== text.trim()) return "A name cannot start or end with a space.";
  if (/[\u0000-\u001f]/.test(text)) return "A name cannot contain control characters.";
  if (parseA1(text)) return `"${text}" looks like a cell reference.`;
  if (/^(TRUE|FALSE)$/i.test(text)) return `"${text}" is a reserved word.`;
  const call = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(text);
  if (call) {
    const fn = call[1].toUpperCase();
    if (functions[fn] || EMBED_ONLY_FUNCTIONS.includes(fn) || fn === "IF") {
      return `"${text}" would be read as a call to ${fn}.`;
    }
  }
  return null;
}

/**
 * Name comparison is case-insensitive, like Excel.
 * @param {string} name
 * @returns {string}
 */
export function nameKey(name) {
  return name.trim().toLowerCase();
}
