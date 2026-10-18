/**
 * Recalculation engine (spec §6.5): dependency graph, incremental recalculation,
 * dirty queueing, cycle detection.
 *
 * The engine owns no table layout. It maps cell positions ("col,row" keys) to
 * either a literal value or formula text, keeps a dependency graph between them,
 * and recomputes affected cells in topological order. Computed values are caches,
 * never the authoritative representation — the raw formula text is (spec §6.3).
 *
 * Dependency edges:
 *   - direct reference: `A1` in B1 → B1 depends on A1
 *   - range reference:  `A1:A3` in B1 → B1 depends on each cell in the rectangle
 *     (tracked as rectangles; containment is evaluated on demand)
 */

import { ERR, withDetail, isFormulaError } from "./errors.js";
import { parseFormula } from "./parser.js";
import { FormulaSyntaxError } from "./tokenizer.js";
import { refKey, rangeContains } from "./references.js";
import { evaluate, displayValue } from "./evaluator.js";
import { makeRange } from "./values.js";

/** @typedef {import("./errors.js").FormulaError} FormulaError */
/** @typedef {import("./values.js").Value} Value */
/** @typedef {import("./values.js").Scalar} Scalar */
/** @typedef {{ type: string, [key: string]: unknown }} AstNode */
/** @typedef {{ col: number, row: number, scope?: string }} Position */
/** @typedef {{ start: Position, end: Position, scope?: string }} Rect */
/**
 * Resolves a name or path, read from the table `scope`, to cells (or an error / value).
 * @typedef {(scope: string | undefined, segments: string[], address: AstNode | null) => {
 *   error?: FormulaError,
 *   value?: Value,
 *   cells?: { tableId: string, start: Position, end: Position, scalar: boolean }
 * } | undefined} Locate
 */

export class RecalcEngine {
  /**
   * @param {{ locate?: Locate, handleText?: RecalcEngine["handleText"], resolveId?: RecalcEngine["resolveId"] }} [options]
   *   `locate` lets formulas name other tables; positions then carry a `scope` (the
   *   table id) so one engine can hold many tables. `handleText` and `resolveId`
   *   back block-section coercion and `REF("id")`.
   */
  constructor(options = {}) {
    /** @type {Locate | null} */
    this.locate = options.locate ?? null;
    /** @type {((handle: import("./values.js").Handle) => string | FormulaError) | undefined} */
    this.handleText = options.handleText;
    /** @type {((id: string) => Value | undefined) | undefined} */
    this.resolveId = options.resolveId;
    this._bulk = false;
    /** @type {Map<string, { kind: "literal" | "formula", value?: Scalar, text?: string, ast: AstNode | null }>} */
    this.cells = new Map();
    /** @type {Map<string, Value>} Computed values (cache). */
    this.values = new Map();
    /** @type {Map<string, Set<string>>} Formula key → direct precedent keys. */
    this.directPrecedents = new Map();
    /** @type {Map<string, Rect[]>} Formula key → range precedent rectangles. */
    this.rangePrecedents = new Map();
    /** @type {Map<string, Set<string>>} Cell key → formula keys that depend on it. */
    this.dependents = new Map();
    /** @type {Set<string>} Formula keys queued for the next recalculation. */
    this.dirty = new Set();
  }

  // -- mutation ---------------------------------------------------------------

  /**
   * Run many mutations without maintaining the dirty set for each; a full
   * `recalculate()` afterwards picks everything up.
   * @param {() => void} load
   */
  bulk(load) {
    this._bulk = true;
    try {
      load();
    } finally {
      this._bulk = false;
    }
  }

  /**
   * Set a cell to a literal value (or clear it with null).
   * @param {Position} ref
   * @param {Scalar} value
   */
  setLiteral(ref, value) {
    const key = refKey(ref);
    if (value === null || value === undefined) {
      this.cells.delete(key);
      this._clearEdges(key);
      this.values.delete(key);
    } else {
      this.cells.set(key, { kind: "literal", value });
      this._clearEdges(key);
      this.values.set(key, value);
    }
    this._markDirty(key);
  }

