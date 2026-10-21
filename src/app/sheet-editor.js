/**
 * Sheet editor: selection, formula bar, keyboard navigation and row/column
 * structure controls over the pure renderer.
 *
 * The editor holds only UI state (which cell is selected, what the formula bar
 * is showing); every change is a workspace command, and the canvas is redrawn
 * from a model snapshot. Computed values come from one `TableEngines` cache per
 * table, rebuilt whenever the sheet changes.
 */


import { defaultNotice } from "./notice.js";
import { pageContent, pageExists } from "../workspace/selectors.js";
import { explain, isFormulaError } from "../sheet/errors.js";
import { getCell, positionToA1, readSheetContent } from "../sheet/model.js";
import { renderSheet, updateSheet } from "../sheet/render.js";
import { TableEngines, changeAffectsBook } from "../sheet/table-engine.js";
import { h } from "./dom.js";
import { readSheetSelection } from "./selection.js";
import { createPopoverHost } from "./popover.js";
import { rawCellText } from "./sheet-cell-input.js";
import { createSheetSelection } from "./sheet-selection.js";
import { createSheetCellEdit } from "./sheet-cell-edit.js";
import { createSheetClipboard } from "./sheet-clipboard.js";
import { createSheetStructure } from "./sheet-structure.js";
import { createSheetMenus } from "./sheet-menus.js";
import { createSheetGestures } from "./sheet-gestures.js";
import { createSheetInput } from "./sheet-input.js";

export { parseCellInput, rawCellText } from "./sheet-cell-input.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */

/**
 * @typedef {{ col: number, row: number }} Position
 * @typedef {{ tableId: string, start: Position, end: Position }} SheetRange
 * @typedef {{ start: Position, end: Position }} Rect
 */

/**
 * @typedef {object} SheetEditorHandle
 * @property {HTMLElement} element
 * @property {() => void} refresh
 * @property {() => void} destroy
 * @property {() => { tableId: string, col: number, row: number } | null} getSelection The active (anchor) cell.
 * @property {() => SheetRange | null} getRange The active (most recent) normalised range; a single cell is a 1x1 range.
 * @property {() => SheetRange[]} getRanges Every selected range, the active one last.
 * @property {(tableId: string, col: number, row: number) => void} selectCell
 * @property {(tableId: string, anchor: Position, focus: Position) => void} selectRange Replaces the whole selection.
 * @property {(tableId: string, anchor: Position, focus: Position) => void} addRange Adds a range to the selection (Ctrl/Cmd+click).
 * @property {() => void} fillSelection Writes the formula-bar content into the active cell and every selected range.
 * @property {() => void} fillDown
 * @property {() => void} fillRight
 * @property {() => boolean} copy
 * @property {() => boolean} cut
 * @property {() => boolean} paste
 * @property {() => boolean} canPaste
 * @property {() => boolean} hasSelection
 * @property {() => void} clearSelection Empties every selected cell.
 * @property {(direction: "right" | "down") => boolean} insertCells Insert blank cells over the active range, sliding the rest.
 * @property {(direction: "left" | "up") => boolean} deleteCells Delete the active range, sliding the rest back.
 * @property {(from: Position, to: Position) => boolean} moveRange Move the active range by the offset between two cells (what dragging does).
 * @property {(extent: Position) => boolean} fillRangeTo Fill from the active range out to a cell (what dragging the fill handle does).
 * @property {(point: { x: number, y: number }) => void} openContextMenu
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
 * @param {{ onChange?: () => void, onSelectionChange?: () => void, navigate?: (pageId: string) => void, notice?: import("./notice.js").Notice }} [options]
 * @returns {SheetEditorHandle}
 */
