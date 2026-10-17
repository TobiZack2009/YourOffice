/**
 * AST evaluator (spec §6.4, §6.5). Pure: same AST + context → same value.
 *
 * The context supplies the environment the formula runs in:
 *
 *   getCell(ref)      → Value (scalar); blank cells return null
 *   getRange(start,end) → Value[] (row-major scalars)
 *   getName(name)     → Value | undefined (named range / section value target)
 *
 * Errors are values that propagate; no exceptions are thrown for spreadsheet
 * error conditions. Syntax errors are caught by the caller (see `recalc.js`).
 */

import { ERR, isFormulaError, errorFromLiteral } from "./errors.js";
import { getFunction } from "./functions.js";
import { formatNumber } from "./values.js";
import {
  toNumber,
  toText,
  toBoolean,
  compareValues,
  isRange
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
      return context.getRange(start, end);
    }
    case "name": {
      const value = context.getName?.(/** @type {string} */ (ast.name));
      return value === undefined ? ERR.NAME : value;
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
  const operand = evaluate(/** @type {AstNode} */ (ast.operand), context);
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
  const operand = evaluate(/** @type {AstNode} */ (ast.operand), context);
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
  const left = evaluate(/** @type {AstNode} */ (ast.left), context);
  const right = evaluate(/** @type {AstNode} */ (ast.right), context);
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

  // IF is lazy: only the taken branch is evaluated.
  if (name === "IF") {
    if (args.length < 2 || args.length > 3) return ERR.VALUE;
    const condition = toBoolean(evaluate(args[0], context));
    if (isFormulaError(condition)) return condition;
    if (condition) return evaluate(args[1], context);
    return args[2] ? evaluate(args[2], context) : false;
  }

  const fn = getFunction(name);
  if (!fn) return ERR.NAME;
  if (args.length < fn.minArgs || args.length > fn.maxArgs) return ERR.VALUE;

  const evaluated = args.map((argument) => evaluate(argument, context));
  return fn.fn(evaluated);
}

/**
 * Convenience: evaluate a parsed formula and stringify scalars for display.
 * @param {Value} value
 * @returns {string} Display text; ranges collapse to #VALUE!.
 */
export function displayValue(value) {
  if (isFormulaError(value)) return value.code;
  if (isRange(value)) return ERR.VALUE.code;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return formatNumber(value);
  return value;
}