  /**
   * Set a cell to formula text, e.g. "=SUM(A1:A3)" or "SUM(A1:A3)".
   * Malformed formulas are stored with an error value (#ERROR!) so the text is
   * preserved rather than silently dropped.
   * @param {Position} ref
   * @param {string} text
   */
  setFormula(ref, text) {
    const key = refKey(ref);
    this._clearEdges(key);
    try {
      const ast = parseFormula(text);
      this.cells.set(key, { kind: "formula", text, ast });
      const { refs, ranges } = collectReferences(ast, { scope: ref.scope, locate: this.locate });
      this.directPrecedents.set(key, new Set(refs.map(refKey)));
      for (const precedent of refs.map(refKey)) {
        let set = this.dependents.get(precedent);
        if (!set) {
          set = new Set();
          this.dependents.set(precedent, set);
        }
        set.add(key);
      }
      for (const rect of ranges) {
        const list = this.rangePrecedents.get(key) ?? [];
        list.push(rect);
        this.rangePrecedents.set(key, list);
      }
      if (!this.values.has(key)) this.values.set(key, null);
    } catch (error) {
      if (error instanceof FormulaSyntaxError) {
        this.cells.set(key, { kind: "formula", text, ast: null });
        this.values.set(key, syntaxErrorValue(error));
      } else {
        throw error;
      }
    }
    this._markDirty(key);
  }

  /** Remove a cell entirely. */
  clear(ref) {
    const key = refKey(ref);
    this.cells.delete(key);
    this._clearEdges(key);
    this.values.delete(key);
    this._markDirty(key);
  }

  /** @returns {{ kind: "literal" | "formula", value?: Scalar, text?: string } | undefined} */
  getRaw(ref) {
    const raw = this.cells.get(refKey(ref));
    if (!raw) return undefined;
    return raw.kind === "literal"
      ? { kind: "literal", value: raw.value }
      : { kind: "formula", text: raw.text };
  }

  /**
   * @param {Position} ref
   * @returns {Value} Computed value; null for blanks.
   */
  getValue(ref) {
    return this.values.get(refKey(ref)) ?? null;
  }

  /**
   * @param {Position} ref
   * @returns {string} Display text for the cell.
   */
  getDisplay(ref) {
    return displayValue(this.getValue(ref));
  }

  // -- recalculation ------------------------------------------------------------

  /**
   * Recalculate all cells. Returns the number of formula cells evaluated.
   * @returns {number}
   */
  recalculate() {
    this.dirty.clear();
    for (const key of this.cells.keys()) {
      if (this.cells.get(key)?.kind === "formula") this.dirty.add(key);
    }
    return this._recalculate(this.dirty);
  }

  /**
   * Recalculate only cells affected since the last change. Call after one or
   * more set operations.
   * @returns {number}
   */
  recalculateDirty() {
    return this._recalculate(this.dirty);
  }

  /**
   * Core topological recalculation over a set of formula keys.
   * @param {Set<string>} formulaKeys
   * @returns {number} Evaluated count.
   */
  _recalculate(formulaKeys) {
    if (formulaKeys.size === 0) return 0;

    /** @type {Map<string, number>} */
    const indegree = new Map();
    /** @type {Map<string, Set<string>>} precedent → formula keys consuming it */
    const consumers = new Map();

    const formulaSet = new Set(formulaKeys);
    /** @type {Map<string, { key: string, position: Position }[]>} */
    const byScope = new Map();
    for (const key of formulaSet) {
      const position = keyToPosition(key);
      if (!position) continue;
      const scope = position.scope ?? "";
      const list = byScope.get(scope) ?? [];
      list.push({ key, position });
      byScope.set(scope, list);
    }

    for (const key of formulaKeys) {
      let count = 0;
      for (const precedent of this._precedentFormulaKeys(key, formulaSet, byScope)) {
        count += 1;
        let set = consumers.get(precedent);
        if (!set) {
          set = new Set();
          consumers.set(precedent, set);
        }
        set.add(key);
      }
      indegree.set(key, count);
    }

    /** @type {string[]} */
    const queue = [];
    for (const [key, count] of indegree) {
      if (count === 0) queue.push(key);
    }

    let evaluated = 0;
    /** @type {Set<string>} */
    const done = new Set();
    while (queue.length > 0) {
      const key = /** @type {string} */ (queue.shift());
      this._evaluateCell(key);
      evaluated += 1;
      done.add(key);
      for (const consumer of consumers.get(key) ?? []) {
        const remaining = (indegree.get(consumer) ?? 0) - 1;
        indegree.set(consumer, remaining);
        if (remaining === 0) queue.push(consumer);
      }
    }

    // Anything left is part of, or downstream of, a circular reference.
    for (const key of formulaKeys) {
      if (!done.has(key)) {
        this.values.set(key, ERR.CIRC);
      }
    }

    this.dirty.clear();
    return evaluated;
  }

