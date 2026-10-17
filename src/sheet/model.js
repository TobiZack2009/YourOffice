/**
 * Sheet page model (spec §6.1–6.3).
 *
 * A sheet page is a coordinate canvas holding several independent tables:
 *
 *   { tables: { [id]: Table }, tableOrder: string[] }
 *
 * Each table owns a local A1 coordinate space (0-based internally), sparse cell
 * storage keyed "col,row", row/column overrides, merged ranges and a canvas
 * position. Cells hold either a literal `value` or a `formula` — never both, and
 * computed results live only in the recalculation engine, never in the model
 * (formula text stays authoritative, spec §6.3).
 *
 * Storage is sparse by construction: only meaningful cells are allocated, so no
 * two-dimensional array is ever materialised (spec §6.3).
 */

import { CommandError } from "../core/errors.js";
import { createId } from "../core/ids.js";
import { formatA1, MAX_COLUMN, MAX_ROW, parseA1 } from "./references.js";

/** @typedef {import("../workspace/schema.js").PageEnvelope} PageEnvelope */
/** @typedef {import("./references.js").CellRef} CellRef */

/**
 * @typedef {object} Cell
 * @property {string | number | boolean | null} [value] Literal input (mutually exclusive with formula).
 * @property {string} [formula] Formula text starting with "=".
 * @property {Record<string, unknown>} [style]
 */

/**
 * @typedef {object} Merge
 * @property {{ col: number, row: number }} start Inclusive top-left.
 * @property {{ col: number, row: number }} end Inclusive bottom-right.
 */

/**
 * @typedef {object} Table
 * @property {string} id
 * @property {string} name
 * @property {{ x: number, y: number }} position Canvas position in pixels.
 * @property {number} rowCount
 * @property {number} columnCount
 * @property {number} rowHeight
 * @property {number} columnWidth
 * @property {Record<string, Cell>} cells Sparsely keyed "col,row".
 * @property {Record<string, { height: number }>} rowOverrides
 * @property {Record<string, { width: number }>} columnOverrides
 * @property {Merge[]} merges
 */

/** @typedef {{ tables: Record<string, Table>, tableOrder: string[] }} SheetContent */

export const SHEET_DEFAULTS = {
  columns: 8,
  rows: 20,
  columnWidth: 96,
  rowHeight: 24,
  gap: 32
};

const KEY_PATTERN = /^([0-9]+),([0-9]+)$/;

/**
 * Sparse-storage key for a cell position (0-based, matching the recalc engine).
 * @param {number} col
 * @param {number} row
 * @returns {string}
 */
export function cellKey(col, row) {
  return `${col},${row}`;
}

/**
 * @param {string} key
 * @returns {{ col: number, row: number } | null}
 */
export function parseCellKey(key) {
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  return { col: Number(match[1]), row: Number(match[2]) };
}

/**
 * 1-based A1 text for a 0-based position (what the user sees).
 * @param {number} col
 * @param {number} row
 * @returns {string}
 */
export function positionToA1(col, row) {
  return formatA1({ col: col + 1, row: row + 1 });
}

/**
 * 0-based position for A1 text.
 * @param {string} text
 * @returns {{ col: number, row: number } | null}
 */
export function a1ToPosition(text) {
  const ref = parseA1(text);
  return ref ? { col: ref.col - 1, row: ref.row - 1 } : null;
}

/**
 * Column letters for a 0-based column index.
 * @param {number} col
 * @returns {string}
 */
