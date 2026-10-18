/**
 * Reference expressions: formulas that are not stored in a cell.
 *
 * An expression is read from a page (or detached entry), so its names resolve
 * from there, and it is evaluated by the same engine as cell formulas: one
 * language, one set of functions, one set of errors. Its result is any value:
 * a scalar, a range of cells, or a handle to blocks or a slide; `classifyValue`
 * names which, and `collectTargets` lists what the expression reads (for the
 * reverse index and for cycle checks).
 */

import { parseFormula } from "../sheet/parser.js";
import { FormulaSyntaxError } from "../sheet/tokenizer.js";
import { syntaxErrorValue } from "../sheet/recalc.js";
import { buildBook } from "../sheet/table-engine.js";
import { isFormulaError, ERR, withDetail } from "../sheet/errors.js";
import { isHandle, isRange } from "../sheet/values.js";
import { scopePageOf } from "./containers.js";
import { collectNames, resolveTarget } from "./scope.js";
import { findSection } from "./sections.js";

/** @typedef {import("../sheet/values.js").Value} Value */

/**
 * @typedef {object} ExpressionResult
 * @property {Value} value Computed value; a `FormulaError` when it failed.
 * @property {any} ast Parsed expression, or null when it did not parse.
 * @property {"error" | "empty" | "scalar" | "range" | "blocks" | "slide"} type
 */

/**
 * @param {Value} value
 * @returns {ExpressionResult["type"]}
 */
export function classifyValue(value) {
  if (isFormulaError(value)) return "error";
  if (value === null || value === undefined || value === "") return "empty";
  if (isHandle(value)) return value.kind;
  if (isRange(value)) return "range";
  return "scalar";
}

/** @type {Map<string, any>} Parsed ASTs by source text (evaluation never mutates them). */
const parseCache = new Map();

/**
 * Parse expression text.
 * @param {string} text
 * @returns {{ ast: any } | { error: import("../sheet/errors.js").FormulaError }}
 */
export function parseExpression(text) {
  if (typeof text !== "string" || text.trim() === "" || text.trim() === "=") {
    return { error: withDetail(ERR.BAD, "The expression is empty.") };
  }
  const cached = parseCache.get(text);
  if (cached) return { ast: cached };
  try {
    const ast = parseFormula(text);
    if (parseCache.size > 4000) parseCache.clear();
    parseCache.set(text, ast);
    return { ast };
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { error: syntaxErrorValue(error) };
    throw error;
  }
}

/**
 * Evaluate expression text read from a container.
 * @param {import("./containers.js").ContainerData} data
 * @param {string} containerId Page (or detached) id the expression lives in.
 * @param {string} text
 * @param {{ book?: import("../sheet/recalc.js").RecalcEngine }} [options] A built engine to reuse.
 * @returns {ExpressionResult}
 */
export function evaluateExpression(data, containerId, text, options = {}) {
  const parsed = parseExpression(text);
  if ("error" in parsed) return { value: parsed.error, ast: null, type: "error" };
  const book = options.book ?? buildBook(/** @type {any} */ (data));
  const scope = `@page:${scopePageOf(data, containerId) ?? ""}`;
  const value = book.evaluateAst(parsed.ast, scope);
  return { value, ast: parsed.ast, type: classifyValue(value) };
}

/**
 * Nodes an expression reads: `sec:<id>` for sections, `tbl:<id>` for tables, with
 * the container that holds each. Names that do not resolve are skipped (they
 * evaluate to an error elsewhere); `REF("id")` calls are followed by id.
 * @param {import("./containers.js").ContainerData & { pageOrder: Record<string, string[]> }} data
 * @param {string} containerId
 * @param {string} text
 * @returns {{ node: string, containerId: string }[]}
 */
export function collectTargets(data, containerId, text) {
  const parsed = parseExpression(text);
  if ("error" in parsed) return [];
  return targetsOfAst(data, containerId, parsed.ast);
}

/**
 * @param {import("./containers.js").ContainerData & { pageOrder: Record<string, string[]> }} data
 * @param {string} containerId
 * @param {any} ast
 * @returns {{ node: string, containerId: string }[]}
 */
export function targetsOfAst(data, containerId, ast) {
  /** @type {{ node: string, containerId: string }[]} */
  const found = [];
  for (const { segments } of collectNames(ast)) {
    const target = resolveTarget(/** @type {any} */ (data), containerId, segments).target;
    if (target?.kind === "section") found.push({ node: `sec:${target.sectionId}`, containerId: target.pageId });
    else if (target?.kind === "table") found.push({ node: `tbl:${target.tableId}`, containerId: target.pageId });
  }
  /** @param {any} node */
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "call" && node.name === "REF" && node.args?.[0]?.type === "string") {
      const id = node.args[0].value;
      const section = findSection(data, id);
      if (section) found.push({ node: `sec:${id}`, containerId: section.containerId });
      else {
        for (const [owner, container] of Object.entries({ ...data.pages, ...(data.detached ?? {}) })) {
          if (/** @type {any} */ (container)?.content?.tables?.[id]) found.push({ node: `tbl:${id}`, containerId: owner });
        }
      }
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") walk(value);
  };
  walk(ast);
  return found;
}
