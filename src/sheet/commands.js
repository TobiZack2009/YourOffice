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
  SHEET_DEFAULTS,
  cellKey,
  createTable,
  ensureSheetContent,
  findMerge,
  mergeBounds,
  normaliseMerge,
  setCell as writeCell,
  tableExtent,
  validateCell
} from "./model.js";
import { mergeBlocksShift, retargetMovedReferences, shiftRegionCells } from "./cell-shift.js";
import { offsetCell, tileSourceFor } from "./fill.js";
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

/** Largest number of cells one fill/move may touch (keeps a stray huge range from freezing the UI). */
const MAX_FILL_CELLS = 250000;

/**
 * Validate an inclusive 0-based rectangle from a payload.
 * @param {unknown} value
 * @param {string} field
 * @returns {{ start: { col: number, row: number }, end: { col: number, row: number } }}
 */
function requireRect(value, field) {
  const v = /** @type {any} */ (value);
  if (typeof v !== "object" || v === null || typeof v.start !== "object" || typeof v.end !== "object" || !v.start || !v.end) {
    throw new CommandError(`${field} must be { start, end }`, "invalidRange");
  }
  const rect = {
    start: {
      col: requireIndex(v.start.col, `${field}.start.col`, "invalidRange"),
      row: requireIndex(v.start.row, `${field}.start.row`, "invalidRange")
    },
    end: {
      col: requireIndex(v.end.col, `${field}.end.col`, "invalidRange"),
      row: requireIndex(v.end.row, `${field}.end.row`, "invalidRange")
    }
  };
  if (rect.end.col < rect.start.col || rect.end.row < rect.start.row) {
    throw new CommandError(`${field} must run from its top-left to its bottom-right`, "invalidRange");
  }
  if (rect.end.col >= MAX_COLUMN || rect.end.row >= MAX_ROW) {
    throw new CommandError(`${field} is beyond the sheet limits`, "invalidRange");
  }
  return rect;
}

/**
 * @param {{ start: { col: number, row: number }, end: { col: number, row: number } }} rect
 * @returns {number}
 */
function areaOf(rect) {
  return (rect.end.col - rect.start.col + 1) * (rect.end.row - rect.start.row + 1);
}

/**
 * Default canvas position for a new table: left-aligned, below every existing
 * table so a new one never lands on top of another.
 * @param {SheetContent} content
 * @returns {{ x: number, y: number }}
 */
function nextTablePosition(content) {
  let bottom = null;
  for (const id of content.tableOrder) {
    const table = content.tables[id];
    if (!table) continue;
    const reach = table.position.y + tableExtent(table).height;
    bottom = bottom === null ? reach : Math.max(bottom, reach);
  }
  return {
    x: SHEET_DEFAULTS.gap,
    y: bottom === null ? SHEET_DEFAULTS.gap : bottom + SHEET_DEFAULTS.gap
  };
}

/**
 * Shared body of `insertCells` / `deleteCells`.
 * @param {Workspace} store
 * @param {Transaction} tx
 * @param {unknown} payload
 * @param {"insert" | "delete"} mode
 */