export function columnLabel(col) {
  return formatA1({ col: col + 1, row: 1 }).replace(/[0-9]+$/, "");
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Validate a single cell.
 * @param {unknown} cell
 * @returns {string[]} error messages (empty when valid).
 */
export function validateCell(cell) {
  if (!isPlainObject(cell)) return ["cell must be an object"];
  /** @type {string[]} */
  const errors = [];
  const hasFormula = cell.formula !== undefined;
  const hasValue = Object.prototype.hasOwnProperty.call(cell, "value");

  if (hasFormula && hasValue) {
    errors.push("cell must not carry both formula and value");
  }
  if (hasFormula) {
    if (typeof cell.formula !== "string" || cell.formula.length === 0) {
      errors.push("cell.formula must be a non-empty string");
    } else if (!cell.formula.startsWith("=")) {
      errors.push('cell.formula must start with "="');
    }
  }
  if (hasValue) {
    const type = typeof cell.value;
    if (cell.value !== null && type !== "string" && type !== "number" && type !== "boolean") {
      errors.push("cell.value must be a string, number, boolean or null");
    }
    if (type === "number" && !Number.isFinite(cell.value)) {
      errors.push("cell.value must be a finite number");
    }
  }
  if (cell.style !== undefined && !isPlainObject(cell.style)) {
    errors.push("cell.style must be an object");
  }
  return errors;
}

/**
 * Validate one table.
 * @param {unknown} table
 * @returns {string[]} error messages (empty when valid).
 */
export function validateTable(table) {
  if (!isPlainObject(table)) return ["table must be an object"];
  /** @type {string[]} */
  const errors = [];

  if (typeof table.id !== "string" || table.id.length === 0) {
    errors.push("table.id must be a non-empty string");
  }
  if (typeof table.name !== "string") errors.push("table.name must be a string");

  if (!isPlainObject(table.position)) {
    errors.push("table.position must be an object");
  } else {
    if (typeof table.position.x !== "number" || !Number.isFinite(table.position.x)) {
      errors.push("table.position.x must be a finite number");
    }
    if (typeof table.position.y !== "number" || !Number.isFinite(table.position.y)) {
      errors.push("table.position.y must be a finite number");
    }
  }

  for (const field of ["rowCount", "columnCount"]) {
    const value = table[field];
    if (!Number.isInteger(value) || /** @type {number} */ (value) < 1) {
      errors.push(`table.${field} must be an integer ≥ 1`);
    } else if (field === "rowCount" && /** @type {number} */ (value) > MAX_ROW) {
      errors.push(`table.${field} exceeds the row limit`);
    } else if (field === "columnCount" && /** @type {number} */ (value) > MAX_COLUMN) {
      errors.push(`table.${field} exceeds the column limit`);
    }
  }
  for (const field of ["rowHeight", "columnWidth"]) {
    if (!isPositiveNumber(table[field])) errors.push(`table.${field} must be a positive number`);
  }

  const rows = Number.isInteger(table.rowCount) ? Number(table.rowCount) : 0;
  const columns = Number.isInteger(table.columnCount) ? Number(table.columnCount) : 0;

  if (!isPlainObject(table.cells)) {
    errors.push("table.cells must be an object");
  } else {
    for (const [key, cell] of Object.entries(table.cells)) {
      const position = parseCellKey(key);
      if (!position) {
        errors.push(`table.cells key "${key}" must be "col,row"`);
        continue;
      }
      if (position.col >= columns || position.row >= rows) {
        errors.push(`table.cells["${key}"] is outside the table bounds`);
      }
      errors.push(...validateCell(cell).map((message) => `table.cells["${key}"]: ${message}`));
    }
  }

  if (!isPlainObject(table.rowOverrides)) {
    errors.push("table.rowOverrides must be an object");
  } else {
    for (const [key, override] of Object.entries(table.rowOverrides)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= rows) {
        errors.push(`table.rowOverrides key "${key}" is out of range`);
      }
      if (!isPlainObject(override) || !isPositiveNumber(override.height)) {
        errors.push(`table.rowOverrides["${key}"].height must be a positive number`);
      }
    }
  }

  if (!isPlainObject(table.columnOverrides)) {
    errors.push("table.columnOverrides must be an object");
  } else {
    for (const [key, override] of Object.entries(table.columnOverrides)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= columns) {
        errors.push(`table.columnOverrides key "${key}" is out of range`);
      }
      if (!isPlainObject(override) || !isPositiveNumber(override.width)) {
        errors.push(`table.columnOverrides["${key}"].width must be a positive number`);
      }
    }
  }

  if (!Array.isArray(table.merges)) {
    errors.push("table.merges must be an array");
  } else {
    table.merges.forEach((merge, index) => {
      if (!isPlainObject(merge) || !isPlainObject(merge.start) || !isPlainObject(merge.end)) {
        errors.push(`table.merges[${index}] must have start and end positions`);
        return;
      }
      const { start, end } = /** @type {Merge} */ (merge);
      if (
        !Number.isInteger(start.col) ||
        !Number.isInteger(start.row) ||
        !Number.isInteger(end.col) ||
        !Number.isInteger(end.row)
      ) {
        errors.push(`table.merges[${index}] positions must be integers`);
        return;
      }
      if (start.col > end.col || start.row > end.row) {
        errors.push(`table.merges[${index}] must be normalised (start before end)`);
      }
      if (
        start.col < 0 ||
        start.row < 0 ||
        end.col >= columns ||
        end.row >= rows
      ) {
        errors.push(`table.merges[${index}] is outside the table bounds`);
      }
    });
  }

  return errors;
}

/**
 * Validate a whole sheet content object.
 * @param {unknown} content
 * @returns {string[]} error messages (empty when valid).
 */
