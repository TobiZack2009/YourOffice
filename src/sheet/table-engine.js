/**
 * Table ↔ recalculation binding.
 *
 * One `RecalcEngine` per table (the decision recorded in AGENTS.md): tables have
 * independent local A1 coordinate spaces, so cross-table references are a Phase 6
 * name-resolution problem rather than something the engine has to know about now.
 *
 * The engine is a pure cache over the table's cells: it is rebuilt from the
 * sparse store when the table changes. Rebuilding (rather than applying deltas)
 * keeps the binding trivially correct; an incremental update path is the planned
 * optimisation once table sizes make it worthwhile (see AGENTS.md).
 */

import { RecalcEngine } from "./recalc.js";
import { displayValue } from "./evaluator.js";
import { parseCellKey } from "./model.js";

/**
 * The engine speaks 1-based A1 positions (its keys are "col,row" with A1 as
 * "1,1"); the table model stores 0-based positions. The conversion lives here so
 * nothing else has to think about it.
 * @param {{ col: number, row: number }} position
 * @returns {{ col: number, row: number }}
 */
function toEnginePosition(position) {
  return { col: position.col + 1, row: position.row + 1 };
}

/** @typedef {import("./model.js").Table} Table */
/** @typedef {import("./values.js").Value} Value */

export class TableEngines {
  constructor() {
    /** @type {Map<string, RecalcEngine>} */
    this._engines = new Map();
  }

  /**
   * Rebuild the engine for a table from its sparse cells.
   * @param {Table} table
   * @returns {RecalcEngine}
   */
  rebuild(table) {
    const engine = new RecalcEngine();
    for (const [key, cell] of Object.entries(table.cells)) {
      const position = parseCellKey(key);
      if (!position) continue;
      if (typeof cell.formula === "string") {
        engine.setFormula(toEnginePosition(position), cell.formula);
      } else if (cell.value !== undefined) {
        engine.setLiteral(toEnginePosition(position), cell.value);
      }
    }
    engine.recalculate();
    this._engines.set(table.id, engine);
    return engine;
  }

  /**
   * The engine for a table, rebuilding it when absent.
   * @param {Table} table
   * @returns {RecalcEngine}
   */
  engine(table) {
    return this._engines.get(table.id) ?? this.rebuild(table);
  }

  /** @param {string} tableId */
  forget(tableId) {
    this._engines.delete(tableId);
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
      return this.engine(table).getDisplay(toEnginePosition({ col, row }));
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
      return this.engine(table).getValue(toEnginePosition({ col, row }));
    }
    if (cell && cell.value !== undefined) return cell.value;
    return null;
  }
}