  /**
   * Formula keys that `key` depends on, restricted to the recalculated set.
   * A range precedent depends on every formula cell inside it, plus itself
   * (a self-referencing range is a cycle).
   * @param {string} key
   * @param {Set<string>} formulaSet
   * @param {Map<string, { key: string, position: Position }[]>} byScope
   * @returns {Set<string>}
   */
  _precedentFormulaKeys(key, formulaSet, byScope) {
    /** @type {Set<string>} */
    const result = new Set();
    for (const precedent of this.directPrecedents.get(key) ?? []) {
      if (formulaSet.has(precedent)) result.add(precedent);
    }
    const ranges = this.rangePrecedents.get(key) ?? [];
    if (ranges.length === 0) return result;
    const self = keyToPosition(key);
    for (const rect of ranges) {
      if (self && inRect(self, rect)) {
        result.add(key); // range includes its own cell → circular
      }
      for (const { key: other, position } of byScope.get(rect.scope ?? "") ?? []) {
        if (other === key) continue;
        if (inRect(position, rect)) result.add(other);
      }
    }
    return result;
  }

  /**
   * Evaluate one formula cell with a context backed by current values.
   * @param {string} key
   */
  _evaluateCell(key) {
    const raw = this.cells.get(key);
    if (!raw || raw.kind !== "formula" || !raw.ast) {
      if (raw?.kind === "formula" && raw.ast === null && !isFormulaError(this.values.get(key))) {
        this.values.set(key, ERR.BAD);
      }
      return;
    }
    const scope = keyToPosition(key)?.scope;
    this.values.set(key, evaluate(raw.ast, this._makeContext(scope)));
  }

  /**
   * Evaluate a free-standing expression (not stored in any cell) read from `scope`.
   * Expression scopes look like `@page:<pageId>`: names resolve from that page and
   * bare cell addresses are an error, because there is no table to read them in.
   * @param {AstNode} ast
   * @param {string} scope
   * @returns {Value}
   */
  evaluateAst(ast, scope) {
    return evaluate(ast, this._makeContext(scope));
  }

  /**
   * Evaluation context for formulas read in a table (or expression) scope.
   * @param {string | undefined} scope
   */
  _makeContext(scope) {
    const loose = typeof scope === "string" && scope.startsWith("@page:");
    const looseError = withDetail(
      ERR.NAME,
      "A cell address like A1 needs a table: write the table name first, for example Costs!A1."
    );
    return {
      getCell: (/** @type {Position} */ ref) =>
        loose ? looseError : (this.values.get(refKey({ col: ref.col, row: ref.row, scope })) ?? null),
      getRange: (/** @type {Position} */ start, /** @type {Position} */ end) =>
        loose
          ? Array.from(
              { length: (Math.abs(end.row - start.row) + 1) * (Math.abs(end.col - start.col) + 1) },
              () => looseError
            )
          : this._readCells(scope, start, end),
      resolvePath: this.locate
        ? (/** @type {string[]} */ segments, /** @type {AstNode | null} */ address) =>
            this._resolvePath(scope, segments, address)
        : undefined,
      handleText: this.handleText,
      resolveId: this.resolveId
    };
  }

  /**
   * Row-major cell values of a rectangle in one table.
   * @param {string | undefined} scope
   * @param {Position} start
   * @param {Position} end
   * @returns {Scalar[]}
   */
  _readCells(scope, start, end) {
    /** @type {Scalar[]} */
    const values = [];
    for (let row = start.row; row <= end.row; row++) {
      for (let col = start.col; col <= end.col; col++) {
        values.push(/** @type {Scalar} */ (this.values.get(refKey({ col, row, scope })) ?? null));
      }
    }
    return values;
  }

  /**
   * Evaluate-time lookup of a name or path through `locate`.
   * @param {string | undefined} scope
   * @param {string[]} segments
   * @param {AstNode | null} address
   * @returns {Value | undefined}
   */
  _resolvePath(scope, segments, address) {
    const located = this.locate?.(scope, segments, address);
    if (!located) return undefined;
    if (located.error) return located.error;
    if (located.value !== undefined) return located.value;
    const cells = located.cells;
    if (!cells) return undefined;
    const { start, end } = cells;
    const values = this._readCells(cells.tableId, start, end);
    return makeRange(values, end.row - start.row + 1, end.col - start.col + 1, {
      tableId: cells.tableId,
      start,
      end
    });
  }

