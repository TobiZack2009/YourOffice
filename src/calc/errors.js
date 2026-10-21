/**
 * Excel-style error values for the formula engine (spec §6.4).
 *
 * Errors are *values*: they flow through expressions and propagate rather than
 * throwing. Codes match the familiar spreadsheet set. `#CIRC!` is a deliberate,
 * documented extension for circular references — see AGENTS.md open items.
 *
 * Every code has a generic plain-language explanation (`explain`). Where the
 * engine knows more (the unresolved name, the vanished range, the cycle path, the
 * cell a propagated error came from) it returns a *derived* error: a new
 * `FormulaError` with the same `code` plus a `detail` string and optional extras.
 * `isFormulaError` and `.code` comparisons keep working on derived errors.
 */

export class FormulaError {
  /**
   * @param {string} code One of the standard codes, e.g. "#DIV/0!".
   * @param {string | null} [detail] Specific explanation, when known.
   * @param {Record<string, unknown>} [extra] Structured extras (position, origin, hint, path, suggestion).
   */
  constructor(code, detail = null, extra = {}) {
    /** @type {string} */
    this.code = code;
    /** @type {string | null} */
    this.detail = detail;
    Object.assign(this, extra);
  }

  toString() {
    return this.code;
  }
}

/** Canonical error values. Treated as immutable singletons. */
export const ERR = Object.freeze({
  /** Broken or out-of-bounds reference. */
  REF: new FormulaError("#REF!"),
  /** Division by zero. */
  DIV0: new FormulaError("#DIV/0!"),
  /** Wrong value type for the operation. */
  VALUE: new FormulaError("#VALUE!"),
  /** Unknown function or name. */
  NAME: new FormulaError("#NAME?"),
  /** Numeric overflow / invalid numeric result. */
  NUM: new FormulaError("#NUM!"),
  /** Value not available (e.g. lookup miss). */
  NA: new FormulaError("#N/A"),
  /** Circular reference. Our explicit code; Excel/Sheets differ — see docs. */
  CIRC: new FormulaError("#CIRC!"),
  /** Null intersection of ranges. */
  NULL: new FormulaError("#NULL!"),
  /** Malformed number literal. */
  BAD: new FormulaError("#ERROR!")
});

const KNOWN_CODES = new Set(Object.values(ERR).map((error) => error.code));

/**
 * Generic plain-language message and hint per code.
 * @type {Record<string, { message: string, hint: string }>}
 */
export const EXPLANATIONS = Object.freeze({
  "#REF!": {
    message: "A reference points at something that no longer exists.",
    hint: "Re-enter the reference, or undo the deletion that removed its target."
  },
  "#DIV/0!": {
    message: "The formula divides by zero (or by an empty cell).",
    hint: "Check the divisor, or wrap the division in IF or IFERROR."
  },
  "#VALUE!": {
    message: "A value has the wrong type for this operation.",
    hint: "Text, tables and slides cannot be used in arithmetic; check the arguments."
  },
  "#NAME?": {
    message: "A name or function was not recognised.",
    hint: "Check the spelling, or qualify the name with its page, for example Page!Name."
  },
  "#NUM!": {
    message: "The result is not a usable number.",
    hint: "The value is too large, or the operation is not defined for these numbers."
  },
  "#N/A": {
    message: "A value is not available.",
    hint: "The lookup found nothing; use IFNA to supply a fallback."
  },
  "#CIRC!": {
    message: "The formula depends on its own result.",
    hint: "Break the loop by changing one of the references in the chain."
  },
  "#NULL!": {
    message: "The ranges do not intersect.",
    hint: "Check the ranges you combined."
  },
  "#ERROR!": {
    message: "The formula could not be understood.",
    hint: "Check for a missing bracket, quote or operator."
  }
});

/**
 * @param {unknown} value
 * @returns {value is FormulaError}
 */
export function isFormulaError(value) {
  return value instanceof FormulaError;
}

/**
 * Parse an error literal (`#REF!`, `#DIV/0!`, …) into a FormulaError.
 * @param {string} text Case-sensitive, e.g. "#N/A".
 * @returns {FormulaError | null} null when not a known code.
 */
export function errorFromLiteral(text) {
  return KNOWN_CODES.has(text) ? (/** @type {FormulaError} */ (
    Object.values(ERR).find((error) => error.code === text)
  )) : null;
}

/**
 * Derive an error with the same code and a specific explanation. The canonical
 * singleton is never mutated.
 * @param {FormulaError} error
 * @param {string} detail
 * @param {Record<string, unknown>} [extra]
 * @returns {FormulaError}
 */
export function withDetail(error, detail, extra = {}) {
  return new FormulaError(error.code, detail, extra);
}

/**
 * Plain-language explanation of an error: the generic message and hint for its
 * code, plus whatever specific detail it carries.
 * @param {FormulaError | string} error
 * @returns {{ code: string, message: string, detail: string | null, hint: string, text: string }}
 */
export function explain(error) {
  const code = typeof error === "string" ? error : error.code;
  const generic = EXPLANATIONS[code] ?? { message: "Something went wrong.", hint: "" };
  const detail = typeof error === "string" ? null : (error.detail ?? null);
  const hint = (typeof error !== "string" && /** @type {any} */ (error).hint) || generic.hint;
  const lead = detail ?? generic.message;
  return {
    code,
    message: generic.message,
    detail,
    hint,
    text: hint ? `${lead} ${hint}` : lead
  };
}

/**
 * The same error, noting which cell it first appeared in. Used when an error
 * propagates through a reference so the user can find its source.
 * @param {FormulaError} error
 * @param {string} origin Human-readable origin, e.g. "Expenses!B2".
 * @returns {FormulaError}
 */
export function withOrigin(error, origin) {
  if (/** @type {any} */ (error).origin) return error;
  const base = error.detail ?? EXPLANATIONS[error.code]?.message ?? "";
  const { code, detail, ...rest } = error;
  return new FormulaError(code, `${base} (from ${origin})`.trim(), { ...rest, origin });
}
