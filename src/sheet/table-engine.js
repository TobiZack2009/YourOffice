/**
 * Table ↔ recalculation binding.
 *
 * With a data source (`new TableEngines(() => workspace._data)`) there is ONE
 * `RecalcEngine` for the whole workspace. Cells are keyed by table id plus
 * position, so a formula in one table can read another (`Expenses!B2`) and the
 * dependency graph is cell-keyed: `T1!A1 → T2!A1` with `T2!B1 → T1!B1` is
 * acyclic and calculates, even though the tables refer to each other.
 *
 * Without a data source (unit tests, previews) each table gets its own engine
 * and can only see itself.
 *
 * The engine is a pure cache over the sparse store, rebuilt wholesale when
 * something changes. Rebuilding (rather than applying deltas) keeps the binding
 * trivially correct; an incremental update path is the planned optimisation.
 */

import { RecalcEngine } from "./recalc.js";
import { displayValue } from "./evaluator.js";
import { parseCellKey } from "./model.js";
import { locateReference, locateById } from "../references/locate.js";
import { allContainers, scopePageOf } from "../references/containers.js";
import { sectionPlainText } from "../references/sections.js";
import { makeRange } from "./values.js";

/**
 * The engine speaks 1-based A1 positions (A1 is col 1, row 1) scoped by table id;
 * the table model stores 0-based positions. The conversion lives here so nothing
 * else has to think about it.
 * @param {{ col: number, row: number }} position
 * @param {string} scope Table id.
 * @returns {{ col: number, row: number, scope: string }}
 */
function toEnginePosition(position, scope) {
  return { col: position.col + 1, row: position.row + 1, scope };
}

/** @typedef {import("./model.js").Table} Table */
/** @typedef {import("./values.js").Value} Value */
/** @typedef {{ pages: Record<string, any>, pageOrder: Record<string, string[]>, detached?: Record<string, any> }} WorkspaceData */

export class TableEngines {
  /**
   * @param {() => WorkspaceData} [getData] Current workspace data; enables cross-table formulas.
   */
  constructor(getData) {
    this._getData = getData ?? null;
    /** @type {Map<string, RecalcEngine>} Standalone mode: one engine per table. */
    this._engines = new Map();
    /** @type {RecalcEngine | null} Shared mode: the workspace engine. */
    this._book = null;
  }

  /**
   * Rebuild after the workspace changed. Shared mode rebuilds once. Given the change that
   * happened, it keeps the book it has when that change cannot alter any calculated value
   * (see `changeAffectsBook`).
   * @param {{ pages: string[], registry?: boolean } | null} [change]
   * @returns {void}
   */
  refresh(change = null) {
    if (!this._getData) return;
    const data = this._getData();
    if (this._book && change && !changeAffectsBook(data, change)) return;
    this._book = buildBook(data);
  }

  /**
   * Rebuild the engine for a table from its sparse cells (shared mode: everything).
   * @param {Table} table
   * @returns {RecalcEngine}
   */
  rebuild(table) {
    if (this._getData) {
      this.refresh();
      return /** @type {RecalcEngine} */ (this._book);
    }
    const data = syntheticData(table);
    const engine = buildBook(data);
    this._engines.set(table.id, engine);
    return engine;
  }

  /**
   * The engine holding a table, rebuilding it when absent.
   * @param {Table} table
   * @returns {RecalcEngine}
   */
  engine(table) {
    if (this._getData) {
      if (!this._book) this.refresh();
      return /** @type {RecalcEngine} */ (this._book);
    }
    return this._engines.get(table.id) ?? this.rebuild(table);
  }

  /** @param {string} tableId */
  forget(tableId) {
    if (this._getData) this._book = null;
    else this._engines.delete(tableId);
  }

  /**
   * Computed display text for a cell.
   * @param {Table} table
   * @param {number} col
   * @param {number} row
   * @returns {string} Empty string for blanks.
   */
  display(table, col, row) {
    const cell = table.cells[`${col},${row}`];
    if (cell && typeof cell.formula === "string") {
      return this.engine(table).getDisplay(toEnginePosition({ col, row }, table.id));
    }
    if (cell && cell.value !== undefined) return displayValue(cell.value);
    return "";
  }

