/**
 * Sheet fill, copy, cut and paste, and the shortcuts that drive them.
 */

import { parseCellInput } from "./sheet-cell-input.js";
/** @typedef {import("./sheet-editor.js").Rect} Rect */

/** @param {any} ed The sheet editor kernel. */
export function createSheetClipboard(ed) {
  const { guard, input, options, pageId, st, workspace, allRanges, currentRange, selectRange } = ed;

  /**
   * Put the formula-bar content in the active cell and repeat it in every
   * selected range. Formulas keep their meaning relative to each cell they land
   * in (`=A1*2` filled one row down becomes `=A2*2`); `$` pins a reference.
   */
  function fillSelection() {
    if (!st.selection) return;
    const active = { col: st.selection.anchor.col, row: st.selection.anchor.row };
    const { tableId } = st.selection;
    const targets = allRanges().map(({ start, end }) => ({ start, end }));
    const payload = parseCellInput(input.value);
    st.inputDirty = false;
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
    st.clipboard = { tableId: range.tableId, range: { start: range.start, end: range.end }, cut };
    options.onSelectionChange?.();
    return true;
  }

  const copy = () => remember(false);
  const cut = () => remember(true);
  const canPaste = () => st.clipboard !== null && st.selection !== null;

  /**
   * Paste the clipboard range. A cut moves its cells (relative references shift
   * by the move); a copy tiles into each selected range when that range is a
   * whole multiple of the copied block, else lands once at the range's start.
   * @returns {boolean} Whether anything was pasted.
   */
  function paste() {
    const active = currentRange();
    if (!st.clipboard || !st.selection || !active) return false;
    const { range: source } = st.clipboard;
    const width = source.end.col - source.start.col + 1;
    const height = source.end.row - source.start.row + 1;
    let pasted = false;
    const done = guard(() => {
      if (st.clipboard.cut) {
        workspace.dispatch("moveCells", {
          pageId,
          tableId: active.tableId,
          sourceTableId: st.clipboard.tableId,
          source,
          to: active.start
        });
        st.clipboard = null;
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
        sourceTableId: st.clipboard.tableId,
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
    if (!(keyboard.ctrlKey || keyboard.metaKey) || keyboard.altKey || !st.selection) return false;
    const editing = fromInput && (st.inputDirty || field.selectionStart !== field.selectionEnd);
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
        return fromInput && (st.inputDirty || !st.clipboard) ? false : paste();
      default:
        return false;
    }
  }

  return {
    fillSelection,
    fillFromEdge,
    copy,
    cut,
    canPaste,
    paste,
    handleShortcut
  };
}
