/**
 * Sheet editor: selection, formula bar, keyboard navigation and row/column
 * structure controls over the pure renderer.
 *
 * The editor holds only UI state (which cell is selected, what the formula bar
 * is showing); every change is a workspace command, and the canvas is redrawn
 * from a model snapshot. Computed values come from one `TableEngines` cache per
 * table, rebuilt whenever the sheet changes.
 */

import { ensureSheetContent, getCell, positionToA1 } from "../sheet/model.js";
import { columnWidthOf, rectsIntersect, renderSheet, rowHeightOf } from "../sheet/render.js";
import { TableEngines } from "../sheet/table-engine.js";
import { clear, h } from "./dom.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../sheet/model.js").Cell} Cell */

/**
 * Turn formula-bar text into a cell payload (or null to clear).
 * Numeric-looking input becomes a number, "TRUE"/"FALSE" booleans, a leading "="
 * a formula, everything else text.
 * @param {string} raw
 * @returns {Cell | null}
 */
export function parseCellInput(raw) {
  if (raw === "") return null;
  if (raw.startsWith("=")) return { formula: raw };
  const trimmed = raw.trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) return { value: Number(trimmed) };
  if (trimmed.toUpperCase() === "TRUE") return { value: true };
  if (trimmed.toUpperCase() === "FALSE") return { value: false };
  return { value: raw };
}

/**
 * Raw text shown in the formula bar for a cell.
 * @param {Cell | undefined} cell
 * @returns {string}
 */
export function rawCellText(cell) {
  if (!cell) return "";
  if (typeof cell.formula === "string") return cell.formula;
  if (cell.value === undefined || cell.value === null) return "";
  return String(cell.value);
}

/**
 * @typedef {{ col: number, row: number }} Position
 * @typedef {{ tableId: string, start: Position, end: Position }} SheetRange
 */

/**
 * @typedef {object} SheetEditorHandle
 * @property {HTMLElement} element
 * @property {() => void} refresh
 * @property {() => void} destroy
 * @property {() => { tableId: string, col: number, row: number } | null} getSelection The active (anchor) cell.
 * @property {() => SheetRange | null} getRange The normalised selected range (a single cell is a 1x1 range).
 * @property {(tableId: string, col: number, row: number) => void} selectCell
 * @property {(tableId: string, anchor: Position, focus: Position) => void} selectRange
 * @property {() => void} commit
 * @property {(text: string) => void} setInputValue
 * @property {() => boolean} canMerge
 * @property {() => boolean} canUnmerge
 * @property {() => void} mergeSelection
 * @property {() => void} unmergeSelection
 * @property {() => void} insertRow
 * @property {() => void} deleteRow
 * @property {() => void} insertColumn
 * @property {() => void} deleteColumn
 * @property {() => void} addTable
 * @property {() => string | null} selectedTableName
 * @property {(name: string) => void} renameSelectedTable
 * @property {() => number | null} selectedRowHeight
 * @property {() => number | null} selectedColumnWidth
 * @property {(height: number) => void} setSelectedRowHeight
 * @property {(width: number) => void} setSelectedColumnWidth
 */

/**
 * Create a sheet editor bound to one sheet page.
 * @param {Workspace} workspace
 * @param {string} pageId
 * @param {{ onChange?: () => void, onSelectionChange?: () => void }} [options]
 * @returns {SheetEditorHandle}
 */
