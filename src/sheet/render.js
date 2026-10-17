/**
 * Sheet renderer (spec §6.1–6.2): pure model → DOM.
 *
 * Renders the coordinate canvas with one absolutely positioned `<table>` per
 * table, header row/column, column widths and row heights from the table's
 * overrides, merged ranges as `colspan`/`rowspan`, and computed results resolved
 * through an injected `TableEngines` (so this module never evaluates formulas
 * itself). Text is set with textContent only.
 */

import { displayValue } from "./evaluator.js";
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
} from "./model.js";

// The sizing helpers live in the model (commands place tables with them too).
export { HEADER_HEIGHT, HEADER_WIDTH, columnWidthOf, rowHeightOf, tableExtent };

/** @typedef {import("./model.js").SheetContent} SheetContent */
/** @typedef {import("./model.js").Table} Table */
/** @typedef {import("./table-engine.js").TableEngines} TableEngines */

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
 * @returns {{ display: string, kind: "blank" | "literal" | "formula", error: boolean }}
 */
export function resolveCell(table, col, row, options) {
  const cell = table.cells[cellKey(col, row)];
  if (!cell) return { display: "", kind: "blank", error: false };

  if (typeof cell.formula === "string") {
    const display = options?.engines
      ? options.engines.display(table, col, row)
      : cell.formula;
    return { display, kind: "formula", error: display.startsWith("#") };
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
  const ranges = (options?.selected?.ranges ?? (options?.selected?.range ? [options.selected.range] : [])).filter(
    (range) => range.tableId === table.id
  );
  const handleRange = options?.interactive && ranges.length > 0 ? ranges[ranges.length - 1] : null;

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

      const info = resolveCell(table, col, row, options);
      cell.setAttribute("data-kind", info.kind);
      if (info.error) cell.classList.add("is-error");
      cell.textContent = info.display;

      // A merged anchor stands for its whole block when testing selection.
      const block = merge
        ? { start: merge.start, end: merge.end }
        : { start: { col, row }, end: { col, row } };
      const selected = options?.selected;
      if (selected && selected.tableId === table.id) {
        if (rectContains(block, selected.col, selected.row)) cell.classList.add("is-selected");
        if (ranges.length > 0) {
          const multiple =
            ranges.length > 1 || ranges.some((r) => r.start.col !== r.end.col || r.start.row !== r.end.row);
          if (multiple && ranges.some((range) => rectsIntersect(block, range))) {
            cell.classList.add("is-in-range");
          }
        }
        // The fill handle sits in the last cell of the active (last) range.
        if (handleRange && rectContains(block, handleRange.end.col, handleRange.end.row)) {
          const handle = doc.createElement("span");
          handle.className = "sheet-fill-handle";
          handle.setAttribute("data-role", "fill-handle");
          handle.title = "Drag to fill";
          cell.appendChild(handle);
        }
      }
      if (options?.interactive) cell.classList.add("is-interactive");

      tr.appendChild(cell);
    }

    body.appendChild(tr);
  }

  grid.appendChild(body);
  wrapper.appendChild(grid);
  return wrapper;
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

  let width = 480;
  let height = 320;

  for (const id of content.tableOrder) {
    const table = content.tables[id];
    if (!table) continue;
    canvas.appendChild(renderTable(table, options));
    const extent = tableExtent(table);
    width = Math.max(width, table.position.x + extent.width + 48);
    height = Math.max(height, table.position.y + extent.height + 48);
  }

  canvas.style.minWidth = `${width}px`;
  canvas.style.minHeight = `${height}px`;
  return canvas;
}
