/**
 * Excel-style error values for the formula engine (spec §6.4).
 *
 * Errors are *values*: they flow through expressions and propagate rather than
 * throwing. Codes match the familiar spreadsheet set. `#CIRC!` is a deliberate,
 * documented extension for circular references — see AGENTS.md open items.
 */

export class FormulaError {
  /**
   * @param {string} code One of the standard codes, e.g. "#DIV/0!".
   */
  constructor(code) {
    /** @type {string} */
    this.code = code;
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
