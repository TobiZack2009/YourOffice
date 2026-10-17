/**
 * Sheet commands (spec §6.2, §6.5).
 *
 * All structural edits (rows, columns, merges) run as single transactions and
 * rewrite the affected formulas so references keep pointing at the same data.
 * Sparse storage is preserved: only meaningful cells exist, and every operation
 * rewrites the sparse keys rather than materialising a grid.
 *
 * Registered with `registerSheetCommands(store)` so the workspace layer stays
 * independent of the sheet editor.
 */

import { CommandError } from "../core/errors.js";
import { touchPage } from "../workspace/commands.js";
import { MAX_COLUMN, MAX_ROW } from "./references.js";
import {
  createTable,
  ensureSheetContent,
  findMerge,
  mergeBounds,
  normaliseMerge,
  setCell as writeCell,
  validateCell
} from "./model.js";
import {
  shiftCells,
  shiftMerges,
  shiftOverrides
} from "./shift.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/store.js").Transaction} Transaction */
/** @typedef {import("./model.js").Cell} Cell */
/** @typedef {import("./model.js").SheetContent} SheetContent */
/** @typedef {import("./model.js").Table} Table */

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} reason
 * @returns {string}
 */
function requireString(value, field, reason) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandError(`${field} must be a non-empty string`, reason);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} reason
 * @returns {number}
 */
function requireIndex(value, field, reason) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) {
    throw new CommandError(`${field} must be a non-negative integer`, reason);
  }
  return /** @type {number} */ (value);
}

/**
 * @param {Workspace} store
 * @param {unknown} pageId
 * @returns {{ page: import("../workspace/schema.js").PageEnvelope, content: SheetContent }}
 */
function requireSheetPage(store, pageId) {
  const id = requireString(pageId, "pageId", "invalidPage");
  const page = store._data.pages[id];
  if (!page) throw new CommandError(`page does not exist: ${id}`, "unknownPage");
  if (page.type !== "sheet") {
    throw new CommandError(`page ${id} is not a sheet page`, "wrongPageType");
  }
  return { page, content: ensureSheetContent(page) };
}

/**
 * @param {SheetContent} content
 * @param {unknown} tableId
 * @returns {Table}
 */
function requireTable(content, tableId) {
  const id = requireString(tableId, "tableId", "invalidTable");
  const table = content.tables[id];
  if (!table) throw new CommandError(`table does not exist: ${id}`, "unknownTable");
  return table;
}

/**
 * @param {Table} table
 * @param {unknown} col
 * @param {unknown} row
 * @returns {{ col: number, row: number }}
 */
function requirePosition(table, col, row) {
  const position = {
    col: requireIndex(col, "col", "invalidPosition"),
    row: requireIndex(row, "row", "invalidPosition")
  };
  if (position.col >= MAX_COLUMN || position.row >= MAX_ROW) {
    throw new CommandError("position is beyond the sheet limits", "invalidPosition");
  }
  return position;
}

/**
 * Grow a table so a position fits inside it (the canvas expands on demand).
 * @param {Table} table
 * @param {number} col
 * @param {number} row
 */
function growToFit(table, col, row) {
  if (col >= table.columnCount) table.columnCount = col + 1;
  if (row >= table.rowCount) table.rowCount = row + 1;
}

