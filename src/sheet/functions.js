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

import { ERR, isFormulaError } from "./errors.js";

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
  }
};

/** @type {Set<string>} Names handled specially by the evaluator (lazy args). */
export const LAZY_FUNCTIONS = new Set(["IF"]);

/**
 * @param {string} name
 * @returns {FormulaFunction | undefined}
 */
export function getFunction(name) {
  return functions[name];
}

/** @type {string[]} All recognised function names (for diagnostics/tests). */
export const FUNCTION_NAMES = Object.keys(functions);
