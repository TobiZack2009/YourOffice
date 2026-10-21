/**
 * Built-in formula functions (spec §6.4 initial set).
 *
 * Functions receive already-evaluated arguments: scalars or arrays (resolved
 * ranges, row-major). Each function returns a value or a FormulaError.
 *
 * Range-vs-scalar argument rules follow Excel for the subset we implement:
 * numbers inside ranges count; text and booleans inside ranges are ignored by
 * SUM/AVERAGE/MIN/MAX; scalar text is coerced when numeric and is else an error.
 */

import { ERR, isFormulaError, withDetail } from "./errors.js";
import { toNumber, toText, toBoolean, formatNumber } from "./values.js";

/** @typedef {import("./values.js").Value} Value */
/** @typedef {import("./values.js").Scalar} Scalar */

/**
 * @typedef {object} FormulaFunction
 * @property {number} minArgs
 * @property {number} maxArgs
 * @property {(args: Value[]) => Value} fn
 */

/**
 * Collect the numbers a function should operate on, applying Excel coercion.
 * @param {Value[]} args
 * @returns {{ values: number[], error: import("./errors.js").FormulaError | null }}
 */
function collectNumbers(args) {
  /** @type {number[]} */
  const values = [];
  for (const arg of args) {
    if (isFormulaError(arg)) return { values, error: arg };
    if (Array.isArray(arg)) {
      for (const entry of arg) {
        if (isFormulaError(entry)) return { values, error: entry };
        if (typeof entry === "number") values.push(entry);
        // text, booleans and blanks inside ranges are ignored
      }
      continue;
    }
    if (arg === null) continue;
    if (typeof arg === "number") {
      values.push(arg);
    } else if (typeof arg === "boolean") {
      values.push(arg ? 1 : 0);
    } else if (typeof arg !== "string") {
      return { values, error: ERR.VALUE };
    } else {
      const text = arg.trim();
      if (text === "") return { values, error: ERR.VALUE };
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) return { values, error: ERR.VALUE };
      values.push(numeric);
    }
  }
  return { values, error: null };
}