/** Sheet commands keyed by command type. */
export const sheetCommands = {
  /**
   * Create a table at a canvas position (appended to the z-order by default).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, index?: number, name?: string, x?: number, y?: number, rows?: number, columns?: number }} payload
   */
  createTable(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireSheetPage(store, p.pageId);

    const table = createTable({
      name: typeof p.name === "string" ? p.name : `Table ${content.tableOrder.length + 1}`,
      position: {
        x: typeof p.x === "number" ? p.x : 32 + content.tableOrder.length * 48,
        y: typeof p.y === "number" ? p.y : 32 + content.tableOrder.length * 48
      },
      ...(typeof p.rows === "number" ? { rowCount: p.rows } : {}),
      ...(typeof p.columns === "number" ? { columnCount: p.columns } : {})
    });

    content.tables[table.id] = table;
    if (p.index === undefined) {
      content.tableOrder.push(table.id);
    } else {
      const index = requireIndex(p.index, "index", "invalidIndex");
      if (index > content.tableOrder.length) {
        throw new CommandError("index is out of range", "invalidIndex");
      }
      content.tableOrder.splice(index, 0, table.id);
    }
    touchPage(tx, page);
  },

  /**
   * Delete a table and its cells.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string }} payload
   */
  deleteTable(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireSheetPage(store, p.pageId);
    const table = requireTable(content, p.tableId);
    delete content.tables[table.id];
    const at = content.tableOrder.indexOf(table.id);
    if (at !== -1) content.tableOrder.splice(at, 1);
    touchPage(tx, page);
  },

  /**
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, name: string }} payload
   */
  renameTable(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireSheetPage(store, p.pageId);
    const table = requireTable(content, p.tableId);
    if (typeof p.name !== "string") throw new CommandError("name must be a string", "invalidTable");
    table.name = p.name;
    touchPage(tx, page);
  },

  /**
   * Move a table on the canvas (cell coordinates are unaffected).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, x: number, y: number }} payload
   */
  moveTable(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireSheetPage(store, p.pageId);
    const table = requireTable(content, p.tableId);
    if (typeof p.x !== "number" || !Number.isFinite(p.x) || typeof p.y !== "number" || !Number.isFinite(p.y)) {
      throw new CommandError("x and y must be finite numbers", "invalidPosition");
    }
    table.position = { x: p.x, y: p.y };
    touchPage(tx, page);
  },

  /**
   * Set a cell's literal value or formula. A string value starting with "="
   * becomes a formula. Pass null (or an empty string) to clear the cell.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, col: number, row: number, cell: Record<string, unknown> | null }} payload
   */
  setCell(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireSheetPage(store, p.pageId);
    const table = requireTable(content, p.tableId);
    const { col, row } = requirePosition(table, p.col, p.row);

    const input = p.cell;
    if (input === null || input === undefined) {
      writeCell(table, col, row, null);
      touchPage(tx, page);
      return;
    }
    if (typeof input !== "object" || Array.isArray(input)) {
      throw new CommandError("cell must be an object or null", "invalidCell");
    }

    /** @type {Cell} */
    let cell = { .../** @type {Record<string, unknown>} */ (input) };
    if (cell.formula === undefined && typeof cell.value === "string" && cell.value.startsWith("=")) {
      cell = { formula: cell.value };
    }
    const errors = validateCell(cell);
    if (errors.length > 0) {
      throw new CommandError(`invalid cell: ${errors.join("; ")}`, "invalidCell");
    }

    const emptyValue =
      Object.prototype.hasOwnProperty.call(cell, "value") &&
      (cell.value === null || cell.value === "");
    if (emptyValue) {
      writeCell(table, col, row, null);
      touchPage(tx, page);
      return;
    }

    growToFit(table, col, row);
    writeCell(table, col, row, cell);
    touchPage(tx, page);
  },

  /**
   * Insert rows at a 0-based index.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, index: number, count?: number }} payload
   */
  insertRow(store, tx, payload) {
    insertLines(store, tx, payload, "row");
  },

  /**
   * Delete rows starting at a 0-based index.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, index: number, count?: number }} payload
   */
  deleteRow(store, tx, payload) {
    deleteLines(store, tx, payload, "row");
  },

  /**
   * Insert columns at a 0-based index.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, index: number, count?: number }} payload
   */
  insertColumn(store, tx, payload) {
    insertLines(store, tx, payload, "column");
  },

  /**
   * Delete columns starting at a 0-based index.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, index: number, count?: number }} payload
   */
  deleteColumn(store, tx, payload) {
    deleteLines(store, tx, payload, "column");
  },

  /**
   * Set a row's height override (null restores the default).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, row: number, height: number | null }} payload
   */
  setRowHeight(store, tx, payload) {
    setLineOverride(store, tx, payload, "row");
  },

  /**
   * Set a column's width override (null restores the default).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, column: number, width: number | null }} payload
   */
  setColumnWidth(store, tx, payload) {
    setLineOverride(store, tx, payload, "column");
  },

  /**
   * Merge a rectangular range into one cell.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, start: { col: number, row: number }, end: { col: number, row: number } }} payload
   */
  mergeCells(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireSheetPage(store, p.pageId);
    const table = requireTable(content, p.tableId);

    const start = /** @type {any} */ (p.start);
    const end = /** @type {any} */ (p.end);
    if (!start || !end) throw new CommandError("start and end are required", "invalidMerge");
    const from = requirePosition(table, start.col, start.row);
    const to = requirePosition(table, end.col, end.row);

    const merge = normaliseMerge(from, to);
    const bounds = mergeBounds(merge);
    if (bounds.cols < 2 && bounds.rows < 2) {
      throw new CommandError("a merge needs at least two cells", "invalidMerge");
    }
    growToFit(table, merge.end.col, merge.end.row);

    for (const existing of table.merges) {
      if (overlaps(existing, merge)) {
        throw new CommandError("merge overlaps an existing merge", "mergeOverlap");
      }
    }
    table.merges.push(merge);
    touchPage(tx, page);
  },

  /**
   * Remove the merge covering a position.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, col: number, row: number }} payload
   */
  unmergeCells(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireSheetPage(store, p.pageId);
    const table = requireTable(content, p.tableId);
    const { col, row } = requirePosition(table, p.col, p.row);
    const merge = findMerge(table, col, row);
    if (!merge) {
      throw new CommandError("no merge covers that cell", "notMerged");
    }
    table.merges = table.merges.filter((candidate) => candidate !== merge);
    touchPage(tx, page);
  }
};