export function validateSheetContent(content) {
  if (!isPlainObject(content)) return ["content must be an object"];
  /** @type {string[]} */
  const errors = [];

  if (!isPlainObject(content.tables)) errors.push("tables must be an object");
  if (!Array.isArray(content.tableOrder)) errors.push("tableOrder must be an array");
  if (errors.length > 0) return errors;

  const tables = /** @type {Record<string, unknown>} */ (content.tables);
  const order = /** @type {unknown[]} */ (content.tableOrder);
  const seen = new Set();

  for (const id of order) {
    if (typeof id !== "string") {
      errors.push("tableOrder must contain only strings");
      continue;
    }
    if (seen.has(id)) errors.push(`tableOrder lists "${id}" more than once`);
    seen.add(id);
    if (!Object.prototype.hasOwnProperty.call(tables, id)) {
      errors.push(`tableOrder references missing table "${id}"`);
    }
  }

  for (const [id, table] of Object.entries(tables)) {
    if (!isPlainObject(table) || table.id !== id) {
      errors.push(`tables["${id}"].id must match its key`);
    }
    errors.push(...validateTable(table).map((message) => `tables["${id}"]: ${message}`));
    if (!seen.has(id)) errors.push(`table "${id}" is not reachable from tableOrder`);
  }

  return errors;
}

/**
 * Empty sheet content.
 * @returns {SheetContent}
 */
export function createSheetContent() {
  return { tables: {}, tableOrder: [] };
}

/**
 * Create a validated table with defaults.
 * @param {Record<string, unknown>} [fields]
 * @returns {Table}
 * @throws {CommandError} When the table is invalid.
 */
export function createTable(fields = {}) {
  const position = isPlainObject(fields.position) ? fields.position : {};
  const table = /** @type {Table} */ ({
    id: createId("table"),
    name: "Table 1",
    position: {
      x: typeof position.x === "number" ? position.x : SHEET_DEFAULTS.gap,
      y: typeof position.y === "number" ? position.y : SHEET_DEFAULTS.gap
    },
    rowCount: SHEET_DEFAULTS.rows,
    columnCount: SHEET_DEFAULTS.columns,
    rowHeight: SHEET_DEFAULTS.rowHeight,
    columnWidth: SHEET_DEFAULTS.columnWidth,
    cells: {},
    rowOverrides: {},
    columnOverrides: {},
    merges: [],
    ...fields
  });

  if (!isPlainObject(table.cells)) table.cells = {};
  if (!isPlainObject(table.rowOverrides)) table.rowOverrides = {};
  if (!isPlainObject(table.columnOverrides)) table.columnOverrides = {};
  if (!Array.isArray(table.merges)) table.merges = [];

  const errors = validateTable(table);
  if (errors.length > 0) {
    throw new CommandError(`invalid table: ${errors.join("; ")}`, "invalidTable");
  }
  return table;
}

/**
 * Ensure a page envelope carries sheet content, initialising it when absent.
 * @param {PageEnvelope} page
 * @returns {SheetContent}
 */
export function ensureSheetContent(page) {
  const content = /** @type {SheetContent | undefined} */ (page.content);
  if (!content || !isPlainObject(content.tables) || !Array.isArray(content.tableOrder)) {
    const fresh = createSheetContent();
    page.content = /** @type {Record<string, unknown>} */ (fresh);
    return fresh;
  }
  for (const table of Object.values(content.tables)) {
    if (!isPlainObject(table.cells)) table.cells = {};
    if (!isPlainObject(table.rowOverrides)) table.rowOverrides = {};
    if (!isPlainObject(table.columnOverrides)) table.columnOverrides = {};
    if (!Array.isArray(table.merges)) table.merges = [];
  }
  return content;
}

/**
 * @param {Table} table
 * @param {number} col
 * @param {number} row
 * @returns {Cell | undefined}
 */
export function getCell(table, col, row) {
  return table.cells[cellKey(col, row)];
}

/**
 * Set (or with null, remove) a cell. Keeps storage sparse.
 * @param {Table} table
 * @param {number} col
 * @param {number} row
 * @param {Cell | null} cell
 */
export function setCell(table, col, row, cell) {
  const key = cellKey(col, row);
  if (cell === null) {
    delete table.cells[key];
    return;
  }
  table.cells[key] = cell;
}

/**
 * The merge covering a position, if any.
 * @param {Table} table
 * @param {number} col
 * @param {number} row
 * @returns {Merge | undefined}
 */
export function findMerge(table, col, row) {
  return table.merges.find(
    (merge) =>
      col >= merge.start.col &&
      col <= merge.end.col &&
      row >= merge.start.row &&
      row <= merge.end.row
  );
}

/**
 * Whether a position is the top-left anchor of its merge.
 * @param {Table} table
 * @param {number} col
 * @param {number} row
 * @returns {boolean}
 */
export function isMergeAnchor(table, col, row) {
  const merge = findMerge(table, col, row);
  return Boolean(merge && merge.start.col === col && merge.start.row === row);
}