/** @type {Record<string, FormulaFunction>} */
export const functions = {
  SUM: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const { values, error } = collectNumbers(args);
      if (error) return error;
      return values.reduce((total, value) => total + value, 0);
    }
  },

  AVERAGE: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const { values, error } = collectNumbers(args);
      if (error) return error;
      if (values.length === 0) return ERR.DIV0;
      return values.reduce((total, value) => total + value, 0) / values.length;
    }
  },

  MIN: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const { values, error } = collectNumbers(args);
      if (error) return error;
      return values.length === 0 ? 0 : Math.min(...values);
    }
  },

  MAX: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      const { values, error } = collectNumbers(args);
      if (error) return error;
      return values.length === 0 ? 0 : Math.max(...values);
    }
  },

  COUNT: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      let count = 0;
      for (const arg of args) {
        if (Array.isArray(arg)) {
          for (const entry of arg) {
            if (typeof entry === "number") count += 1;
          }
          continue;
        }
        if (isFormulaError(arg)) return arg;
        if (typeof arg === "number") count += 1;
        else if (typeof arg === "boolean") count += 1;
        else if (typeof arg === "string") {
          const text = arg.trim();
          if (text !== "" && Number.isFinite(Number(text))) count += 1;
        }
      }
      return count;
    }
  },

  CONCAT: {
    minArgs: 1,
    maxArgs: Infinity,
    fn: (args) => {
      let text = "";
      const append = (/** @type {Scalar} */ value) => {
        if (isFormulaError(value)) return value;
        if (value === null) return null;
        text += typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
        return null;
      };
      for (const arg of args) {
        const list = Array.isArray(arg) ? arg : [arg];
        for (const entry of list) {
          const failure = append(/** @type {Scalar} */ (entry));
          if (isFormulaError(failure)) return failure;
        }
      }
      return text;
    }
  },

  // -- logic ---------------------------------------------------------------------

  AND: { minArgs: 1, maxArgs: Infinity, fn: (args) => logical(args, "AND") },
  OR: { minArgs: 1, maxArgs: Infinity, fn: (args) => logical(args, "OR") },

  NOT: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([value]) => {
      const flag = toBoolean(value);
      return isFormulaError(flag) ? flag : !flag;
    }
  },

  ISBLANK: { minArgs: 1, maxArgs: 1, fn: ([value]) => value === null },
  ISERROR: { minArgs: 1, maxArgs: 1, fn: ([value]) => isFormulaError(value) },
  ISNUMBER: { minArgs: 1, maxArgs: 1, fn: ([value]) => typeof value === "number" },
  ISTEXT: { minArgs: 1, maxArgs: 1, fn: ([value]) => typeof value === "string" },

  // -- math ----------------------------------------------------------------------

  ROUND: { minArgs: 1, maxArgs: 2, fn: (args) => roundWith(args, (x) => Math.round(x)) },
  ROUNDUP: { minArgs: 1, maxArgs: 2, fn: (args) => roundWith(args, (x) => Math.ceil(x)) },
  ROUNDDOWN: { minArgs: 1, maxArgs: 2, fn: (args) => roundWith(args, (x) => Math.floor(x)) },

  ABS: { minArgs: 1, maxArgs: 1, fn: ([value]) => mapNumber(value, Math.abs) },
  INT: { minArgs: 1, maxArgs: 1, fn: ([value]) => mapNumber(value, Math.floor) },

  MOD: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([a, b]) => {
      const left = toNumber(a);
      if (isFormulaError(left)) return left;
      const right = toNumber(b);
      if (isFormulaError(right)) return right;
      if (right === 0) return ERR.DIV0;
      return left - right * Math.floor(left / right);
    }
  },

  SQRT: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([value]) => {
      const x = toNumber(value);
      if (isFormulaError(x)) return x;
      return x < 0 ? withDetail(ERR.NUM, "The square root of a negative number is not a real number.") : Math.sqrt(x);
    }
  },

  POWER: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([a, b]) => {
      const base = toNumber(a);
      if (isFormulaError(base)) return base;
      const exponent = toNumber(b);
      if (isFormulaError(exponent)) return exponent;
      if (base === 0 && exponent < 0) return ERR.DIV0;
      const result = Math.pow(base, exponent);
      return Number.isFinite(result) ? result : ERR.NUM;
    }
  },

  // -- text ----------------------------------------------------------------------

  LEN: { minArgs: 1, maxArgs: 1, fn: ([value]) => mapText(value, (t) => t.length) },
  UPPER: { minArgs: 1, maxArgs: 1, fn: ([value]) => mapText(value, (t) => t.toUpperCase()) },
  LOWER: { minArgs: 1, maxArgs: 1, fn: ([value]) => mapText(value, (t) => t.toLowerCase()) },
  TRIM: { minArgs: 1, maxArgs: 1, fn: ([value]) => mapText(value, (t) => t.trim().replace(/ {2,}/g, " ")) },

  LEFT: {
    minArgs: 1,
    maxArgs: 2,
    fn: ([value, count]) =>
      withTextAndCount(value, count, 1, (text, n) => text.slice(0, n))
  },

  RIGHT: {
    minArgs: 1,
    maxArgs: 2,
    fn: ([value, count]) =>
      withTextAndCount(value, count, 1, (text, n) => (n === 0 ? "" : text.slice(-n)))
  },

  MID: {
    minArgs: 3,
    maxArgs: 3,
    fn: ([value, start, length]) => {
      const text = toText(value);
      if (isFormulaError(text)) return text;
      const from = toNumber(start);
      if (isFormulaError(from)) return from;
      const count = toNumber(length);
      if (isFormulaError(count)) return count;
      if (from < 1 || count < 0) return ERR.VALUE;
      return text.substr(Math.floor(from) - 1, Math.floor(count));
    }
  },

  FIND: { minArgs: 2, maxArgs: 3, fn: (args) => findText(args, true) },
  SEARCH: { minArgs: 2, maxArgs: 3, fn: (args) => findText(args, false) },

  REPLACE: {
    minArgs: 4,
    maxArgs: 4,
    fn: ([value, start, length, replacement]) => {
      const text = toText(value);
      if (isFormulaError(text)) return text;
      const from = toNumber(start);
      if (isFormulaError(from)) return from;
      const count = toNumber(length);
      if (isFormulaError(count)) return count;
      const insert = toText(replacement);
      if (isFormulaError(insert)) return insert;
      if (from < 1 || count < 0) return ERR.VALUE;
      const index = Math.floor(from) - 1;
      return text.slice(0, index) + insert + text.slice(index + Math.floor(count));
    }
  },

  SUBSTITUTE: {
    minArgs: 3,
    maxArgs: 4,
    fn: ([value, from, to, instance]) => {
      const text = toText(value);
      if (isFormulaError(text)) return text;
      const search = toText(from);
      if (isFormulaError(search)) return search;
      const replacement = toText(to);
      if (isFormulaError(replacement)) return replacement;
      if (search === "") return text;
      if (instance === undefined || instance === null) return text.split(search).join(replacement);
      const which = toNumber(instance);
      if (isFormulaError(which)) return which;
      if (which < 1) return ERR.VALUE;
      let index = -1;
      for (let seen = 0; seen < which; seen++) {
        index = text.indexOf(search, index + 1);
        if (index === -1) return text;
      }
      return text.slice(0, index) + replacement + text.slice(index + search.length);
    }
  },

  TEXT: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([value, format]) => {
      const pattern = toText(format);
      if (isFormulaError(pattern)) return pattern;
      if (typeof value === "string" && Number.isNaN(Number(value))) return value;
      const x = toNumber(value);
      if (isFormulaError(x)) return x;
      return formatWithPattern(x, pattern);
    }
  },

  /** Case-insensitive containment, like SEARCH without the position. */
  INCLUDES: { minArgs: 2, maxArgs: 2, fn: ([a, b]) => testText(a, b, (t, p) => t.includes(p)) },
  STARTSWITH: { minArgs: 2, maxArgs: 2, fn: ([a, b]) => testText(a, b, (t, p) => t.startsWith(p)) },
  ENDSWITH: { minArgs: 2, maxArgs: 2, fn: ([a, b]) => testText(a, b, (t, p) => t.endsWith(p)) }
};

