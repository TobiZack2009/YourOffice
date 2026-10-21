/**
 * Sheet renderer (spec §6.1–6.2): pure model → DOM.
 *
 * Renders the coordinate canvas with one absolutely positioned `<table>` per
 * table, header row/column, column widths and row heights from the table's
 * overrides, merged ranges as `colspan`/`rowspan`, and computed results resolved
 * through an injected `TableEngines` (so this module never evaluates formulas
 * itself). Text is set with textContent only.
 */

import { reconcileChildren } from "../core/reconcile.js";
import { displayValue } from "../calc/evaluator.js";
import { explain, isFormulaError } from "../calc/errors.js";
import {
  HEADER_HEIGHT,
  HEADER_WIDTH,
  cellKey,
  columnLabel,
  columnWidthOf,
  findMerge,
  mergeBounds,
  rowHeightOf,
  tableExtent
} from "../calc/model.js";

// The sizing helpers live in the model (commands place tables with them too).
export { HEADER_HEIGHT, HEADER_WIDTH, columnWidthOf, rowHeightOf, tableExtent };

/** @typedef {import("../calc/model.js").SheetContent} SheetContent */
/** @typedef {import("../calc/model.js").Table} Table */
/** @typedef {import("../references/table-engine.js").TableEngines} TableEngines */

/**
 * @typedef {object} SheetRenderOptions
 * @property {Document} [document]
 * @property {TableEngines} [engines] Computed-value source for formula cells.
 * @property {{ tableId: string, col: number, row: number, range?: { tableId: string, start: { col: number, row: number }, end: { col: number, row: number } }, ranges?: { tableId: string, start: { col: number, row: number }, end: { col: number, row: number } }[] } | null} [selected]
 *   The active cell, plus an optional selected range (normalised start <= end)
 *   or several ranges (`ranges`, which wins over `range`).
 * @property {boolean} [interactive] Adds hover/cursor affordances (editor mode).
 */

/**
 * @param {SheetRenderOptions} [options]
 * @returns {Document}
 */
function getDocument(options) {
  const doc = options?.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) throw new Error("no DOM available; pass options.document");
  return doc;
}

/** @typedef {{ start: { col: number, row: number }, end: { col: number, row: number } }} Rect */

/**
 * @param {Rect} rect
 * @param {number} col
 * @param {number} row
 */
function rectContains(rect, col, row) {
  return col >= rect.start.col && col <= rect.end.col && row >= rect.start.row && row <= rect.end.row;
}

/**
 * @param {Rect} a
 * @param {Rect} b
 */
export function rectsIntersect(a, b) {
  return (
    a.start.col <= b.end.col &&
    b.start.col <= a.end.col &&
    a.start.row <= b.end.row &&
    b.start.row <= a.end.row
  );
}

/**
 * @param {Table} table
 * @param {number} col
 * @param {number} row
 * @param {SheetRenderOptions} [options]
 * @returns {{ display: string, kind: "blank" | "literal" | "formula", error: boolean, explanation?: string }}
 */
export function resolveCell(table, col, row, options) {
  const cell = table.cells[cellKey(col, row)];
  if (!cell) return { display: "", kind: "blank", error: false };

  if (typeof cell.formula === "string") {
    const display = options?.engines
      ? options.engines.display(table, col, row)
      : cell.formula;
    const error = display.startsWith("#");
    if (error && options?.engines) {
      const value = options.engines.value(table, col, row);
      if (isFormulaError(value)) return { display, kind: "formula", error, explanation: explain(value).text };
    }
    return { display, kind: "formula", error };
  }
  if (cell.value !== undefined) {
    return { display: displayValue(cell.value), kind: "literal", error: false };
  }
  return { display: "", kind: "blank", error: false };
}

/**
 * The grab strip on a header's trailing edge (editor mode): dragging it resizes
 * the column or row.
 * @param {Document} doc
 * @param {"col-resize" | "row-resize"} role
 * @param {string} indexAttribute
 * @param {number} index
 * @returns {HTMLElement}
 */
