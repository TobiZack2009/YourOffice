/**
 * AST evaluator (spec §6.4, §6.5). Pure: same AST + context → same value.
 *
 * The context supplies the environment the formula runs in:
 *
 *   getCell(ref)      → Value (scalar); blank cells return null
 *   getRange(start,end) → Value[] (row-major scalars)
 *   getName(name)     → Value | undefined (legacy: a single bare name)
 *   resolvePath(segments, address) → Value | undefined
 *                       a name or `Page!Table!B2` path; `address` is the AST
 *                       node of a trailing cell/range (or null). Cross-table
 *                       formulas and expressions use this.
 *   handleText(handle) → string | FormulaError, plain text of a blocks handle
 *   resolveId(id)      → Value | undefined, backs REF("id")
 *
 * Errors are values that propagate; no exceptions are thrown for spreadsheet
 * error conditions. Syntax errors are caught by the caller (see `recalc.js`).
 */

import { ERR, isFormulaError, errorFromLiteral, withDetail } from "./errors.js";
import { getFunction } from "./functions.js";
import { formatNumber } from "./values.js";
import {
  toNumber,
  toText,
  toBoolean,
  compareValues,
  isRange,
  isHandle,
  makeRange
} from "./values.js";

/** @typedef {import("./errors.js").FormulaError} FormulaError */
/** @typedef {import("./values.js").Value} Value */
/** @typedef {import("./values.js").Scalar} Scalar */
/** @typedef {{ type: string, [key: string]: unknown }} AstNode */

/**
 * @typedef {object} EvalContext
 * @property {(ref: { col: number, row: number }) => Value} getCell
 * @property {(start: { col: number, row: number }, end: { col: number, row: number }) => Scalar[]} getRange
 * @property {(name: string) => Value | undefined} [getName]
 * @property {(segments: string[], address: AstNode | null) => Value | undefined} [resolvePath]
 * @property {(handle: import("./values.js").Handle) => string | FormulaError} [handleText]
 * @property {(id: string) => Value | undefined} [resolveId]
 */

/**
 * Evaluate an AST in a context.
 * @param {AstNode} ast
 * @param {EvalContext} context
 * @returns {Value}
 */
export function evaluate(ast, context) {
  switch (ast.type) {
    case "number":
    case "string":
    case "boolean":
      return /** @type {Scalar} */ (ast.value);
    case "error":
      return errorFromLiteral(/** @type {string} */ (ast.code)) ?? ERR.VALUE;
    case "empty":
      return null;
    case "ref":
      return context.getCell(/** @type {{ col: number, row: number }} */ (ast.ref)) ?? null;
    case "range": {
      const start = /** @type {{ col: number, row: number }} */ (ast.start);
      const end = /** @type {{ col: number, row: number }} */ (ast.end);
      return rangeValue(context.getRange(start, end), start, end);
    }
    case "name": {
      const name = /** @type {string} */ (ast.name);
      if (context.resolvePath) {
        const value = context.resolvePath([name], null);
        if (value !== undefined) return value;
        const legacy = context.getName?.(name);
        return legacy === undefined
          ? withDetail(ERR.NAME, `Nothing is named "${name}".`)
          : legacy;
      }
      const value = context.getName?.(name);
      return value === undefined ? ERR.NAME : value;
    }
    case "path": {
      const segments = /** @type {string[]} */ (ast.segments);
      const value = context.resolvePath?.(segments, /** @type {AstNode | null} */ (ast.address));
      if (value !== undefined) return value;
      return withDetail(ERR.NAME, `Nothing is named "${segments.join("!")}".`);
    }
    case "unary":
      return evaluateUnary(ast, context);
    case "postfix":
      return evaluatePostfix(ast, context);
    case "binary":
      return evaluateBinary(ast, context);
    case "call":
      return evaluateCall(ast, context);
    default:
      return ERR.VALUE;
  }
}

/**
 * @param {AstNode} ast
 * @param {EvalContext} context
 * @returns {Value}
 */
function evaluateUnary(ast, context) {
  const operand = scalarize(evaluate(/** @type {AstNode} */ (ast.operand), context), context);
  const numeric = toNumber(operand);
  if (isFormulaError(numeric)) return numeric;
  return ast.op === "-" ? -numeric : numeric;
}

/**
 * @param {AstNode} ast
 * @param {EvalContext} context
 * @returns {Value}
 */
function evaluatePostfix(ast, context) {
  const operand = scalarize(evaluate(/** @type {AstNode} */ (ast.operand), context), context);
  const numeric = toNumber(operand);
  if (isFormulaError(numeric)) return numeric;
  return numeric / 100;
}

/**
 * @param {AstNode} ast
 * @param {EvalContext} context
 * @returns {Value}
 */
