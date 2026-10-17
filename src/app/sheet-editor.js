/**
 * Sheet editor: selection, formula bar, keyboard navigation and row/column
 * structure controls over the pure renderer.
 *
 * The editor holds only UI state (which cell is selected, what the formula bar
 * is showing); every change is a workspace command, and the canvas is redrawn
 * from a model snapshot. Computed values come from one `TableEngines` cache per
 * table, rebuilt whenever the sheet changes.
 */

import { ensureSheetContent, cellKey, getCell, positionToA1 } from "../sheet/model.js";
import { renderSheet } from "../sheet/render.js";
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
 * @typedef {object} SheetEditorHandle
 * @property {HTMLElement} element
 * @property {() => void} refresh
 * @property {() => void} destroy
 * @property {() => { tableId: string, col: number, row: number } | null} getSelection
 * @property {(tableId: string, col: number, row: number) => void} selectCell
 * @property {() => void} commit
 * @property {(text: string) => void} setInputValue
 */

/**
 * Create a sheet editor bound to one sheet page.
 * @param {Workspace} workspace
 * @param {string} pageId
 * @param {{ onChange?: () => void }} [options]
 * @returns {SheetEditorHandle}
 */
export function createSheetEditor(workspace, pageId, options = {}) {
  const engines = new TableEngines();
  const element = h("div", { class: "sheet-editor" });
  /** @type {{ tableId: string, col: number, row: number } | null} */
  let selection = null;

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

  const actions = h("div", { class: "sheet-actions" });
  /** @type {[string, string, () => void][]} */
  const actionSpecs = [
    ["add-table", "New table", () => addTable()],
    ["add-row", "Row +", () => insertLine("row", "insert")],
    ["add-column", "Column +", () => insertLine("column", "insert")],
    ["delete-row", "Row −", () => insertLine("row", "delete")],
    ["delete-column", "Column −", () => insertLine("column", "delete")]
  ];
  for (const [key, label, handler] of actionSpecs) {
    const button = h("button", {
      class: "sheet-action",
      type: "button",
      text: label,
      "data-action": key
    });
    button.addEventListener("click", handler);
    actions.append(button);
  }

  const bar = h("div", { class: "sheet-bar" }, [address, input, actions]);
  const canvasWrap = h("div", { class: "sheet-canvas-wrap" });
  element.append(bar, canvasWrap);

  // -- selection ---------------------------------------------------------------

  function clampSelection() {
    if (!selection) return;
    const table = tableOf(selection.tableId);
    if (!table) {
      selection = null;
      return;
    }
    selection = {
      tableId: selection.tableId,
      col: Math.max(0, Math.min(selection.col, table.columnCount - 1)),
      row: Math.max(0, Math.min(selection.row, table.rowCount - 1))
    };
  }

  /**
   * @param {string} tableId
   * @param {number} col
   * @param {number} row
   */
  function selectCell(tableId, col, row) {
    selection = { tableId, col, row };
    refresh();
  }

  /** @param {number} deltaCol @param {number} deltaRow */
  function moveSelection(deltaCol, deltaRow) {
    if (!selection) {
      const first = content().tableOrder[0];
      if (first) selectCell(first, 0, 0);
      return;
    }
    const table = tableOf(selection.tableId);
    if (!table) return;
    const col = Math.max(0, Math.min(selection.col + deltaCol, table.columnCount - 1));
    const row = Math.max(0, Math.min(selection.row + deltaRow, table.rowCount - 1));
    selection = { tableId: selection.tableId, col, row };
    refresh();
  }

  // -- editing ----------------------------------------------------------------

  function commitInput(move) {
    if (!selection) return;
    const payload = parseCellInput(input.value);
    workspace.dispatch("setCell", {
      pageId,
      tableId: selection.tableId,
      col: selection.col,
      row: selection.row,
      cell: payload
    });
    if (move) moveSelection(move[0], move[1]);
    else refresh();
  }

  function clearSelectionCell() {
    if (!selection) return;
    workspace.dispatch("setCell", {
      pageId,
      tableId: selection.tableId,
      col: selection.col,
      row: selection.row,
      cell: null
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

  function insertLine(axis, mode) {
    if (!selection) return;
    const table = tableOf(selection.tableId);
    if (!table) return;
    const index = axis === "row" ? selection.row : selection.col;
    const command = `${mode}${axis === "row" ? "Row" : "Column"}`;
    workspace.dispatch(command, { pageId, tableId: selection.tableId, index });
  }

  function addTable() {
    workspace.dispatch("createTable", { pageId });
  }

  // -- rendering ---------------------------------------------------------------

  function refresh() {
    const snapshot = content();
    for (const table of Object.values(snapshot.tables)) engines.rebuild(table);
    clampSelection();

    clear(canvasWrap);
    canvasWrap.append(renderSheet(snapshot, { engines, selected: selection, interactive: true }));

    if (selection) {
      const table = snapshot.tables[selection.tableId];
      address.textContent = positionToA1(selection.col, selection.row);
      const cell = table ? getCell(table, selection.col, selection.row) : undefined;
      if (document.activeElement !== input) input.value = rawCellText(cell);
    } else {
      address.textContent = "—";
      input.value = "";
    }
  }

  // -- events ------------------------------------------------------------------

  canvasWrap.addEventListener("mousedown", (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const cell = target.closest("td.sheet-cell");
    if (cell) {
      const wrapper = target.closest(".sheet-table");
      const tableId = wrapper?.getAttribute("data-table-id");
      const col = Number(cell.getAttribute("data-col"));
      const row = Number(cell.getAttribute("data-row"));
      if (tableId && Number.isInteger(col) && Number.isInteger(row)) {
        event.preventDefault();
        selectCell(tableId, col, row);
        input.focus();
      }
      return;
    }
    const name = target.closest("[data-role=table-name]");
    if (name) {
      const tableId = name.getAttribute("data-table-id");
      if (tableId) {
        const table = tableOf(tableId);
        if (table && table.columnCount > 0 && table.rowCount > 0) selectCell(tableId, 0, 0);
      }
    }
  });

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
      moveSelection(...arrows[keyboard.key]);
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
    destroy: () => unsubscribe(),
    getSelection: () => (selection ? { ...selection } : null),
    selectCell,
    commit: () => commitInput(),
    setInputValue: (text) => {
      input.value = text;
    }
  };
}