export function createSheetEditor(workspace, pageId, options = {}) {
  const notice = options.notice ?? defaultNotice;
  const guard = notice.guard;
  const engines = new TableEngines(() => workspace._data);
  const element = h("div", { class: "sheet-editor" });
  /**
   * The editor's mutable state, in one place so the modules can share it.
   * - `selection`: the active range is `anchor`..`focus` (the anchor is the active cell); `others`
   *   are earlier ranges added with Ctrl/Cmd+click, all in the same table.
   * - `gesture`: the mouse gesture in progress, if any.
   * - `inputDirty`: true once the user typed into the formula bar and has not committed yet.
   * - `cellEditing`: true while the active cell is being edited in place.
   * - `suppressBlur`: set while the in-cell input is moved or removed on purpose, so its blur is not a "click away".
   * - `clipboard`: a range that was copied or cut, pasted by `paste()`.
   * - `justDragged`: set after a table drag so the click that follows the release does not open the menu.
   * @type {{
   *   selection: { tableId: string, anchor: Position, focus: Position, others: Rect[] } | null,
   *   gesture: null
   *     | { type: "select" }
   *     | { type: "fill", tableId: string, source: Rect, target: Rect | null, hit: Position | null }
   *     | { type: "move", tableId: string, grab: Position, range: Rect, delta: Position | null }
   *     | { type: "resize", axis: "col" | "row", tableId: string, index: number, origin: number, original: number, size: number }
   *     | { type: "tablemove", tableId: string, originX: number, originY: number, start: Position, x: number, y: number, moved: boolean },
   *   inputDirty: boolean,
   *   cellEditing: boolean,
   *   suppressBlur: boolean,
   *   clipboard: { tableId: string, range: Rect, cut: boolean } | null,
   *   justDragged: boolean
   * }}
   */
  const st = {
    selection: null,
    gesture: null,
    inputDirty: false,
    cellEditing: false,
    suppressBlur: false,
    clipboard: null,
    justDragged: false
  };

  /** @returns {import("../sheet/model.js").SheetContent} */
  function content() {
    return pageExists(workspace, pageId)
      ? readSheetContent(pageContent(workspace, pageId), pageId)
      : { tables: {}, tableOrder: [] };
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

  // The in-cell editor. It shares its text with the formula bar, so either can be typed into.
  const cellInput = /** @type {HTMLInputElement} */ (
    h("input", {
      class: "sheet-cell-editor",
      "data-role": "cell-editor",
      "aria-label": "Edit cell",
      spellcheck: "false"
    })
  );

  const bar = h("div", { class: "sheet-bar" }, [address, input]);
  const message = h("div", { class: "formula-message", role: "status", "data-role": "formula-message" });
  const canvasWrap = h("div", { class: "sheet-canvas-wrap", tabindex: "-1", "data-history": "model" });
  element.append(bar, message, canvasWrap);
  const popovers = createPopoverHost(document.body);

  // -- modules -----------------------------------------------------------------

  // The modules share this kernel. A function one module offers another is added to it as the
  // module is built, so a module can destructure what was built before it and must call
  // `ed.name(...)` for what is built after it.
  const ed = { workspace, pageId, options, notice, guard, engines, element, address, input, cellInput, message, canvasWrap, popovers, st, content, tableOf, refresh };
  const build = (create) => {
    const api = create(ed);
    Object.assign(ed, api);
    return api;
  };
  build(createSheetSelection);
  build(createSheetCellEdit);
  build(createSheetClipboard);
  build(createSheetStructure);
  build(createSheetMenus);
  const pointer = build(createSheetGestures);
  build(createSheetInput);
  const { addRange, addTable, allRanges, canMerge, canPaste, canUnmerge, changeLines, clampSelection, clearSelectionCell, commitInput, copy, currentRange, cut, deleteCells, fillFromEdge, fillRangeTo, fillSelection, insertCells, mergeSelection, moveRange, openContextMenu, paste, placeCellEditor, placeSheetHandle, renameSelectedTable, selectCell, selectRange, selectedColumnWidth, selectedRowHeight, selectedTableName, setSelectedColumnWidth, setSelectedRowHeight, unmergeSelection } = ed;

  /** @param {{ pages: string[], registry?: boolean } | null} [change] The change being applied, if any. */
  function refresh(change = null) {
    const snapshot = content();
    engines.refresh(change);
    clampSelection();
    if (st.clipboard && !snapshot.tables[st.clipboard.tableId]) st.clipboard = null;

    // The canvas is patched in place: tables are keyed by id and cells by position, so the
    // in-cell editor stays where it is unless its table had to be redrawn (a resize, a merge).
    const caret = st.cellEditing ? [cellInput.selectionStart ?? 0, cellInput.selectionEnd ?? 0] : null;
    const hadFocus = document.activeElement === cellInput;
    const view = {
      engines,
      interactive: true,
      selected: st.selection
        ? {
            tableId: st.selection.tableId,
            col: st.selection.anchor.col,
            row: st.selection.anchor.row,
            ranges: allRanges()
          }
        : null
    };
    st.suppressBlur = true;
    const canvas = /** @type {HTMLElement | null} */ (canvasWrap.querySelector(":scope > .sheet-canvas"));
    canvas?.querySelector(".sheet-handle")?.remove();
    if (canvas) updateSheet(canvas, snapshot, view);
    else canvasWrap.append(renderSheet(snapshot, view));
    for (const td of canvasWrap.querySelectorAll("td.is-editing")) {
      if (!st.cellEditing || td !== cellInput.parentElement) td.classList.remove("is-editing");
    }
    st.suppressBlur = false;

    if (st.selection) {
      const table = snapshot.tables[st.selection.tableId];
      const { col, row } = st.selection.anchor;
      address.textContent = positionToA1(col, row);
      const cell = table ? getCell(table, col, row) : undefined;
      if (!st.inputDirty) input.value = rawCellText(cell);
      const shown = cell && table && typeof cell.formula === "string" ? engines.value(table, col, row) : null;
      message.textContent = isFormulaError(shown) ? explain(shown).text : "";
      message.classList.toggle("is-visible", message.textContent !== "");
    } else {
      message.textContent = "";
      message.classList.remove("is-visible");
      address.textContent = "—";
      input.value = "";
      st.inputDirty = false;
      st.cellEditing = false;
    }
    placeSheetHandle();
    if (st.cellEditing) placeCellEditor(caret, hadFocus);
    options.onSelectionChange?.();
  }

  const unsubscribe = workspace.events.on("change", (event) => {
    const change = /** @type {import("../workspace/changes.js").Change} */ (event);
    // Draws its own page, plus whatever the shared calculation reads from other pages.
    if (change.pages && !change.pages.includes(pageId) && !changeAffectsBook(workspace.data, change)) return;
    refresh(change.pages ? change : null);
    options.onChange?.();
  });

  refresh();

  return {
    element,
    refresh,
    destroy: () => {
      unsubscribe();
      pointer.dispose();
      popovers.destroy();
    },
    getSelection: () =>
      st.selection ? { tableId: st.selection.tableId, col: st.selection.anchor.col, row: st.selection.anchor.row } : null,
    captureSelection: () => (st.selection ? structuredClone(st.selection) : null),
    /**
     * Put a captured selection back (clamped to the table as it is now).
     * @param {unknown} value
     * @returns {boolean} Whether a selection was restored.
     */
    restoreSelection(value) {
      const wanted = readSheetSelection(value);
      if (!wanted || !tableOf(wanted.tableId)) return false;
      st.selection = wanted;
      refresh();
      return st.selection !== null;
    },
    dependsOn: () => new Set([pageId]),
    focus: () => canvasWrap.focus({ preventScroll: true }),
    getRange: currentRange,
    getRanges: allRanges,
    selectCell,
    selectRange,
    addRange,
    fillSelection,
    fillDown: () => fillFromEdge("down"),
    fillRight: () => fillFromEdge("right"),
    copy,
    cut,
    paste,
    canPaste,
    hasSelection: () => st.selection !== null,
    clearSelection: clearSelectionCell,
    insertCells,
    deleteCells,
    moveRange,
    fillRangeTo,
    openContextMenu,
    commit: () => commitInput(),
    setInputValue: (text) => {
      input.value = text;
      st.inputDirty = true;
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