  /**
   * Computed value for a cell (errors included), for tests and diagnostics.
   * @param {Table} table
   * @param {number} col
   * @param {number} row
   * @returns {Value}
   */
  value(table, col, row) {
    const cell = table.cells[`${col},${row}`];
    if (cell && typeof cell.formula === "string") {
      return this.engine(table).getValue(toEnginePosition({ col, row }, table.id));
    }
    if (cell && cell.value !== undefined) return cell.value;
    return null;
  }
}

/**
 * Whether a change can alter what the shared engine calculates. Values come from the tables of
 * sheet pages, from the text of sections that formulas read, and from page names (the registry),
 * so an edit to a page that is not a sheet and defines no sections leaves the book as it was.
 * @param {WorkspaceData} data
 * @param {{ pages: string[], registry?: boolean }} change
 * @returns {boolean}
 */
export function changeAffectsBook(data, change) {
  if (change.registry) return true;
  return change.pages.some((id) => {
    const page = data.pages[id];
    if (!page) return true;
    if (page.type === "sheet") return true;
    return Object.keys(page.content?.sections ?? {}).length > 0;
  });
}

/**
 * A one-page workspace around a single table, so the standalone mode can use the
 * same name resolution.
 * @param {Table} table
 * @returns {WorkspaceData}
 */
function syntheticData(table) {
  return {
    pages: {
      __page: {
        id: "__page",
        type: "sheet",
        title: "",
        content: { tables: { [table.id]: table }, tableOrder: [table.id] }
      }
    },
    pageOrder: { root: ["__page"] }
  };
}

/**
 * Load every sheet table of the data into one engine and calculate it.
 * @param {WorkspaceData} data
 * @returns {RecalcEngine}
 */
export function buildBook(data) {
  /** @type {Map<string, string>} Table id → id of the container (page or detached entry) holding it. */
  const owners = new Map();
  for (const [containerId, container] of allContainers(data)) {
    if (container.type !== "sheet" || !container.content?.tables) continue;
    for (const tableId of Object.keys(container.content.tables)) owners.set(tableId, containerId);
  }
  /** @param {string | undefined} scope */
  const pageOfScope = (scope) => {
    if (!scope) return null;
    if (scope.startsWith("@page:")) return scope.slice(6) || null;
    return owners.has(scope) ? scopePageOf(data, /** @type {string} */ (owners.get(scope))) : null;
  };
  /** @type {RecalcEngine} */
  const engine = new RecalcEngine({
    locate: (scope, segments, address) => locateReference(data, pageOfScope(scope), segments, address),
    handleText: (handle) => sectionPlainText(data, handle.sectionId) ?? "",
    resolveId: (id) => {
      const located = locateById(data, id);
      if (!located) return undefined;
      if (located.error) return located.error;
      if (located.value !== undefined) return located.value;
      const cells = located.cells;
      if (!cells) return undefined;
      const { start, end } = cells;
      const values = engine._readCells(cells.tableId, start, end);
      return cells.scalar && values.length === 1
        ? values[0]
        : makeRange(values, end.row - start.row + 1, end.col - start.col + 1, { tableId: cells.tableId, start, end });
    }
  });
  engine.bulk(() => {
    for (const [tableId, containerId] of owners) {
      const table = data.pages[containerId]?.content.tables[tableId] ?? data.detached?.[containerId]?.content.tables[tableId];
      const scope = tableId;
      for (const [key, cell] of Object.entries(table.cells ?? {})) {
        const position = parseCellKey(key);
        if (!position) continue;
        if (typeof cell.formula === "string") {
          engine.setFormula(toEnginePosition(position, scope), cell.formula);
        } else if (cell.value !== undefined) {
          engine.setLiteral(toEnginePosition(position, scope), cell.value);
        }
      }
    }
  });
  engine.recalculate();
  return engine;
}