export function createSheetEditor(workspace, pageId, options = {}) {
  const engines = new TableEngines();
  const element = h("div", { class: "sheet-editor" });
  /**
   * The active cell is the anchor; the focus is the opposite corner of the range.
   * @type {{ tableId: string, anchor: Position, focus: Position } | null}
   */
  let selection = null;
  let dragging = false;

  /** @returns {import("../sheet/model.js").SheetContent} */
  function content() {
    const page = workspace.getPage(pageId);
    return page ? ensureSheetContent(page) : { tables: {}, tableOrder: [] };
  }

  function tableOf(tableId) {
    return content().tables[tableId];
  }

  // -- chrome ------------------------------------------------------------------

  const address = h("span", { class: "cell-address", "data-role": "cell-address", text: "—" });
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      class: "formula-input",
      "data-role": "formula-input",
      "aria-label": "Cell content",
      spellcheck: "false",
      placeholder: "Value or formula"
    })
  );

  const bar = h("div", { class: "sheet-bar" }, [address, input]);
  const canvasWrap = h("div", { class: "sheet-canvas-wrap" });
  element.append(bar, canvasWrap);

  // -- selection ---------------------------------------------------------------

  /**
   * @param {Position} position
   * @param {import("../sheet/model.js").Table} table
   * @returns {Position}
   */
  function clampPosition(position, table) {
    return {
      col: Math.max(0, Math.min(position.col, table.columnCount - 1)),
      row: Math.max(0, Math.min(position.row, table.rowCount - 1))
    };
  }

  function clampSelection() {
    if (!selection) return;
    const table = tableOf(selection.tableId);
    if (!table) {
      selection = null;
      return;
    }
    selection = {
      tableId: selection.tableId,
      anchor: clampPosition(selection.anchor, table),
      focus: clampPosition(selection.focus, table)
    };
  }

  /** @returns {SheetRange | null} */
  function currentRange() {
    if (!selection) return null;
    const { anchor, focus } = selection;
    return {
      tableId: selection.tableId,
      start: { col: Math.min(anchor.col, focus.col), row: Math.min(anchor.row, focus.row) },
      end: { col: Math.max(anchor.col, focus.col), row: Math.max(anchor.row, focus.row) }
    };
  }

  /**
   * @param {string} tableId
   * @param {Position} anchor
   * @param {Position} focus
   */
  function selectRange(tableId, anchor, focus) {
    selection = { tableId, anchor: { ...anchor }, focus: { ...focus } };
    refresh();
  }

  /**
   * @param {string} tableId
   * @param {number} col
   * @param {number} row
   */
  function selectCell(tableId, col, row) {
    selectRange(tableId, { col, row }, { col, row });
  }

  /**
   * Move the selection. Without `extend` the active cell moves and the range
   * collapses; with it the focus corner moves and the anchor stays put.
   * @param {number} deltaCol
   * @param {number} deltaRow
   * @param {boolean} [extend]
   */
  function moveSelection(deltaCol, deltaRow, extend = false) {
    if (!selection) {
      const first = content().tableOrder[0];
      if (first) selectCell(first, 0, 0);
      return;
    }
    const table = tableOf(selection.tableId);
    if (!table) return;
    const from = extend ? selection.focus : selection.anchor;
    const next = clampPosition({ col: from.col + deltaCol, row: from.row + deltaRow }, table);
    selection = extend
      ? { tableId: selection.tableId, anchor: selection.anchor, focus: next }
      : { tableId: selection.tableId, anchor: next, focus: { ...next } };
    refresh();
  }

  // -- editing ----------------------------------------------------------------

  function commitInput(move) {
    if (!selection) return;
    const payload = parseCellInput(input.value);
    workspace.dispatch("setCell", {
      pageId,
      tableId: selection.tableId,
      col: selection.anchor.col,
      row: selection.anchor.row,
      cell: payload
    });
    if (move) moveSelection(move[0], move[1]);
    else refresh();
  }

  function clearSelectionCell() {
    const range = currentRange();
    if (!range) return;
    workspace.transact("clear cells", () => {
      for (let row = range.start.row; row <= range.end.row; row++) {
        for (let col = range.start.col; col <= range.end.col; col++) {
          if (!getCell(tableOf(range.tableId), col, row)) continue;
          workspace.dispatch("setCell", { pageId, tableId: range.tableId, col, row, cell: null });
        }
      }
    });
  }

  input.addEventListener("keydown", (event) => {
    const keyboard = /** @type {KeyboardEvent} */ (event);
    if (keyboard.key === "Enter") {
      keyboard.preventDefault();
      commitInput([0, 1]);
    } else if (keyboard.key === "Tab") {
      keyboard.preventDefault();
      commitInput([1, 0]);
    } else if (keyboard.key === "Escape") {
      keyboard.preventDefault();
      refresh();
      input.blur();
    }
  });

  // -- structure ---------------------------------------------------------------

  /**
   * @param {"row" | "column"} axis
   * @param {"insert" | "delete"} mode
   */
  function changeLines(axis, mode) {
    const range = currentRange();
    const table = range ? tableOf(range.tableId) : undefined;
    if (!range || !table) return;
    const index = axis === "row" ? range.start.row : range.start.col;
    const span = axis === "row" ? range.end.row - range.start.row + 1 : range.end.col - range.start.col + 1;
    const size = axis === "row" ? table.rowCount : table.columnCount;
    // A table always keeps at least one row and column.
    const count = mode === "delete" ? Math.min(span, size - 1) : span;
    if (count < 1) return;
    const command = `${mode}${axis === "row" ? "Row" : "Column"}`;
    workspace.dispatch(command, { pageId, tableId: range.tableId, index, count });
  }

  function addTable() {
    workspace.dispatch("createTable", { pageId });
  }

  /** Merges that overlap the selected range. */
  function mergesInRange() {
    const range = currentRange();
    const table = range ? tableOf(range.tableId) : undefined;
    if (!range || !table) return [];
    return table.merges.filter((merge) => rectsIntersect(merge, range));
  }

  function canMerge() {
    const range = currentRange();
    if (!range) return false;
    const cells = (range.end.col - range.start.col + 1) * (range.end.row - range.start.row + 1);
    return cells > 1 && mergesInRange().length === 0;
  }

  function canUnmerge() {
    return mergesInRange().length > 0;
  }

  function mergeSelection() {
    const range = currentRange();
    if (!range || !canMerge()) return;
    workspace.dispatch("mergeCells", {
      pageId,
      tableId: range.tableId,
      start: range.start,
      end: range.end
    });
  }

  function unmergeSelection() {
    const range = currentRange();
    const merges = mergesInRange();
    if (!range || merges.length === 0) return;
    workspace.transact("unmerge cells", () => {
      for (const merge of merges) {
        workspace.dispatch("unmergeCells", {
          pageId,
          tableId: range.tableId,
          col: merge.start.col,
          row: merge.start.row
        });
      }
    });
  }

  function selectedTableName() {
    return selection ? (tableOf(selection.tableId)?.name ?? null) : null;
  }

  /** @param {string} name */
  function renameSelectedTable(name) {
    if (!selection) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    workspace.dispatch("renameTable", { pageId, tableId: selection.tableId, name: trimmed });
  }

  function selectedRowHeight() {
    const table = selection ? tableOf(selection.tableId) : undefined;
    return selection && table ? rowHeightOf(table, selection.anchor.row) : null;
  }

  function selectedColumnWidth() {
    const table = selection ? tableOf(selection.tableId) : undefined;
    return selection && table ? columnWidthOf(table, selection.anchor.col) : null;
  }

  /** @param {number} height */
  function setSelectedRowHeight(height) {
    const range = currentRange();
    if (!range || !Number.isFinite(height) || height <= 0) return;
    workspace.transact("set row height", () => {
      for (let row = range.start.row; row <= range.end.row; row++) {
        workspace.dispatch("setRowHeight", { pageId, tableId: range.tableId, row, height });
      }
    });
  }

  /** @param {number} width */
  function setSelectedColumnWidth(width) {
    const range = currentRange();
    if (!range || !Number.isFinite(width) || width <= 0) return;
    workspace.transact("set column width", () => {
      for (let column = range.start.col; column <= range.end.col; column++) {
        workspace.dispatch("setColumnWidth", { pageId, tableId: range.tableId, column, width });
      }
    });
  }

  // -- rendering ---------------------------------------------------------------

  function refresh() {
    const snapshot = content();
    for (const table of Object.values(snapshot.tables)) engines.rebuild(table);
    clampSelection();

    clear(canvasWrap);
    const range = currentRange();
    canvasWrap.append(
      renderSheet(snapshot, {
        engines,
        interactive: true,
        selected:
          selection && range
            ? { tableId: selection.tableId, col: selection.anchor.col, row: selection.anchor.row, range }
            : null
      })
    );

    if (selection) {
      const table = snapshot.tables[selection.tableId];
      const { col, row } = selection.anchor;
      address.textContent = positionToA1(col, row);
      const cell = table ? getCell(table, col, row) : undefined;
      if (document.activeElement !== input) input.value = rawCellText(cell);
    } else {
      address.textContent = "—";
      input.value = "";
    }
    options.onSelectionChange?.();
  }

  // -- events ------------------------------------------------------------------

  /**
   * @param {EventTarget | null} target
   * @returns {{ tableId: string, col: number, row: number } | null}
   */
  function cellFromTarget(target) {
    const cell = /** @type {HTMLElement} */ (target)?.closest?.("td.sheet-cell");
    if (!cell) return null;
    const tableId = cell.closest(".sheet-table")?.getAttribute("data-table-id");
    const col = Number(cell.getAttribute("data-col"));
    const row = Number(cell.getAttribute("data-row"));
    return tableId && Number.isInteger(col) && Number.isInteger(row) ? { tableId, col, row } : null;
  }

  canvasWrap.addEventListener("mousedown", (event) => {
    const mouse = /** @type {MouseEvent} */ (event);
    const hit = cellFromTarget(event.target);
    if (hit) {
      event.preventDefault();
      if (mouse.shiftKey && selection && selection.tableId === hit.tableId) {
        selectRange(hit.tableId, selection.anchor, { col: hit.col, row: hit.row });
      } else {
        selectCell(hit.tableId, hit.col, hit.row);
      }
      dragging = true;
      input.focus();
      return;
    }
    const name = /** @type {HTMLElement} */ (event.target).closest("[data-role=table-name]");
    if (name) {
      const tableId = name.getAttribute("data-table-id");
      if (tableId) {
        const table = tableOf(tableId);
        if (table && table.columnCount > 0 && table.rowCount > 0) selectCell(tableId, 0, 0);
      }
    }
  });

  canvasWrap.addEventListener("mouseover", (event) => {
    if (!dragging || !selection) return;
    const hit = cellFromTarget(event.target);
    if (!hit || hit.tableId !== selection.tableId) return;
    if (hit.col === selection.focus.col && hit.row === selection.focus.row) return;
    selectRange(hit.tableId, selection.anchor, { col: hit.col, row: hit.row });
  });

  const stopDragging = () => {
    dragging = false;
  };
  document.addEventListener("mouseup", stopDragging);

  element.addEventListener("keydown", (event) => {
    if (event.target === input) return;
    const keyboard = /** @type {KeyboardEvent} */ (event);
    if (!selection) return;
    const arrows = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0]
    };
    if (arrows[keyboard.key]) {
      keyboard.preventDefault();
      moveSelection(arrows[keyboard.key][0], arrows[keyboard.key][1], keyboard.shiftKey);
      input.focus();
      return;
    }
    if (keyboard.key === "Tab") {
      keyboard.preventDefault();
      moveSelection(1, 0);
      input.focus();
      return;
    }
    if (keyboard.key === "Enter") {
      keyboard.preventDefault();
      moveSelection(0, 1);
      input.focus();
      return;
    }
    if (keyboard.key === "Backspace" || keyboard.key === "Delete") {
      keyboard.preventDefault();
      clearSelectionCell();
      return;
    }
    if (keyboard.key.length === 1 && !keyboard.metaKey && !keyboard.ctrlKey && !keyboard.altKey) {
      keyboard.preventDefault();
      input.value = keyboard.key;
      input.focus();
    }
  });

  const unsubscribe = workspace.events.on("change", () => {
    refresh();
    options.onChange?.();
  });

  refresh();

  return {
    element,
    refresh,
    destroy: () => {
      unsubscribe();
      document.removeEventListener("mouseup", stopDragging);
    },
    getSelection: () =>
      selection ? { tableId: selection.tableId, col: selection.anchor.col, row: selection.anchor.row } : null,
    getRange: currentRange,
    selectCell,
    selectRange,
    commit: () => commitInput(),
    setInputValue: (text) => {
      input.value = text;
    },
    canMerge,
    canUnmerge,
    mergeSelection,
    unmergeSelection,
    insertRow: () => changeLines("row", "insert"),
    deleteRow: () => changeLines("row", "delete"),
    insertColumn: () => changeLines("column", "insert"),
    deleteColumn: () => changeLines("column", "delete"),
    addTable,
    selectedTableName,
    renameSelectedTable,
    selectedRowHeight,
    selectedColumnWidth,
    setSelectedRowHeight,
    setSelectedColumnWidth
  };
}
