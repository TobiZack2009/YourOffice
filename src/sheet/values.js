/**
 * Value coercion for the formula engine (spec §6.4 Excel-like behaviour).
 *
 * A formula value is one of: number, string, boolean, null (blank cell),
 * FormulaError, or an array (a resolved range, row-major).
 *
 * Coercion functions return either the coerced scalar or a FormulaError; the
 * caller propagates errors. Behaviour intentionally mirrors Excel for the
 * common cases and is pinned by tests.
 */

import { ERR, FormulaError, isFormulaError } from "./errors.js";

/** @typedef {number | string | boolean | null | FormulaError} Scalar */
/** @typedef {Scalar | Scalar[]} Value */

/**
 * @param {unknown} value
 * @returns {value is Scalar[]}
 */
export function isRange(value) {
  return Array.isArray(value);
}

/**
 * Coerce a value to a number.
 * - blank → 0, boolean → 1/0, numeric text → number, empty string → 0
 * - non-numeric text, ranges → #VALUE!
 * - errors propagate unchanged
 * @param {Value} value
 * @returns {number | FormulaError}
 */
export function toNumber(value) {
  if (isFormulaError(value)) return value;
  if (isRange(value)) return ERR.VALUE;
  if (value === null) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = value.trim();
  if (text === "") return 0;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return ERR.VALUE;
  return numeric;
}

/**
 * Coerce a value to text (Excel "general" formatting).
 * @param {Value} value
 * @returns {string | FormulaError}
 */
export function toText(value) {
  if (isFormulaError(value)) return value;
  if (isRange(value)) return ERR.VALUE;
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return formatNumber(value);
}

/**
 * Coerce a value to a boolean.
 * blank → false, "TRUE"/"FALSE" (case-insensitive) → boolean, other text → #VALUE!.
 * @param {Value} value
 * @returns {boolean | FormulaError}
 */
export function toBoolean(value) {
  if (isFormulaError(value)) return value;
  if (isRange(value)) return ERR.VALUE;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = value.trim().toUpperCase();
  if (text === "TRUE") return true;
  if (text === "FALSE") return false;
  const numeric = Number(text);
  if (text !== "" && Number.isFinite(numeric)) return numeric !== 0;
  return ERR.VALUE;
}

/**
 * Format a number the way Excel's general format would for our subset:
 * rounded binary noise trimmed, no trailing zeros.
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  // 15 significant digits, then drop trailing zeros.
  const rounded = Number(value.toPrecision(15));
  return String(rounded);
}

/**
 * Type rank used to order values of different types (Excel: number < text < boolean).
 * @param {Scalar} value
 * @returns {number}
 */
function typeRank(value) {
  if (value === null) return 0;
  if (typeof value === "number") return 0;
  if (typeof value === "string") return 1;
  return 2; // boolean
}

/**
 * Compare two scalars for ordering/equality, Excel-style.
 * @param {Scalar} a
 * @param {Scalar} b
 * @returns {number | FormulaError} -1, 0, or 1; errors propagate.
 */
export function compareValues(a, b) {
  if (isFormulaError(a)) return a;
  if (isFormulaError(b)) return b;

  const rankA = typeRank(a);
  const rankB = typeRank(b);

  if (rankA === rankB) {
    if (rankA === 0) {
      const left = a === null ? 0 : /** @type {number} */ (a);
      const right = b === null ? 0 : /** @type {number} */ (b);
      return left === right ? 0 : left < right ? -1 : 1;
    }
    if (rankA === 1) {
      const left = /** @type {string} */ (a).toLowerCase();
      const right = /** @type {string} */ (b).toLowerCase();
      return left === right ? 0 : left < right ? -1 : 1;
    }
    const left = a === true ? 1 : 0;
    const right = b === true ? 1 : 0;
    return left === right ? 0 : left < right ? -1 : 1;
  }

  // Mixed types: Excel coerces a numeric string when compared with a number.
  const numericString = (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  };

  if (rankA === 0 && rankB === 1) {
    const right = numericString(b);
    if (right === null) return -1; // number sorts before non-numeric text
    const left = a === null ? 0 : /** @type {number} */ (a);
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (rankA === 1 && rankB === 0) {
    const left = numericString(a);
    if (left === null) return 1; // non-numeric text sorts after number
    const right = b === null ? 0 : /** @type {number} */ (b);
    return left === right ? 0 : left < right ? -1 : 1;
  }

  // Different, non-coercible types: order by rank.
  return rankA < rankB ? -1 : 1;
}