function evaluateBinary(ast, context) {
  const left = scalarize(evaluate(/** @type {AstNode} */ (ast.left), context), context);
  const right = scalarize(evaluate(/** @type {AstNode} */ (ast.right), context), context);
  const op = /** @type {string} */ (ast.op);

  if (op === "&") {
    const leftText = toText(left);
    if (isFormulaError(leftText)) return leftText;
    const rightText = toText(right);
    if (isFormulaError(rightText)) return rightText;
    return leftText + rightText;
  }

  if (op === "=" || op === "<>" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    const comparison = compareValues(
      /** @type {Scalar} */ (left),
      /** @type {Scalar} */ (right)
    );
    if (isFormulaError(comparison)) return comparison;
    switch (op) {
      case "=":
        return comparison === 0;
      case "<>":
        return comparison !== 0;
      case "<":
        return comparison < 0;
      case "<=":
        return comparison <= 0;
      case ">":
        return comparison > 0;
      default:
        return comparison >= 0;
    }
  }

  const leftNumber = toNumber(left);
  if (isFormulaError(leftNumber)) return leftNumber;
  const rightNumber = toNumber(right);
  if (isFormulaError(rightNumber)) return rightNumber;

  /** Overflow to ±Infinity becomes #NUM!, matching Excel. */
  const finiteOrNum = (/** @type {number} */ result) =>
    Number.isFinite(result) ? result : ERR.NUM;

  switch (op) {
    case "+":
      return finiteOrNum(leftNumber + rightNumber);
    case "-":
      return finiteOrNum(leftNumber - rightNumber);
    case "*":
      return finiteOrNum(leftNumber * rightNumber);
    case "/":
      return rightNumber === 0 ? ERR.DIV0 : finiteOrNum(leftNumber / rightNumber);
    case "^":
      return finiteOrNum(Math.pow(leftNumber, rightNumber));
    default:
      return ERR.VALUE;
  }
}

/**
 * @param {AstNode} ast
 * @param {EvalContext} context
 * @returns {Value}
 */
function evaluateCall(ast, context) {
  const name = /** @type {string} */ (ast.name);
  const args = /** @type {AstNode[]} */ (ast.args);

  // IF is lazy: only the taken branch is evaluated. Handles pass through.
  if (name === "IF") {
    if (args.length < 2 || args.length > 3) return ERR.VALUE;
    const condition = toBoolean(scalarize(evaluate(args[0], context), context));
    if (isFormulaError(condition)) return condition;
    if (condition) return evaluate(args[1], context);
    return args[2] ? evaluate(args[2], context) : false;
  }

  // IFERROR / IFNA evaluate the fallback only when needed.
  if (name === "IFERROR" || name === "IFNA") {
    if (args.length !== 2) return ERR.VALUE;
    const value = evaluate(args[0], context);
    const failed = isFormulaError(value) && (name === "IFERROR" || value.code === ERR.NA.code);
    return failed ? evaluate(args[1], context) : value;
  }

  // REF("id") reads an element by stable id.
  if (name === "REF") {
    if (args.length !== 1) return ERR.VALUE;
    const id = evaluate(args[0], context);
    if (typeof id !== "string") return withDetail(ERR.VALUE, "REF needs the id as text, like REF(\"sec_abc\").");
    const value = context.resolveId?.(id);
    return value === undefined ? withDetail(ERR.NAME, `No element has the id "${id}".`) : value;
  }

  const fn = getFunction(name);
  if (!fn) return withDetail(ERR.NAME, `"${name}" is not a function.`);
  if (args.length < fn.minArgs || args.length > fn.maxArgs) {
    return withDetail(ERR.VALUE, `${name} takes ${arity(fn)} but was given ${args.length}.`);
  }

  const evaluated = args.map((argument) => scalarizeArg(evaluate(argument, context), context));
  return fn.fn(evaluated);
}

/**
 * @param {{ minArgs: number, maxArgs: number }} fn
 * @returns {string}
 */
function arity(fn) {
  const plural = (/** @type {number} */ n) => `${n} argument${n === 1 ? "" : "s"}`;
  if (fn.maxArgs === Infinity) return `at least ${plural(fn.minArgs)}`;
  if (fn.minArgs === fn.maxArgs) return plural(fn.minArgs);
  return `${fn.minArgs} to ${plural(fn.maxArgs)}`;
}

/**
 * Wrap a resolver's flat row-major cells as a range value.
 * @param {Scalar[]} values
 * @param {{ col: number, row: number }} start
 * @param {{ col: number, row: number }} end
 * @returns {Value}
 */
function rangeValue(values, start, end) {
  const cols = Math.abs(end.col - start.col) + 1;
  const rows = Math.abs(end.row - start.row) + 1;
  if (values.length !== rows * cols) return values;
  return makeRange(values, rows, cols);
}

/**
 * Reduce a value to something an operator can use: a blocks handle becomes its
 * plain text, a slide handle is rejected. Ranges are left to the coercions.
 * @param {Value} value
 * @param {EvalContext} context
 * @returns {Value}
 */
export function scalarize(value, context) {
  if (isHandle(value)) {
    if (value.kind === "slide") {
      return withDetail(ERR.VALUE, "A slide is not a value; it can only be shown.");
    }
    const text = context.handleText?.(value);
    return text === undefined ? withDetail(ERR.VALUE, "This content has no plain-text value.") : text;
  }
  if (isRange(value)) {
    return withDetail(ERR.VALUE, "A table or range of cells cannot be used as a single value here.");
  }
  return value;
}

/**
 * Function arguments keep ranges (SUM(A1:A3)) but coerce handles like scalars.
 * @param {Value} value
 * @param {EvalContext} context
 * @returns {Value}
 */
function scalarizeArg(value, context) {
  return isHandle(value) ? scalarize(value, context) : value;
}

/**
 * Convenience: evaluate a parsed formula and stringify scalars for display.
 * @param {Value} value
 * @returns {string} Display text; ranges collapse to #VALUE!.
 */
export function displayValue(value) {
  if (isFormulaError(value)) return value.code;
  if (isRange(value) || isHandle(value)) return ERR.VALUE.code;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return formatNumber(value);
  return value;
}
