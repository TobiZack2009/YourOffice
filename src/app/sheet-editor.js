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
import { explain, isFormulaError } from "../sheet/errors.js";
import { ensureSheetContent, getCell, positionToA1 } from "../sheet/model.js";
import { columnWidthOf, rectsIntersect, renderSheet, rowHeightOf, updateSheet } from "../sheet/render.js";
import { TableEngines, changeAffectsBook } from "../sheet/table-engine.js";
import { clear, h } from "./dom.js";
import { readSheetSelection } from "./selection.js";
import { icon } from "./icons.js";
import { buildMenu, createPopoverHost } from "./popover.js";
import { createGestureScope } from "./gesture.js";
import { findSectionByLocator } from "../references/sections.js";
import { promptName, referenceCount, sectionMenuItems, showMenu, showReferenceList } from "./handles.js";

/** Smallest size a header drag can shrink a column or row to. */
const MIN_COLUMN_WIDTH = 24;
const MIN_ROW_HEIGHT = 16;

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
  const trimmed = raw.trim();
  if (trimmed.startsWith("=")) return { formula: raw };
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
   * The active range is `anchor`..`focus` (the anchor is the active cell); `others`
   * are earlier ranges added with Ctrl/Cmd+click, all in the same table.
   * @type {{ tableId: string, anchor: Position, focus: Position, others: Rect[] } | null}
   */
  let selection = null;
  /**
   * The mouse gesture in progress, if any.
   * @type {null
   *   | { type: "select" }
   *   | { type: "fill", tableId: string, source: Rect, target: Rect | null, hit: Position | null }
   *   | { type: "move", tableId: string, grab: Position, range: Rect, delta: Position | null }
   *   | { type: "resize", axis: "col" | "row", tableId: string, index: number, origin: number, original: number, size: number }
   *   | { type: "tablemove", tableId: string, originX: number, originY: number, start: Position, x: number, y: number, moved: boolean }}
   */
  let gesture = null;
  /** True once the user typed into the formula bar and has not committed yet. */
  let inputDirty = false;
  /** True while the active cell is being edited in place (the editor input sits inside it). */
  let cellEditing = false;
  /** Set while the in-cell input is moved or removed on purpose, so its blur is not a "click away". */
  let suppressBlur = false;
  /**
   * The cell clipboard: a range that was copied or cut, pasted by `paste()`.
   * @type {{ tableId: string, range: Rect, cut: boolean } | null}
   */
  let clipboard = null;

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
      focus: clampPosition(selection.focus, table),
      others: selection.others.map((rect) => ({
        start: clampPosition(rect.start, table),
        end: clampPosition(rect.end, table)
      }))
    };
  }

  /**
   * @param {Position} a
   * @param {Position} b
   * @returns {Rect}
   */
  function rectOf(a, b) {
    return {
      start: { col: Math.min(a.col, b.col), row: Math.min(a.row, b.row) },
      end: { col: Math.max(a.col, b.col), row: Math.max(a.row, b.row) }
    };
  }

  /**
   * Every selected range, earlier ones first and the active one last.
   * @returns {SheetRange[]}
   */
  function allRanges() {
    if (!selection) return [];
    const { tableId } = selection;
    const ranges = selection.others.map((rect) => ({ tableId, start: { ...rect.start }, end: { ...rect.end } }));
    const active = currentRange();
    if (active) ranges.push(active);
    return ranges;
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
    setSelection({ tableId, anchor: { ...anchor }, focus: { ...focus }, others: [] });
  }

  /**
   * Add a range to the selection, keeping the earlier ones (same table only).
   * @param {string} tableId
   * @param {Position} anchor
   * @param {Position} focus
   */
  function addRange(tableId, anchor, focus) {
    const others = selection && selection.tableId === tableId ? [...selection.others, rectOf(selection.anchor, selection.focus)] : [];
    setSelection({ tableId, anchor: { ...anchor }, focus: { ...focus }, others });
  }

  /** @param {Position} focus */
  function extendFocus(focus) {
    if (!selection) return;
    setSelection({ ...selection, focus: { ...focus } });
  }

  /**
   * Replace the selection. Moving the active cell discards a half-typed formula-bar edit.
   * @param {NonNullable<typeof selection>} next
   */
  function setSelection(next) {
    const moved =
      !selection ||
      selection.tableId !== next.tableId ||
      selection.anchor.col !== next.anchor.col ||
      selection.anchor.row !== next.anchor.row;
    selection = next;
    if (moved) {
      inputDirty = false;
      endCellEdit();
    }
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
    setSelection(
      extend
        ? { ...selection, focus: next }
        : { tableId: selection.tableId, anchor: next, focus: { ...next }, others: [] }
    );
  }

  // -- editing ----------------------------------------------------------------

  /** Keep the keyboard on the grid, so arrows move the selection and typing starts an edit. */
  function focusGrid() {
    canvasWrap.focus({ preventScroll: true });
  }

  /** The `<td>` of the active cell, if it is drawn (a cell covered by a merge is not). */
  function activeCellElement() {
    if (!selection) return null;
    const { tableId, anchor } = selection;
    const host = [...canvasWrap.querySelectorAll(".sheet-table")].find(
      (el) => el.getAttribute("data-table-id") === tableId
    );
    return /** @type {HTMLElement | null} */ (host?.querySelector(`td[data-key="${anchor.col},${anchor.row}"]`) ?? null);
  }

  /** Stop editing in place (the formula bar keeps whatever it holds). */
  function endCellEdit() {
    if (!cellEditing) return;
    cellEditing = false;
    suppressBlur = true;
    cellInput.parentElement?.classList.remove("is-editing");
    cellInput.remove();
    suppressBlur = false;
  }

  /**
   * Put the in-cell editor into the active cell's `<td>` (after every render) and focus it.
   * @param {number[] | null} [caret] Selection to restore.
   * @param {boolean} [focus] False to place it without taking the keyboard (the formula bar has it).
   */
  function placeCellEditor(caret, focus = true) {
    if (!cellEditing) return;
    const td = activeCellElement();
    if (!td) {
      cellEditing = false;
      return;
    }
    suppressBlur = true;
    td.classList.add("is-editing");
    if (cellInput.parentElement !== td) td.append(cellInput);
    if (focus) {
      cellInput.focus({ preventScroll: true });
      const end = cellInput.value.length;
      cellInput.setSelectionRange(caret ? caret[0] : end, caret ? caret[1] : end);
    }
    suppressBlur = false;
  }

  /**
   * Edit the active cell in place. With `text` the cell restarts from it (typing
   * over a cell); without, the cell's current content is edited (double-click, F2).
   * @param {string} [text]
   * @returns {boolean} Whether editing started.
   */
  function startCellEdit(text) {
    if (!selection || !activeCellElement()) return false;
    if (text !== undefined) {
      input.value = text;
      inputDirty = true;
    }
    cellEditing = true;
    cellInput.value = input.value;
    placeCellEditor();
    return cellEditing;
  }

  /** @param {[number, number]} [move] Selection step after the commit. */
  function commitCellEdit(move) {
    endCellEdit();
    commitInput(move);
    focusGrid();
  }

  function cancelCellEdit() {
    endCellEdit();
    inputDirty = false;
    refresh();
    focusGrid();
  }

  cellInput.addEventListener("input", () => {
    input.value = cellInput.value;
    inputDirty = true;
  });

  cellInput.addEventListener("keydown", (event) => {
    const keyboard = /** @type {KeyboardEvent} */ (event);
    if (handleShortcut(keyboard, true, cellInput)) {
      keyboard.preventDefault();
      return;
    }
    if (keyboard.key === "Enter") {
      keyboard.preventDefault();
      commitCellEdit([0, keyboard.shiftKey ? -1 : 1]);
    } else if (keyboard.key === "Tab") {
      keyboard.preventDefault();
      commitCellEdit([keyboard.shiftKey ? -1 : 1, 0]);
    } else if (keyboard.key === "Escape") {
      keyboard.preventDefault();
      cancelCellEdit();
    }
  });

  cellInput.addEventListener("blur", (event) => {
    if (suppressBlur || !cellEditing) return;
    // Moving to the formula bar continues the same edit there.
    if (/** @type {FocusEvent} */ (event).relatedTarget === input) return;
    endCellEdit();
    if (inputDirty) commitInput();
  });

  function commitInput(move) {
    if (!selection) return;
    endCellEdit();
    const payload = parseCellInput(input.value);
    workspace.dispatch("setCell", {
      pageId,
      tableId: selection.tableId,
      col: selection.anchor.col,
      row: selection.anchor.row,
      cell: payload
    });
    inputDirty = false;
    if (move) moveSelection(move[0], move[1]);
    else refresh();
  }

  function clearSelectionCell() {
    const ranges = allRanges();
    if (ranges.length === 0) return;
    workspace.transact("clear cells", () => {
      for (const range of ranges) {
        for (let row = range.start.row; row <= range.end.row; row++) {
          for (let col = range.start.col; col <= range.end.col; col++) {
            if (!getCell(tableOf(range.tableId), col, row)) continue;
            workspace.dispatch("setCell", { pageId, tableId: range.tableId, col, row, cell: null });
          }
        }
      }
    });
  }

  // -- fill, copy and move ------------------------------------------------------

  /**
   * Put the formula-bar content in the active cell and repeat it in every
   * selected range. Formulas keep their meaning relative to each cell they land
   * in (`=A1*2` filled one row down becomes `=A2*2`); `$` pins a reference.
   */
  function fillSelection() {
    if (!selection) return;
    const active = { col: selection.anchor.col, row: selection.anchor.row };
    const { tableId } = selection;
    const targets = allRanges().map(({ start, end }) => ({ start, end }));
    const payload = parseCellInput(input.value);
    inputDirty = false;
    workspace.transact("fill cells", () => {
      workspace.dispatch("setCell", { pageId, tableId, col: active.col, row: active.row, cell: payload });
      workspace.dispatch("fillCells", {
        pageId,
        tableId,
        source: { start: active, end: active },
        targets
      });
    });
  }

  /**
   * Fill each range from its first row (down) or column (right). A one-row (or
   * one-column) range copies from the line just above (or left of) it instead.
   * @param {"down" | "right"} direction
   */
  function fillFromEdge(direction) {
    const ranges = allRanges();
    if (ranges.length === 0) return;
    const down = direction === "down";
    workspace.transact(`fill ${direction}`, () => {
      for (const range of ranges) {
        const thin = down ? range.start.row === range.end.row : range.start.col === range.end.col;
        /** @type {Rect} */
        let source;
        if (thin) {
          const before = down ? range.start.row : range.start.col;
          if (before === 0) continue;
          source = down
            ? { start: { col: range.start.col, row: before - 1 }, end: { col: range.end.col, row: before - 1 } }
            : { start: { col: before - 1, row: range.start.row }, end: { col: before - 1, row: range.end.row } };
        } else {
          source = down
            ? { start: range.start, end: { col: range.end.col, row: range.start.row } }
            : { start: range.start, end: { col: range.start.col, row: range.end.row } };
        }
        workspace.dispatch("fillCells", {
          pageId,
          tableId: range.tableId,
          source,
          targets: [{ start: range.start, end: range.end }]
        });
      }
    });
  }

  function remember(cut) {
    const range = currentRange();
    if (!range) return false;
    clipboard = { tableId: range.tableId, range: { start: range.start, end: range.end }, cut };
    options.onSelectionChange?.();
    return true;
  }

  const copy = () => remember(false);
  const cut = () => remember(true);
  const canPaste = () => clipboard !== null && selection !== null;

  /**
   * Paste the clipboard range. A cut moves its cells (relative references shift
   * by the move); a copy tiles into each selected range when that range is a
   * whole multiple of the copied block, else lands once at the range's start.
   * @returns {boolean} Whether anything was pasted.
   */
  function paste() {
    const active = currentRange();
    if (!clipboard || !selection || !active) return false;
    const { range: source } = clipboard;
    const width = source.end.col - source.start.col + 1;
    const height = source.end.row - source.start.row + 1;
    let pasted = false;
    const done = guard(() => {
      if (clipboard.cut) {
        workspace.dispatch("moveCells", {
          pageId,
          tableId: active.tableId,
          sourceTableId: clipboard.tableId,
          source,
          to: active.start
        });
        clipboard = null;
        selectRange(
          active.tableId,
          active.start,
          { col: active.start.col + width - 1, row: active.start.row + height - 1 }
        );
        pasted = true;
        return;
      }
      const targets = allRanges().map((range) => {
        const spanCols = range.end.col - range.start.col + 1;
        const spanRows = range.end.row - range.start.row + 1;
        if (spanCols % width === 0 && spanRows % height === 0) return { start: range.start, end: range.end };
        return {
          start: range.start,
          end: { col: range.start.col + width - 1, row: range.start.row + height - 1 }
        };
      });
      workspace.dispatch("fillCells", {
        pageId,
        tableId: active.tableId,
        sourceTableId: clipboard.tableId,
        source,
        targets
      });
      if (targets.length === 1) selectRange(active.tableId, targets[0].start, targets[0].end);
      pasted = true;
    });
    return done && pasted;
  }

  /**
   * Spreadsheet shortcuts shared by the canvas and the formula bar.
   * @param {KeyboardEvent} keyboard
   * @param {boolean} fromInput Typing in the formula bar or cell keeps native cut/copy/paste while editing.
   * @param {HTMLInputElement} [field] The text field the event came from.
   * @returns {boolean} Whether the event was handled.
   */
  function handleShortcut(keyboard, fromInput, field = input) {
    if (!(keyboard.ctrlKey || keyboard.metaKey) || keyboard.altKey || !selection) return false;
    const editing = fromInput && (inputDirty || field.selectionStart !== field.selectionEnd);
    switch (keyboard.key.toLowerCase()) {
      case "enter":
        fillSelection();
        return true;
      case "d":
        fillFromEdge("down");
        return true;
      case "r":
        fillFromEdge("right");
        return true;
      case "c":
        return editing ? false : copy();
      case "x":
        return editing ? false : cut();
      case "v":
        return fromInput && (inputDirty || !clipboard) ? false : paste();
      default:
        return false;
    }
  }

  input.addEventListener("input", () => {
    inputDirty = true;
    if (cellEditing) cellInput.value = input.value;
  });

  input.addEventListener("keydown", (event) => {
    const keyboard = /** @type {KeyboardEvent} */ (event);
    if (handleShortcut(keyboard, true)) {
      keyboard.preventDefault();
      return;
    }
    if (keyboard.key === "Enter") {
      keyboard.preventDefault();
      commitInput([0, 1]);
    } else if (keyboard.key === "Tab") {
      keyboard.preventDefault();
      commitInput([1, 0]);
    } else if (keyboard.key === "Escape") {
      keyboard.preventDefault();
      endCellEdit();
      inputDirty = false;
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

  /**
   * Run a command that may be refused (e.g. shifting through a merge) without
   * letting the refusal escape into an event handler.
   * @param {() => void} action
   * @returns {boolean}
   */
  function attempt(action) {
    return guard(action);
  }

  /** @param {"right" | "down"} direction */
  function insertCells(direction) {
    const range = currentRange();
    if (!range) return false;
    return attempt(() =>
      workspace.dispatch("insertCells", {
        pageId,
        tableId: range.tableId,
        range: { start: range.start, end: range.end },
        direction
      })
    );
  }

  /** @param {"left" | "up"} direction */
  function deleteCells(direction) {
    const range = currentRange();
    if (!range) return false;
    return attempt(() =>
      workspace.dispatch("deleteCells", {
        pageId,
        tableId: range.tableId,
        range: { start: range.start, end: range.end },
        direction
      })
    );
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
    const ranges = allRanges();
    if (ranges.length === 0 || !Number.isFinite(height) || height <= 0) return;
    workspace.transact("set row height", () => {
      for (const range of ranges) {
        for (let row = range.start.row; row <= range.end.row; row++) {
          workspace.dispatch("setRowHeight", { pageId, tableId: range.tableId, row, height });
        }
      }
    });
  }

  /** @param {number} width */
  function setSelectedColumnWidth(width) {
    const ranges = allRanges();
    if (ranges.length === 0 || !Number.isFinite(width) || width <= 0) return;
    workspace.transact("set column width", () => {
      for (const range of ranges) {
        for (let column = range.start.col; column <= range.end.col; column++) {
          workspace.dispatch("setColumnWidth", { pageId, tableId: range.tableId, column, width });
        }
      }
    });
  }

  // -- rendering ---------------------------------------------------------------

  /** @param {{ pages: string[], registry?: boolean } | null} [change] The change being applied, if any. */
  function refresh(change = null) {
    const snapshot = content();
    engines.refresh(change);
    clampSelection();
    if (clipboard && !snapshot.tables[clipboard.tableId]) clipboard = null;

    // The canvas is patched in place: tables are keyed by id and cells by position, so the
    // in-cell editor stays where it is unless its table had to be redrawn (a resize, a merge).
    const caret = cellEditing ? [cellInput.selectionStart ?? 0, cellInput.selectionEnd ?? 0] : null;
    const hadFocus = document.activeElement === cellInput;
    const view = {
      engines,
      interactive: true,
      selected: selection
        ? {
            tableId: selection.tableId,
            col: selection.anchor.col,
            row: selection.anchor.row,
            ranges: allRanges()
          }
        : null
    };
    suppressBlur = true;
    const canvas = /** @type {HTMLElement | null} */ (canvasWrap.querySelector(":scope > .sheet-canvas"));
    canvas?.querySelector(".sheet-handle")?.remove();
    if (canvas) updateSheet(canvas, snapshot, view);
    else canvasWrap.append(renderSheet(snapshot, view));
    for (const td of canvasWrap.querySelectorAll("td.is-editing")) {
      if (!cellEditing || td !== cellInput.parentElement) td.classList.remove("is-editing");
    }
    suppressBlur = false;

    if (selection) {
      const table = snapshot.tables[selection.tableId];
      const { col, row } = selection.anchor;
      address.textContent = positionToA1(col, row);
      const cell = table ? getCell(table, col, row) : undefined;
      if (!inputDirty) input.value = rawCellText(cell);
      const shown = cell && table && typeof cell.formula === "string" ? engines.value(table, col, row) : null;
      message.textContent = isFormulaError(shown) ? explain(shown).text : "";
      message.classList.toggle("is-visible", message.textContent !== "");
    } else {
      message.textContent = "";
      message.classList.remove("is-visible");
      address.textContent = "—";
      input.value = "";
      inputDirty = false;
      cellEditing = false;
    }
    placeSheetHandle();
    if (cellEditing) placeCellEditor(caret, hadFocus);
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

  /** @param {Position} position @param {Rect} rect */
  const rectHas = (rect, position) =>
    position.col >= rect.start.col &&
    position.col <= rect.end.col &&
    position.row >= rect.start.row &&
    position.row <= rect.end.row;

  /**
   * Mark the cells of a rect with a preview class (and clear any earlier
   * preview), without re-rendering the canvas mid-gesture.
   * @param {string} tableId
   * @param {Rect | null} rect
   * @param {string} className
   */
  function paintPreview(tableId, rect, className) {
    for (const el of canvasWrap.querySelectorAll(".is-drop-preview, .is-fill-preview")) {
      el.classList.remove("is-drop-preview", "is-fill-preview");
    }
    if (!rect) return;
    const host = [...canvasWrap.querySelectorAll(".sheet-table")].find(
      (el) => el.getAttribute("data-table-id") === tableId
    );
    if (!host) return;
    for (let row = rect.start.row; row <= rect.end.row; row++) {
      for (let col = rect.start.col; col <= rect.end.col; col++) {
        host.querySelector(`[data-key="${col},${row}"]`)?.classList.add(className);
      }
    }
  }

  /**
   * Move a range by the offset between two cells (relative references in the
   * moved formulas shift by the same offset).
   * @param {Position} from
   * @param {Position} to
   */
  function moveRange(from, to) {
    const range = currentRange();
    if (!range) return false;
    const deltaCol = Math.max(to.col - from.col, -range.start.col);
    const deltaRow = Math.max(to.row - from.row, -range.start.row);
    if (deltaCol === 0 && deltaRow === 0) return false;
    const dest = { col: range.start.col + deltaCol, row: range.start.row + deltaRow };
    const moved = attempt(() =>
      workspace.dispatch("moveCells", {
        pageId,
        tableId: range.tableId,
        source: { start: range.start, end: range.end },
        to: dest
      })
    );
    if (moved) {
      selectRange(range.tableId, dest, {
        col: dest.col + range.end.col - range.start.col,
        row: dest.row + range.end.row - range.start.row
      });
    }
    return moved;
  }

  /**
   * The new area a fill drag covers: the strip of cells beyond the source, in
   * whichever direction the pointer got furthest from it.
   * @param {Rect} source
   * @param {Position} hit
   * @returns {Rect | null}
   */
  function fillExtension(source, hit) {
    const right = hit.col - source.end.col;
    const left = source.start.col - hit.col;
    const down = hit.row - source.end.row;
    const up = source.start.row - hit.row;
    const horizontal = Math.max(right, left, 0);
    const vertical = Math.max(down, up, 0);
    if (horizontal === 0 && vertical === 0) return null;
    if (vertical >= horizontal) {
      return down >= up
        ? { start: { col: source.start.col, row: source.end.row + 1 }, end: { col: source.end.col, row: hit.row } }
        : { start: { col: source.start.col, row: hit.row }, end: { col: source.end.col, row: source.start.row - 1 } };
    }
    return right >= left
      ? { start: { col: source.end.col + 1, row: source.start.row }, end: { col: hit.col, row: source.end.row } }
      : { start: { col: hit.col, row: source.start.row }, end: { col: source.start.col - 1, row: source.end.row } };
  }

  /**
   * Fill from the active range out to `extent`, tiling it (relative references
   * shift per target), then select the whole filled area.
   * @param {Position} extent
   */
  function fillRangeTo(extent) {
    const range = currentRange();
    if (!range) return false;
    const source = { start: range.start, end: range.end };
    const target = fillExtension(source, extent);
    if (!target) return false;
    const done = attempt(() =>
      workspace.dispatch("fillCells", { pageId, tableId: range.tableId, source, targets: [target] })
    );
    if (done) {
      const union = rectOf(
        { col: Math.min(source.start.col, target.start.col), row: Math.min(source.start.row, target.start.row) },
        { col: Math.max(source.end.col, target.end.col), row: Math.max(source.end.row, target.end.row) }
      );
      selectRange(range.tableId, union.start, union.end);
    }
    return done;
  }

  canvasWrap.addEventListener("mousedown", (event) => {
    const mouse = /** @type {MouseEvent} */ (event);
    if (mouse.button === 2) return; // right-click: the context menu decides the selection
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === cellInput) return; // place the caret inside the cell being edited
    // Pressing anywhere else in the grid finishes an in-place edit first.
    if (cellEditing) {
      endCellEdit();
      if (inputDirty) commitInput();
    }

    // Dragging a header's trailing edge resizes that column or row.
    const grip = target.closest?.("[data-role=col-resize], [data-role=row-resize]");
    if (grip) {
      const axis = grip.getAttribute("data-role") === "col-resize" ? "col" : "row";
      const tableId = grip.closest(".sheet-table")?.getAttribute("data-table-id");
      const index = Number(grip.getAttribute(axis === "col" ? "data-col" : "data-row"));
      const table = tableId ? tableOf(tableId) : undefined;
      if (tableId && table && Number.isInteger(index)) {
        event.preventDefault();
        const original = axis === "col" ? columnWidthOf(table, index) : rowHeightOf(table, index);
        gesture = {
          type: "resize",
          axis,
          tableId,
          index,
          origin: axis === "col" ? mouse.clientX : mouse.clientY,
          original,
          size: original
        };
        grip.classList.add("is-dragging");
        return;
      }
    }

    // Dragging the little square at the selection's corner fills.
    if (target.closest?.("[data-role=fill-handle]") && selection) {
      const range = currentRange();
      if (range) {
        event.preventDefault();
        gesture = { type: "fill", tableId: range.tableId, source: { start: range.start, end: range.end }, target: null, hit: null };
        focusGrid();
        return;
      }
    }

    const hit = cellFromTarget(event.target);
    if (hit) {
      event.preventDefault();
      // A double-click on the active cell edits it in place.
      if (
        mouse.detail >= 2 &&
        selection &&
        hit.tableId === selection.tableId &&
        hit.col === selection.anchor.col &&
        hit.row === selection.anchor.row &&
        startCellEdit()
      ) {
        gesture = null;
        return;
      }
      if (mouse.shiftKey && selection && selection.tableId === hit.tableId) {
        extendFocus({ col: hit.col, row: hit.row });
        gesture = { type: "select" };
      } else if (mouse.ctrlKey || mouse.metaKey) {
        addRange(hit.tableId, { col: hit.col, row: hit.row }, { col: hit.col, row: hit.row });
        gesture = { type: "select" };
      } else {
        // Grabbing a cell that is already selected drags the selection (a plain
        // click on it still just selects that cell, on release).
        const grabbed = allRanges().filter((range) => range.tableId === hit.tableId && rectHas(range, hit));
        if (grabbed.length > 0) {
          const range = grabbed[grabbed.length - 1];
          gesture = {
            type: "move",
            tableId: hit.tableId,
            grab: { col: hit.col, row: hit.row },
            range: { start: range.start, end: range.end },
            delta: null
          };
        } else {
          selectCell(hit.tableId, hit.col, hit.row);
          gesture = { type: "select" };
        }
      }
      focusGrid();
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

  canvasWrap.addEventListener("mouseover", (event) => {
    if (!gesture) return;
    const hit = cellFromTarget(event.target);
    if (!hit) return;
    if (gesture.type === "select") {
      if (!selection || hit.tableId !== selection.tableId) return;
      if (hit.col === selection.focus.col && hit.row === selection.focus.row) return;
      extendFocus({ col: hit.col, row: hit.row });
    } else if (gesture.type === "fill") {
      if (hit.tableId !== gesture.tableId) return;
      const extension = fillExtension(gesture.source, hit);
      gesture.target = extension;
      gesture.hit = { col: hit.col, row: hit.row };
      paintPreview(
        gesture.tableId,
        extension
          ? {
              start: {
                col: Math.min(gesture.source.start.col, extension.start.col),
                row: Math.min(gesture.source.start.row, extension.start.row)
              },
              end: {
                col: Math.max(gesture.source.end.col, extension.end.col),
                row: Math.max(gesture.source.end.row, extension.end.row)
              }
            }
          : null,
        "is-fill-preview"
      );
    } else if (gesture.type === "move") {
      if (hit.tableId !== gesture.tableId) return;
      const { range, grab } = gesture;
      const deltaCol = Math.max(hit.col - grab.col, -range.start.col);
      const deltaRow = Math.max(hit.row - grab.row, -range.start.row);
      gesture.delta = deltaCol === 0 && deltaRow === 0 ? null : { col: deltaCol, row: deltaRow };
      paintPreview(
        gesture.tableId,
        gesture.delta
          ? {
              start: { col: range.start.col + deltaCol, row: range.start.row + deltaRow },
              end: { col: range.end.col + deltaCol, row: range.end.row + deltaRow }
            }
          : null,
        "is-drop-preview"
      );
    }
  });

  /** Follow the pointer while a header edge is dragged, resizing the live DOM without re-rendering. */
  /** Document-level listeners of this editor's drags; aborted on destroy. */
  const gestures = createGestureScope(document);

  const dragResize = (/** @type {Event} */ event) => {
    if (gesture?.type === "tablemove") {
      const mouse = /** @type {MouseEvent} */ (event);
      const dx = mouse.clientX - gesture.originX;
      const dy = mouse.clientY - gesture.originY;
      if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      gesture.moved = true;
      gesture.x = Math.max(0, Math.round(gesture.start.col + dx));
      gesture.y = Math.max(0, Math.round(gesture.start.row + dy));
      const host = [...canvasWrap.querySelectorAll(".sheet-table")].find((el) => el.getAttribute("data-table-id") === gesture?.tableId);
      if (host) {
        /** @type {HTMLElement} */ (host).style.left = `${gesture.x}px`;
        /** @type {HTMLElement} */ (host).style.top = `${gesture.y}px`;
      }
      return;
    }
    if (gesture?.type !== "resize") return;
    const mouse = /** @type {MouseEvent} */ (event);
    const pointer = gesture.axis === "col" ? mouse.clientX : mouse.clientY;
    const minimum = gesture.axis === "col" ? MIN_COLUMN_WIDTH : MIN_ROW_HEIGHT;
    gesture.size = Math.max(minimum, Math.round(gesture.original + pointer - gesture.origin));
    const host = [...canvasWrap.querySelectorAll(".sheet-table")].find(
      (el) => el.getAttribute("data-table-id") === gesture?.tableId
    );
    const line = host?.querySelector(
      gesture.axis === "col" ? `col[data-col="${gesture.index}"]` : `tr[data-row="${gesture.index}"]`
    );
    if (line) /** @type {HTMLElement} */ (line).style[gesture.axis === "col" ? "width" : "height"] = `${gesture.size}px`;
  };
  gestures.listen("mousemove", dragResize);

  /** Finish the gesture on mouse release: commit a fill, move or resize, or treat a bare grab as a click. */
  const finishGesture = () => {
    const done = gesture;
    gesture = null;
    if (!done || done.type === "select") return;
    if (done.type === "tablemove") {
      if (done.moved) {
        justDragged = true;
        attempt(() => workspace.dispatch("moveTable", { pageId, tableId: done.tableId, x: done.x, y: done.y }));
        refresh();
      }
      return;
    }
    if (done.type === "resize") {
      if (done.size !== done.original) {
        attempt(() =>
          workspace.dispatch(
            done.axis === "col" ? "setColumnWidth" : "setRowHeight",
            done.axis === "col"
              ? { pageId, tableId: done.tableId, column: done.index, width: done.size }
              : { pageId, tableId: done.tableId, row: done.index, height: done.size }
          )
        );
      } else {
        canvasWrap.querySelector(".sheet-resize-handle.is-dragging")?.classList.remove("is-dragging");
      }
      return;
    }
    paintPreview(done.tableId, null, "");
    if (done.type === "fill") {
      if (done.target && done.hit) fillRangeTo(done.hit);
    } else if (done.delta) {
      moveRange(done.grab, { col: done.grab.col + done.delta.col, row: done.grab.row + done.delta.row });
    } else {
      selectCell(done.tableId, done.grab.col, done.grab.row);
    }
  };
  gestures.listen("mouseup", finishGesture);

  // -- section handle ------------------------------------------------------------

  /** Set after a table drag so the click that follows the release does not open the menu. */
  let justDragged = false;

  /** @returns {{ mode: "table" | "range", tableId: string, range: Rect | null } | null} */
  function handleTarget() {
    const range = currentRange();
    if (!range) {
      // Nothing selected: the handle stands for the first table.
      const first = workspace.data.pages[pageId]?.content?.tableOrder?.[0];
      return first ? { mode: "table", tableId: first, range: null } : null;
    }
    const table = tableOf(range.tableId);
    if (!table) return null;
    const single = range.start.col === range.end.col && range.start.row === range.end.row;
    const whole =
      range.start.col === 0 && range.start.row === 0 && range.end.col >= table.columnCount - 1 && range.end.row >= table.rowCount - 1;
    return single || whole
      ? { mode: "table", tableId: range.tableId, range: null }
      : { mode: "range", tableId: range.tableId, range: { start: range.start, end: range.end } };
  }

  /** @param {{ mode: "table" | "range", tableId: string, range: Rect | null }} target */
  function handleMenu(target) {
    const data = workspace.data;
    const page = data.pages[pageId];
    const table = tableOf(target.tableId);
    const locator = target.range ? { tableId: target.tableId, range: target.range } : { tableId: target.tableId };
    const found = findSectionByLocator(page, locator);
    const anchor = () => /** @type {HTMLElement} */ (canvasWrap.querySelector("[data-role=sheet-handle]") ?? canvasWrap);
    /** @type {import("./popover.js").MenuItem[]} */
    const items = [];
    if (target.mode === "table") {
      items.push({
        label: "Rename table",
        icon: "rename",
        attrs: { "data-action": "table-rename" },
        action: () =>
          promptName(popovers, anchor(), {
            title: "Table name",
            initial: table?.name ?? "",
            onSubmit: (name) => guard(() => workspace.dispatch("renameTable", { pageId, tableId: target.tableId, name }))
          })
      });
    } else if (found?.name) {
      items.push(...sectionMenuItems({ workspace, popovers, anchor, sectionId: found.id, navigate: options.navigate, guard }));
      return items;
    } else {
      items.push({
        label: "Make section",
        icon: "section",
        attrs: { "data-action": "section-make" },
        action: () =>
          promptName(popovers, anchor(), {
            title: "Section name",
            confirm: "Create",
            onSubmit: (name) => guard(() => workspace.dispatch("createSection", { pageId, locator, name }))
          })
      });
    }
    const count = found ? referenceCount(workspace, found.id) : 0;
    items.push({
      label: `Show references (${count})`,
      icon: "link",
      disabled: !found,
      attrs: { "data-action": "section-references" },
      action: () => found && showReferenceList({ workspace, popovers, anchor: anchor(), sectionId: found.id, navigate: options.navigate })
    });
    return items;
  }

  /** Put the handle by the selected table's top-left corner (rebuilt on every render). */
  function placeSheetHandle() {
    const target = handleTarget();
    if (!target) return;
    const table = tableOf(target.tableId);
    if (!table) return;
    const locator = target.range ? { tableId: target.tableId, range: target.range } : { tableId: target.tableId };
    const found = findSectionByLocator(workspace.data.pages[pageId], locator);
    const count = found ? referenceCount(workspace, found.id) : 0;
    const handle = h("button", {
      class: `section-handle sheet-handle is-${target.mode}`,
      type: "button",
      "data-role": "sheet-handle",
      "data-mode": target.mode,
      "aria-label": target.mode === "table" ? "Table options" : "Range options",
      title: target.mode === "table" ? "Table options (drag to move)" : "Range options",
      style: `left:${Math.max(0, table.position.x - 24)}px;top:${table.position.y}px`
    });
    handle.append(icon(target.mode === "table" ? "grip" : "section", { size: 14 }));
    if (count > 0) handle.append(h("span", { class: "handle-badge", text: String(count) }));
    handle.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      const mouse = /** @type {MouseEvent} */ (event);
      if (mouse.button !== 0) return;
      if (target.mode === "table") {
        event.preventDefault();
        gesture = {
          type: "tablemove",
          tableId: target.tableId,
          originX: mouse.clientX,
          originY: mouse.clientY,
          start: { col: table.position.x, row: table.position.y },
          x: table.position.x,
          y: table.position.y,
          moved: false
        };
      }
    });
    handle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (justDragged) {
        justDragged = false;
        return;
      }
      showMenu(popovers, handle, handleMenu(target));
    });
    (canvasWrap.querySelector(".sheet-canvas") ?? canvasWrap).append(handle);
  }

  // -- context menu ------------------------------------------------------------

  /** @param {{ x: number, y: number }} point */
  function openContextMenu(point) {
    if (!selection) return;
    const range = currentRange();
    const cellCount = range ? (range.end.col - range.start.col + 1) * (range.end.row - range.start.row + 1) : 0;
    const label = cellCount > 1 ? "cells" : "cell";
    /** @type {import("./popover.js").MenuItem[]} */
    const items = [
      { label: "Cut", icon: "cut", attrs: { "data-action": "sheet-cut" }, action: () => cut() },
      { label: "Copy", icon: "copy", attrs: { "data-action": "sheet-copy" }, action: () => copy() },
      { label: "Paste", icon: "paste", attrs: { "data-action": "sheet-paste" }, disabled: !canPaste(), action: () => paste() },
      { label: `Clear ${label}`, icon: "clear", attrs: { "data-action": "sheet-clear" }, action: () => clearSelectionCell() },
      { separator: true },
      {
        label: "Insert",
        icon: "shift-right",
        attrs: { "data-action": "insert-menu" },
        submenu: [
          { label: "Cells, shift right", icon: "shift-right", attrs: { "data-action": "insert-cells-right" }, action: () => insertCells("right") },
          { label: "Cells, shift down", icon: "shift-down", attrs: { "data-action": "insert-cells-down" }, action: () => insertCells("down") },
          { separator: true },
          { label: "Row", icon: "row-add", attrs: { "data-action": "add-row" }, action: () => changeLines("row", "insert") },
          { label: "Column", icon: "column-add", attrs: { "data-action": "add-column" }, action: () => changeLines("column", "insert") }
        ]
      },
      {
        label: "Delete",
        icon: "shift-left",
        attrs: { "data-action": "delete-menu" },
        submenu: [
          { label: "Cells, shift left", icon: "shift-left", attrs: { "data-action": "delete-cells-left" }, action: () => deleteCells("left") },
          { label: "Cells, shift up", icon: "shift-up", attrs: { "data-action": "delete-cells-up" }, action: () => deleteCells("up") },
          { separator: true },
          { label: "Row", icon: "row-delete", attrs: { "data-action": "delete-row" }, action: () => changeLines("row", "delete") },
          { label: "Column", icon: "column-delete", attrs: { "data-action": "delete-column" }, action: () => changeLines("column", "delete") }
        ]
      },
      { separator: true },
      { label: "Merge cells", icon: "merge", attrs: { "data-action": "merge" }, disabled: !canMerge(), action: () => mergeSelection() },
      { label: "Unmerge cells", icon: "unmerge", attrs: { "data-action": "unmerge" }, disabled: !canUnmerge(), action: () => unmergeSelection() }
    ];
    popovers.showAt(point, buildMenu(items, popovers.close, (name) => icon(name, { size: 16 })), {
      class: "context-menu"
    });
  }

  canvasWrap.addEventListener("dblclick", (event) => {
    const hit = cellFromTarget(event.target);
    if (!hit || cellEditing) return;
    selectCell(hit.tableId, hit.col, hit.row);
    startCellEdit();
  });

  canvasWrap.addEventListener("contextmenu", (event) => {
    if (event.target === cellInput) return; // the browser's text menu, for the cell being edited
    const hit = cellFromTarget(event.target);
    if (!hit) return;
    event.preventDefault();
    gesture = null;
    const inside = allRanges().some((range) => range.tableId === hit.tableId && rectHas(range, hit));
    if (!inside) selectCell(hit.tableId, hit.col, hit.row);
    const mouse = /** @type {MouseEvent} */ (event);
    openContextMenu({ x: mouse.clientX, y: mouse.clientY });
  });

  element.addEventListener("keydown", (event) => {
    if (event.target === input || event.target === cellInput) return;
    const keyboard = /** @type {KeyboardEvent} */ (event);
    if (!selection) return;
    if (handleShortcut(keyboard, false)) {
      keyboard.preventDefault();
      return;
    }
    const arrows = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0]
    };
    if (arrows[keyboard.key]) {
      keyboard.preventDefault();
      moveSelection(arrows[keyboard.key][0], arrows[keyboard.key][1], keyboard.shiftKey);
      focusGrid();
      return;
    }
    if (keyboard.key === "Tab") {
      keyboard.preventDefault();
      moveSelection(1, 0);
      focusGrid();
      return;
    }
    if (keyboard.key === "Enter") {
      keyboard.preventDefault();
      moveSelection(0, 1);
      focusGrid();
      return;
    }
    if (keyboard.key === "Backspace" || keyboard.key === "Delete") {
      keyboard.preventDefault();
      clearSelectionCell();
      return;
    }
    if (keyboard.key === "F2") {
      keyboard.preventDefault();
      startCellEdit();
      return;
    }
    if (keyboard.key.length === 1 && !keyboard.metaKey && !keyboard.ctrlKey && !keyboard.altKey) {
      keyboard.preventDefault();
      // Typing over a cell replaces it, in the cell itself (or the formula bar if the cell is hidden by a merge).
      if (!startCellEdit(keyboard.key)) {
        input.value = keyboard.key;
        inputDirty = true;
        input.focus();
      }
    }
  });

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
      gestures.abort();
      popovers.destroy();
    },
    getSelection: () =>
      selection ? { tableId: selection.tableId, col: selection.anchor.col, row: selection.anchor.row } : null,
    captureSelection: () => (selection ? structuredClone(selection) : null),
    /**
     * Put a captured selection back (clamped to the table as it is now).
     * @param {unknown} value
     * @returns {boolean} Whether a selection was restored.
     */
    restoreSelection(value) {
      const wanted = readSheetSelection(value);
      if (!wanted || !tableOf(wanted.tableId)) return false;
      selection = wanted;
      refresh();
      return selection !== null;
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
    hasSelection: () => selection !== null,
    clearSelection: clearSelectionCell,
    insertCells,
    deleteCells,
    moveRange,
    fillRangeTo,
    openContextMenu,
    commit: () => commitInput(),
    setInputValue: (text) => {
      input.value = text;
      inputDirty = true;
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