  // -- graph bookkeeping ----------------------------------------------------------

  /** @param {string} key */
  _clearEdges(key) {
    for (const precedent of this.directPrecedents.get(key) ?? []) {
      this.dependents.get(precedent)?.delete(key);
    }
    this.directPrecedents.delete(key);
    this.rangePrecedents.delete(key);
  }

  /**
   * Queue a cell and everything that (transitively) depends on it.
   * @param {string} key
   */
  _markDirty(key) {
    if (this._bulk) return;
    this.dirty.add(key);
    for (const dependent of this.dependents.get(key) ?? []) {
      this.dirty.add(dependent);
    }
    // Range dependents resolve by containment.
    const position = keyToPosition(key);
    for (const [formulaKey, ranges] of position ? this.rangePrecedents : []) {
      for (const rect of ranges) {
        if (inRect(position, rect)) {
          this.dirty.add(formulaKey);
          break;
        }
      }
    }
    // Any dirty formula invalidates its own dependents for the next pass.
    let grew = true;
    while (grew) {
      grew = false;
      for (const dirtyKey of [...this.dirty]) {
        for (const dependent of this.dependents.get(dirtyKey) ?? []) {
          if (!this.dirty.has(dependent)) {
            this.dirty.add(dependent);
            grew = true;
          }
        }
      }
    }
  }
}

/**
 * The `#ERROR!` value for a formula that did not parse, keeping where it went wrong.
 * @param {FormulaSyntaxError} error
 * @returns {FormulaError}
 */
export function syntaxErrorValue(error) {
  return withDetail(ERR.BAD, error.message.replace(/ at position \d+$/, ""), {
    position: error.position
  });
}

/**
 * @param {string} key "col,row" or "scope|col,row"
 * @returns {Position | null}
 */
function keyToPosition(key) {
  const bar = key.lastIndexOf("|");
  const [col, row] = key.slice(bar + 1).split(",").map(Number);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  return bar < 0 ? { col, row } : { scope: key.slice(0, bar), col, row };
}

/**
 * Whether a cell lies in a rectangle of the same table.
 * @param {Position} position
 * @param {Rect} rect
 * @returns {boolean}
 */
function inRect(position, rect) {
  return (position.scope ?? "") === (rect.scope ?? "") && rangeContains(position, rect.start, rect.end);
}

/**
 * Walk an AST collecting referenced cells and rectangles.
 * Absolute markers do not affect the target position (see references.js).
 * Names and paths are looked up through `options.locate`; `options.scope` is the
 * table the formula lives in, attached to its plain references.
 * @param {AstNode} ast
 * @param {{ scope?: string, locate?: Locate | null }} [options]
 * @returns {{ refs: Position[], ranges: Rect[] }}
 */
export function collectReferences(ast, options = {}) {
  const { scope, locate } = options;
  /** @type {Position[]} */
  const refs = [];
  /** @type {Rect[]} */
  const ranges = [];
  const scoped = (/** @type {object} */ position) => (scope ? { ...position, scope } : position);

  const visitName = (/** @type {string[]} */ segments, /** @type {AstNode | null} */ address) => {
    const cells = locate?.(scope, segments, address)?.cells;
    if (!cells) return;
    if (cells.scalar) {
      refs.push({ col: cells.start.col, row: cells.start.row, scope: cells.tableId });
    } else {
      ranges.push({ start: cells.start, end: cells.end, scope: cells.tableId });
    }
  };

  const visit = (/** @type {AstNode} */ node) => {
    if (!node || typeof node !== "object") return;
    switch (node.type) {
      case "ref":
        refs.push(scoped({ col: node.ref.col, row: node.ref.row }));
        break;
      case "range": {
        const start = { col: node.start.col, row: node.start.row };
        const end = { col: node.end.col, row: node.end.row };
        ranges.push(
          scoped({
            start: { col: Math.min(start.col, end.col), row: Math.min(start.row, end.row) },
            end: { col: Math.max(start.col, end.col), row: Math.max(start.row, end.row) }
          })
        );
        break;
      }
      case "name":
        visitName([node.name], null);
        break;
      case "path":
        visitName(node.segments, node.address ?? null);
        break;
      case "unary":
      case "postfix":
        visit(node.operand);
        break;
      case "binary":
        visit(node.left);
        visit(node.right);
        break;
      case "call":
        for (const argument of node.args) visit(argument);
        break;
      default:
        break;
    }
  };

  visit(ast);
  return { refs, ranges };
}