function resizeHandle(doc, role, indexAttribute, index) {
  const handle = doc.createElement("span");
  handle.className = `sheet-resize-handle is-${role}`;
  handle.setAttribute("data-role", role);
  handle.setAttribute(indexAttribute, String(index));
  return handle;
}

/** Structure of a table drawn in a wrapper; while it matches, the wrapper is patched, not rebuilt. */
const structures = new WeakMap();

/**
 * @param {Table} table
 * @param {SheetRenderOptions} [options]
 * @returns {string}
 */
function structureOf(table, options) {
  return JSON.stringify([table.columnCount, table.rowCount, table.merges, Boolean(options?.interactive)]);
}

/**
 * Set a cell's displayed text, leaving any element children (fill handle, in-cell editor) alone.
 * @param {Document} doc
 * @param {HTMLElement} cell
 * @param {string} text
 */
function setCellText(doc, cell, text) {
  let node = null;
  for (const child of cell.childNodes) {
    if (child.nodeType === 3) {
      node = child;
      break;
    }
  }
  if (text === "") {
    node?.remove();
  } else if (node) {
    if (node.nodeValue !== text) node.nodeValue = text;
  } else {
    cell.insertBefore(doc.createTextNode(text), cell.firstChild);
  }
}

/**
 * Everything about a cell that comes from the model and the selection: kind, error, text,
 * selection classes and the fill handle. Used for the first draw and for in-place patches.
 * @param {Document} doc
 * @param {HTMLElement} cell
 * @param {Table} table
 * @param {number} col
 * @param {number} row
 * @param {SheetRenderOptions | undefined} options
 */
function paintCell(doc, cell, table, col, row, options) {
  const merge = findMerge(table, col, row);
  const info = resolveCell(table, col, row, options);
  if (cell.getAttribute("data-kind") !== info.kind) cell.setAttribute("data-kind", info.kind);
  cell.classList.toggle("is-error", info.error);
  if (info.error && info.explanation) {
    if (cell.title !== info.explanation) cell.title = info.explanation;
  } else if (cell.hasAttribute("title")) {
    cell.removeAttribute("title");
  }
  setCellText(doc, cell, info.display);

  const selected = options?.selected;
  const ranges = (selected?.ranges ?? (selected?.range ? [selected.range] : [])).filter(
    (range) => range.tableId === table.id
  );
  const handleRange = options?.interactive && ranges.length > 0 ? ranges[ranges.length - 1] : null;
  // A merged anchor stands for its whole block when testing selection.
  const block = merge ? { start: merge.start, end: merge.end } : { start: { col, row }, end: { col, row } };
  const here = Boolean(selected && selected.tableId === table.id);
  const isSelected = here && rectContains(block, /** @type {any} */ (selected).col, /** @type {any} */ (selected).row);
  let inRange = false;
  if (here && ranges.length > 0) {
    const multiple = ranges.length > 1 || ranges.some((r) => r.start.col !== r.end.col || r.start.row !== r.end.row);
    inRange = multiple && ranges.some((range) => rectsIntersect(block, range));
  }
  cell.classList.toggle("is-selected", isSelected);
  cell.classList.toggle("is-in-range", inRange);
  // The fill handle sits in the last cell of the active (last) range.
  const wantsHandle = here && handleRange !== null && rectContains(block, handleRange.end.col, handleRange.end.row);
  let handle = null;
  for (const child of cell.children) {
    if (child.classList.contains("sheet-fill-handle")) handle = child;
  }
  if (wantsHandle && !handle) {
    const created = doc.createElement("span");
    created.className = "sheet-fill-handle";
    created.setAttribute("data-role", "fill-handle");
    created.title = "Drag to fill";
    cell.appendChild(created);
  } else if (!wantsHandle && handle) {
    handle.remove();
  }
  cell.classList.toggle("is-interactive", Boolean(options?.interactive));
}