function shiftRegion(store, tx, payload, mode) {
  const p = /** @type {Record<string, unknown>} */ (payload ?? {});
  const { page, content } = requireSheetPage(store, p.pageId);
  const table = requireTable(content, p.tableId);
  const range = requireRect(p.range, "range");
  const allowed = mode === "insert" ? ["right", "down"] : ["left", "up"];
  if (typeof p.direction !== "string" || !allowed.includes(p.direction)) {
    throw new CommandError(`direction must be one of ${allowed.join(", ")}`, "invalidDirection");
  }
  const axis = p.direction === "right" || p.direction === "left" ? "column" : "row";
  const shift = {
    mode,
    axis: /** @type {"row" | "column"} */ (axis),
    index: axis === "row" ? range.start.row : range.start.col,
    count: axis === "row" ? range.end.row - range.start.row + 1 : range.end.col - range.start.col + 1,
    lo: axis === "row" ? range.start.col : range.start.row,
    hi: axis === "row" ? range.end.col : range.end.row
  };
  if (table.merges.some((merge) => mergeBlocksShift(merge, shift))) {
    throw new CommandError("cannot shift cells through merged cells", "mergedCells");
  }

  const cells = shiftRegionCells(table.cells, shift);
  for (const key of Object.keys(cells)) {
    const [col, row] = key.split(",").map(Number);
    if (col >= MAX_COLUMN || row >= MAX_ROW) {
      throw new CommandError("cells would be pushed off the sheet", "invalidRange");
    }
    growToFit(table, col, row);
  }
  table.cells = cells;
  touchPage(tx, page);
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

    const free = nextTablePosition(content);
    const table = createTable({
      name: typeof p.name === "string" ? p.name : `Table ${content.tableOrder.length + 1}`,
      position: {
        x: typeof p.x === "number" ? p.x : free.x,
        y: typeof p.y === "number" ? p.y : free.y
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
   * Fill: copy the contents of a source range across one or more target ranges,
   * tiling the source (so a single cell fills a whole range, a row fills down).
   * Formulas have their relative references moved by the distance between the
   * source cell and the target cell, exactly as if each were copy-pasted;
   * `$`-pinned parts stay. A blank source cell clears its targets. The source
   * itself is never changed.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, sourceTableId?: string, source: object, targets?: object[], target?: object }} payload
   */
  fillCells(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireSheetPage(store, p.pageId);
    const table = requireTable(content, p.tableId);
    const sourceTable = p.sourceTableId === undefined ? table : requireTable(content, p.sourceTableId);
    const source = requireRect(p.source, "source");
    const rawTargets = Array.isArray(p.targets) ? p.targets : p.target !== undefined ? [p.target] : [];
    if (rawTargets.length === 0) throw new CommandError("targets must contain at least one range", "invalidRange");
    const targets = rawTargets.map((target, index) => requireRect(target, `targets[${index}]`));

    let total = 0;
    for (const target of targets) total += areaOf(target);
    if (total > MAX_FILL_CELLS) throw new CommandError("fill area is too large", "invalidRange");

    // Read first: the source must not shift while the targets are written.
    const snapshot = new Map();
    for (let row = source.start.row; row <= source.end.row; row++) {
      for (let col = source.start.col; col <= source.end.col; col++) {
        snapshot.set(cellKey(col, row), sourceTable.cells[cellKey(col, row)]);
      }
    }

    for (const target of targets) {
      for (let row = target.start.row; row <= target.end.row; row++) {
        for (let col = target.start.col; col <= target.end.col; col++) {
          const from = tileSourceFor(source, { col, row });
          if (sourceTable === table && from.col === col && from.row === row) continue;
          const cell = snapshot.get(cellKey(from.col, from.row));
          if (!cell) {
            writeCell(table, col, row, null);
            continue;
          }
          growToFit(table, col, row);
          writeCell(table, col, row, offsetCell(cell, col - from.col, row - from.row));
        }
      }
    }
    touchPage(tx, page);
  },

  /**
   * Move a range's contents so its top-left lands on `to`. The source cells are
   * cleared, the destination area is overwritten (blank source cells blank it),
   * and formulas that move have their relative references moved by the same
   * offset, so a block of formulas keeps pointing at its neighbours. Formulas
   * elsewhere in the table that reference the moved cells are retargeted to
   * follow them (a range only when it lies wholly inside the moved block).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, sourceTableId?: string, source: object, to: { col: number, row: number } }} payload
   */
  moveCells(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requireSheetPage(store, p.pageId);
    const table = requireTable(content, p.tableId);
    const sourceTable = p.sourceTableId === undefined ? table : requireTable(content, p.sourceTableId);
    const source = requireRect(p.source, "source");
    const to = /** @type {any} */ (p.to);
    const dest = {
      col: requireIndex(to?.col, "to.col", "invalidPosition"),
      row: requireIndex(to?.row, "to.row", "invalidPosition")
    };
    const deltaCol = dest.col - source.start.col;
    const deltaRow = dest.row - source.start.row;
    requireRect(
      { start: dest, end: { col: source.end.col + deltaCol, row: source.end.row + deltaRow } },
      "destination"
    );
    if (areaOf(source) > MAX_FILL_CELLS) throw new CommandError("move area is too large", "invalidRange");
    if (deltaCol === 0 && deltaRow === 0 && sourceTable === table) return;

    /** @type {{ col: number, row: number, cell: Cell }[]} */
    const moving = [];
    for (let row = source.start.row; row <= source.end.row; row++) {
      for (let col = source.start.col; col <= source.end.col; col++) {
        const cell = sourceTable.cells[cellKey(col, row)];
        if (cell) moving.push({ col, row, cell });
      }
    }

    // Formulas elsewhere in the table that point at the moving cells follow them.
    // (Cross-table references arrive in Phase 6; until then only this table matters.)
    if (sourceTable === table) {
      for (const [key, cell] of Object.entries(table.cells)) {
        if (typeof cell.formula !== "string") continue;
        const [col, row] = key.split(",").map(Number);
        const insideSource =
          col >= source.start.col && col <= source.end.col && row >= source.start.row && row <= source.end.row;
        if (insideSource) continue;
        const retargeted = retargetMovedReferences(cell.formula, source, deltaCol, deltaRow);
        if (retargeted !== cell.formula) table.cells[key] = { ...cell, formula: retargeted };
      }
    }

    for (const { col, row } of moving) writeCell(sourceTable, col, row, null);
    for (let row = source.start.row; row <= source.end.row; row++) {
      for (let col = source.start.col; col <= source.end.col; col++) {
        writeCell(table, col + deltaCol, row + deltaRow, null);
      }
    }
    for (const { col, row, cell } of moving) {
      growToFit(table, col + deltaCol, row + deltaRow);
      writeCell(table, col + deltaCol, row + deltaRow, offsetCell(cell, deltaCol, deltaRow));
    }
    touchPage(tx, page);
  },

  /**
   * Insert blank cells over a range, sliding the cells in its columns (down) or
   * rows (right) out of the way. Formulas that point at slid cells follow them.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, range: object, direction: "right" | "down" }} payload
   */
  insertCells(store, tx, payload) {
    shiftRegion(store, tx, payload, "insert");
  },

  /**
   * Delete a range's cells and slide the cells after it back (left or up). A
   * formula that pointed at a deleted cell becomes `#REF!`.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, tableId: string, range: object, direction: "left" | "up" }} payload
   */
  deleteCells(store, tx, payload) {
    shiftRegion(store, tx, payload, "delete");
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