// -- helpers ------------------------------------------------------------------------

/**
 * AND / OR over scalars and ranges. Text and blanks inside ranges are ignored;
 * a scalar "TRUE"/"FALSE" or number counts.
 * @param {Value[]} args
 * @param {"AND" | "OR"} mode
 * @returns {Value}
 */
function logical(args, mode) {
  let seen = false;
  let result = mode === "AND";
  for (const arg of args) {
    const list = Array.isArray(arg) ? arg : [arg];
    const inRange = Array.isArray(arg);
    for (const entry of list) {
      if (isFormulaError(entry)) return entry;
      if (entry === null) continue;
      if (inRange && typeof entry === "string") continue;
      const flag = toBoolean(/** @type {Scalar} */ (entry));
      if (isFormulaError(flag)) return flag;
      seen = true;
      result = mode === "AND" ? result && flag : result || flag;
    }
  }
  return seen ? result : ERR.VALUE;
}

/**
 * @param {Value} value
 * @param {(x: number) => number} fn
 * @returns {Value}
 */
function mapNumber(value, fn) {
  const x = toNumber(value);
  return isFormulaError(x) ? x : fn(x);
}

/**
 * @param {Value} value
 * @param {(text: string) => Value} fn
 * @returns {Value}
 */
function mapText(value, fn) {
  const text = toText(value);
  return isFormulaError(text) ? text : fn(text);
}

/**
 * @param {Value} value
 * @param {Value | undefined} count
 * @param {number} fallback
 * @param {(text: string, n: number) => Value} fn
 * @returns {Value}
 */
function withTextAndCount(value, count, fallback, fn) {
  const text = toText(value);
  if (isFormulaError(text)) return text;
  const n = count === undefined || count === null ? fallback : toNumber(count);
  if (isFormulaError(n)) return n;
  if (n < 0) return ERR.VALUE;
  return fn(text, Math.floor(n));
}

/**
 * ROUND family: scale, normalise binary noise (1.005 * 100), apply the integer
 * rounding to the magnitude, restore the sign. Half rounds away from zero.
 * @param {Value[]} args
 * @param {(x: number) => number} roundMagnitude
 * @returns {Value}
 */