/**
 * Render one table as an HTML table with headers.
 * @param {Table} table
 * @param {SheetRenderOptions} [options]
 * @returns {HTMLElement}
 */
export function renderTable(table, options) {
  const doc = getDocument(options);
  const wrapper = doc.createElement("div");
  wrapper.className = "sheet-table";
  wrapper.setAttribute("data-table-id", table.id);
  wrapper.style.left = `${table.position.x}px`;
  wrapper.style.top = `${table.position.y}px`;

  const name = doc.createElement("div");
  name.className = "sheet-table-name";
  name.setAttribute("data-role", "table-name");
  name.setAttribute("data-table-id", table.id);
  name.textContent = table.name;
  wrapper.appendChild(name);

  const grid = doc.createElement("table");
  grid.className = "sheet-grid";

  const colgroup = doc.createElement("colgroup");
  const gutter = doc.createElement("col");
  gutter.style.width = `${HEADER_WIDTH}px`;
  colgroup.appendChild(gutter);
  for (let col = 0; col < table.columnCount; col++) {
    const element = doc.createElement("col");
    element.style.width = `${columnWidthOf(table, col)}px`;
    element.setAttribute("data-col", String(col));
    colgroup.appendChild(element);
  }
  grid.appendChild(colgroup);

  const head = doc.createElement("thead");
  const headRow = doc.createElement("tr");
  const corner = doc.createElement("th");
  corner.className = "sheet-corner";
  corner.style.height = `${HEADER_HEIGHT}px`;
  headRow.appendChild(corner);
  for (let col = 0; col < table.columnCount; col++) {
    const th = doc.createElement("th");
    th.className = "sheet-col-header";
    th.setAttribute("data-col", String(col));
    th.textContent = columnLabel(col);
    if (options?.interactive) th.appendChild(resizeHandle(doc, "col-resize", "data-col", col));
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  grid.appendChild(head);

  const body = doc.createElement("tbody");
  /** @type {Set<string>} */
  const covered = new Set();

  for (let row = 0; row < table.rowCount; row++) {
    const tr = doc.createElement("tr");
    tr.setAttribute("data-row", String(row));
    tr.style.height = `${rowHeightOf(table, row)}px`;

    const rowHeader = doc.createElement("th");
    rowHeader.className = "sheet-row-header";
    rowHeader.setAttribute("data-row", String(row));
    rowHeader.textContent = String(row + 1);
    if (options?.interactive) rowHeader.appendChild(resizeHandle(doc, "row-resize", "data-row", row));
    tr.appendChild(rowHeader);

    for (let col = 0; col < table.columnCount; col++) {
      if (covered.has(cellKey(col, row))) continue;

      const cell = doc.createElement("td");
      cell.className = "sheet-cell";
      cell.setAttribute("data-col", String(col));
      cell.setAttribute("data-row", String(row));
      cell.setAttribute("data-key", cellKey(col, row));

      const merge = findMerge(table, col, row);
      if (merge && merge.start.col === col && merge.start.row === row) {
        const bounds = mergeBounds(merge);
        if (bounds.cols > 1) cell.setAttribute("colspan", String(bounds.cols));
        if (bounds.rows > 1) cell.setAttribute("rowspan", String(bounds.rows));
        cell.classList.add("is-merged-anchor");
        for (let r = merge.start.row; r <= merge.end.row; r++) {
          for (let c = merge.start.col; c <= merge.end.col; c++) {
            if (r !== row || c !== col) covered.add(cellKey(c, r));
          }
        }
      } else if (merge) {
        continue; // defensive: covered cell reached out of order
      }

      paintCell(doc, cell, table, col, row, options);
      tr.appendChild(cell);
    }

    body.appendChild(tr);
  }

  grid.appendChild(body);
  wrapper.appendChild(grid);
  structures.set(wrapper, structureOf(table, options));
  return wrapper;
}

/**
 * Bring a drawn table up to date without rebuilding it: the cells stay the same elements and
 * only text, classes and sizes that differ are written. Valid while `structureOf` is unchanged.
 * @param {HTMLElement} wrapper
 * @param {Table} table
 * @param {SheetRenderOptions} [options]
 */
function patchTable(wrapper, table, options) {
  const doc = getDocument(options);
  wrapper.style.left = `${table.position.x}px`;
  wrapper.style.top = `${table.position.y}px`;
  const name = wrapper.querySelector(".sheet-table-name");
  if (name && name.textContent !== table.name) name.textContent = table.name;

  for (const col of wrapper.querySelectorAll("col[data-col]")) {
    const width = `${columnWidthOf(table, Number(col.getAttribute("data-col")))}px`;
    if (/** @type {HTMLElement} */ (col).style.width !== width) /** @type {HTMLElement} */ (col).style.width = width;
  }
  for (const tr of wrapper.querySelectorAll("tbody > tr")) {
    const height = `${rowHeightOf(table, Number(tr.getAttribute("data-row")))}px`;
    if (/** @type {HTMLElement} */ (tr).style.height !== height) /** @type {HTMLElement} */ (tr).style.height = height;
  }
  for (const grip of wrapper.querySelectorAll(".sheet-resize-handle.is-dragging")) grip.classList.remove("is-dragging");
  for (const cell of wrapper.querySelectorAll("td.sheet-cell")) {
    paintCell(doc, /** @type {HTMLElement} */ (cell), table, Number(cell.getAttribute("data-col")), Number(cell.getAttribute("data-row")), options);
  }
}

/**
 * @param {SheetContent} content
 * @returns {{ width: number, height: number }}
 */
function canvasSize(content) {
  let width = 480;
  let height = 320;
  for (const id of content.tableOrder) {
    const table = content.tables[id];
    if (!table) continue;
    const extent = tableExtent(table);
    width = Math.max(width, table.position.x + extent.width + 48);
    height = Math.max(height, table.position.y + extent.height + 48);
  }
  return { width, height };
}

/**
 * Render the whole sheet canvas.
 * @param {SheetContent} content
 * @param {SheetRenderOptions} [options]
 * @returns {HTMLElement}
 */
export function renderSheet(content, options) {
  const doc = getDocument(options);
  const canvas = doc.createElement("div");
  canvas.className = "sheet-canvas";
  canvas.setAttribute("role", "group");
  canvas.setAttribute("aria-label", "Sheet canvas");

  for (const id of content.tableOrder) {
    const table = content.tables[id];
    if (table) canvas.appendChild(renderTable(table, options));
  }

  const { width, height } = canvasSize(content);
  canvas.style.minWidth = `${width}px`;
  canvas.style.minHeight = `${height}px`;
  return canvas;
}

/**
 * Update a canvas made by `renderSheet` to match `content`. Tables are keyed by id: a table
 * whose structure (size, merges) is unchanged keeps its element and its cells, which are
 * patched in place; a changed table is redrawn; a removed one is dropped. The canvas must hold
 * nothing but tables (the editor takes its handle off first).
 * @param {HTMLElement} canvas
 * @param {SheetContent} content
 * @param {SheetRenderOptions} [options]
 */
export function updateSheet(canvas, content, options) {
  /** @type {Map<string, HTMLElement>} */
  const drawn = new Map();
  for (const child of canvas.children) {
    const id = child.getAttribute("data-table-id");
    if (id && child.classList.contains("sheet-table")) drawn.set(id, /** @type {HTMLElement} */ (child));
  }
  /** @type {HTMLElement[]} */
  const next = [];
  for (const id of content.tableOrder) {
    const table = content.tables[id];
    if (!table) continue;
    let wrapper = drawn.get(id);
    if (wrapper && structures.get(wrapper) === structureOf(table, options)) patchTable(wrapper, table, options);
    else wrapper = renderTable(table, options);
    next.push(wrapper);
  }
  reconcileChildren(canvas, next);
  const { width, height } = canvasSize(content);
  canvas.style.minWidth = `${width}px`;
  canvas.style.minHeight = `${height}px`;
}