/**
 * @param {Workspace} store
 * @param {Transaction} tx
 * @param {Record<string, unknown>} payload
 * @param {"row" | "column"} axis
 */
function insertLines(store, tx, payload, axis) {
  const p = payload ?? {};
  const { page, content } = requireSheetPage(store, p.pageId);
  const table = requireTable(content, p.tableId);
  const index = requireIndex(p.index, "index", "invalidIndex");
  const count = p.count === undefined ? 1 : requireIndex(p.count, "count", "invalidIndex");
  if (count < 1) throw new CommandError("count must be at least 1", "invalidIndex");

  const size = axis === "row" ? table.rowCount : table.columnCount;
  const limit = axis === "row" ? MAX_ROW : MAX_COLUMN;
  if (index > size) throw new CommandError("index is out of range", "invalidIndex");
  if (size + count > limit) throw new CommandError(`${axis} limit exceeded`, "invalidIndex");

  const shift = { mode: /** @type {const} */ ("insert"), axis, index, count };
  table.cells = shiftCells(table.cells, shift);
  if (axis === "row") {
    table.rowOverrides = shiftOverrides(table.rowOverrides, shift);
    table.rowCount += count;
  } else {
    table.columnOverrides = shiftOverrides(table.columnOverrides, shift);
    table.columnCount += count;
  }
  table.merges = shiftMerges(table.merges, shift);
  touchPage(tx, page);
}

/**
 * @param {Workspace} store
 * @param {Transaction} tx
 * @param {Record<string, unknown>} payload
 * @param {"row" | "column"} axis
 */
function deleteLines(store, tx, payload, axis) {
  const p = payload ?? {};
  const { page, content } = requireSheetPage(store, p.pageId);
  const table = requireTable(content, p.tableId);
  const index = requireIndex(p.index, "index", "invalidIndex");
  const requested = p.count === undefined ? 1 : requireIndex(p.count, "count", "invalidIndex");

  const size = axis === "row" ? table.rowCount : table.columnCount;
  if (index >= size) throw new CommandError("index is out of range", "invalidIndex");
  const count = Math.min(requested, size - index);
  if (count < 1) throw new CommandError("count must be at least 1", "invalidIndex");
  if (size - count < 1) {
    throw new CommandError(`cannot delete every ${axis}`, "invalidIndex");
  }

  const shift = { mode: /** @type {const} */ ("delete"), axis, index, count };
  table.cells = shiftCells(table.cells, shift);
  if (axis === "row") {
    table.rowOverrides = shiftOverrides(table.rowOverrides, shift);
    table.rowCount -= count;
  } else {
    table.columnOverrides = shiftOverrides(table.columnOverrides, shift);
    table.columnCount -= count;
  }
  table.merges = shiftMerges(table.merges, shift);
  touchPage(tx, page);
}

/**
 * @param {Workspace} store
 * @param {Transaction} tx
 * @param {Record<string, unknown>} payload
 * @param {"row" | "column"} axis
 */
function setLineOverride(store, tx, payload, axis) {
  const p = payload ?? {};
  const { page, content } = requireSheetPage(store, p.pageId);
  const table = requireTable(content, p.tableId);

  const size = axis === "row" ? table.rowCount : table.columnCount;
  const field = axis === "row" ? "row" : "column";
  const index = requireIndex(p[field], field, "invalidIndex");
  if (index >= size) throw new CommandError(`${field} is out of range`, "invalidIndex");

  const value = axis === "row" ? p.height : p.width;
  const overrides = axis === "row" ? table.rowOverrides : table.columnOverrides;

  if (value === null || value === undefined) {
    delete overrides[String(index)];
  } else {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new CommandError(`${axis === "row" ? "height" : "width"} must be a positive number`, "invalidSize");
    }
    overrides[String(index)] = axis === "row" ? { height: value } : { width: value };
  }
  touchPage(tx, page);
}

/**
 * @param {import("./model.js").Merge} a
 * @param {import("./model.js").Merge} b
 * @returns {boolean}
 */
function overlaps(a, b) {
  return (
    a.start.col <= b.end.col &&
    a.end.col >= b.start.col &&
    a.start.row <= b.end.row &&
    a.end.row >= b.start.row
  );
}

/**
 * Wire sheet commands into a store.
 * @param {Workspace} store
 */
export function registerSheetCommands(store) {
  for (const [type, handler] of Object.entries(sheetCommands)) {
    store.registerCommand(type, handler);
  }
}