function roundWith(args, roundMagnitude) {
  const x = toNumber(args[0]);
  if (isFormulaError(x)) return x;
  const digits = args[1] === undefined ? 0 : toNumber(args[1]);
  if (isFormulaError(digits)) return digits;
  const places = Math.trunc(digits);
  const factor = Math.pow(10, places);
  const scaled = Number((Math.abs(x) * factor).toPrecision(15));
  const rounded = roundMagnitude(scaled);
  const result = (x < 0 ? -rounded : rounded) / factor;
  if (result === 0) return 0;
  return Number.isFinite(result) ? result : ERR.NUM;
}

/**
 * FIND (case-sensitive) and SEARCH (case-insensitive).
 * @param {Value[]} args
 * @param {boolean} caseSensitive
 * @returns {Value}
 */
function findText(args, caseSensitive) {
  const needle = toText(args[0]);
  if (isFormulaError(needle)) return needle;
  const haystack = toText(args[1]);
  if (isFormulaError(haystack)) return haystack;
  const start = args[2] === undefined ? 1 : toNumber(args[2]);
  if (isFormulaError(start)) return start;
  if (start < 1 || start > haystack.length + 1) return ERR.VALUE;
  const a = caseSensitive ? haystack : haystack.toLowerCase();
  const b = caseSensitive ? needle : needle.toLowerCase();
  const index = a.indexOf(b, Math.floor(start) - 1);
  return index === -1
    ? withDetail(ERR.VALUE, `"${needle}" was not found in the text.`)
    : index + 1;
}

/**
 * @param {Value} a
 * @param {Value} b
 * @param {(text: string, part: string) => boolean} test
 * @returns {Value}
 */
function testText(a, b, test) {
  const text = toText(a);
  if (isFormulaError(text)) return text;
  const part = toText(b);
  if (isFormulaError(part)) return part;
  return test(text.toLowerCase(), part.toLowerCase());
}

/**
 * A deliberately small number-format language for TEXT: optional literal prefix
 * and suffix around `0` / `#` digit placeholders, `,` thousands separators, a
 * decimal point and a trailing `%`.
 * @param {number} value
 * @param {string} pattern
 * @returns {string}
 */
export function formatWithPattern(value, pattern) {
  const match = /^([^0#]*)([0#,]*)(?:\.([0#]*))?(%?)([^0#]*)$/.exec(pattern);
  if (!match || (match[2] === "" && match[3] === undefined)) return formatNumber(value);
  const [, prefix, whole, fraction = "", percent, suffix] = match;
  const scaled = percent ? value * 100 : value;
  const decimals = fraction.length;
  const fixed = Math.abs(scaled).toFixed(decimals);
  let [integer, decimal = ""] = fixed.split(".");
  if (whole.includes(",")) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const minimumDigits = (whole.match(/0/g) ?? []).length;
  const plain = integer.replace(/,/g, "");
  if (plain.length < minimumDigits) integer = plain.padStart(minimumDigits, "0");
  if (whole.replace(/,/g, "") !== "" && !/0/.test(whole) && plain === "0") integer = "";
  // optional (#) decimals drop trailing zeros
  const optional = fraction.replace(/0/g, "").length;
  if (optional > 0) {
    const required = fraction.length - optional;
    decimal = decimal.replace(/0+$/, "").padEnd(required, "0");
  }
  const sign = scaled < 0 && Number(fixed) !== 0 ? "-" : "";
  return `${sign}${prefix}${integer || "0"}${decimal ? "." + decimal : ""}${percent}${suffix}`;
}

/** @type {Set<string>} Names handled specially by the evaluator (lazy args). */
export const LAZY_FUNCTIONS = new Set(["IF", "IFERROR", "IFNA"]);

/** Functions only available where the context can resolve stable ids (expressions). */
export const EMBED_ONLY_FUNCTIONS = ["REF"];

/**
 * @param {string} name
 * @returns {FormulaFunction | undefined}
 */
export function getFunction(name) {
  return functions[name];
}

/** @type {string[]} All recognised function names (for autocomplete, diagnostics, tests). */
export const FUNCTION_NAMES = [...Object.keys(functions), ...LAZY_FUNCTIONS, ...EMBED_ONLY_FUNCTIONS].sort();
