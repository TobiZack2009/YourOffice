/**
 * Sheet selection: the active range, extra ranges and moving them.
 */

/** @typedef {import("./sheet-editor.js").Position} Position */
/** @typedef {import("./sheet-editor.js").SheetRange} SheetRange */
/** @typedef {import("./sheet-editor.js").Rect} Rect */

/** @param {any} ed The sheet editor kernel. */
export function createSheetSelection(ed) {
  const { content, refresh, st, tableOf } = ed;

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
    if (!st.selection) return;
    const table = tableOf(st.selection.tableId);
    if (!table) {
      st.selection = null;
      return;
    }
    st.selection = {
      tableId: st.selection.tableId,
      anchor: clampPosition(st.selection.anchor, table),
      focus: clampPosition(st.selection.focus, table),
      others: st.selection.others.map((rect) => ({
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
    if (!st.selection) return [];
    const { tableId } = st.selection;
    const ranges = st.selection.others.map((rect) => ({ tableId, start: { ...rect.start }, end: { ...rect.end } }));
    const active = currentRange();
    if (active) ranges.push(active);
    return ranges;
  }

  /** @returns {SheetRange | null} */
  function currentRange() {
    if (!st.selection) return null;
    const { anchor, focus } = st.selection;
    return {
      tableId: st.selection.tableId,
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
    const others = st.selection && st.selection.tableId === tableId ? [...st.selection.others, rectOf(st.selection.anchor, st.selection.focus)] : [];
    setSelection({ tableId, anchor: { ...anchor }, focus: { ...focus }, others });
  }

  /** @param {Position} focus */
  function extendFocus(focus) {
    if (!st.selection) return;
    setSelection({ ...st.selection, focus: { ...focus } });
  }

  /**
   * Replace the selection. Moving the active cell discards a half-typed formula-bar edit.
   * @param {{ tableId: string, anchor: Position, focus: Position, others: Rect[] }} next
   */
  function setSelection(next) {
    const moved =
      !st.selection ||
      st.selection.tableId !== next.tableId ||
      st.selection.anchor.col !== next.anchor.col ||
      st.selection.anchor.row !== next.anchor.row;
    st.selection = next;
    if (moved) {
      st.inputDirty = false;
      ed.endCellEdit();
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
    if (!st.selection) {
      const first = content().tableOrder[0];
      if (first) selectCell(first, 0, 0);
      return;
    }
    const table = tableOf(st.selection.tableId);
    if (!table) return;
    const from = extend ? st.selection.focus : st.selection.anchor;
    const next = clampPosition({ col: from.col + deltaCol, row: from.row + deltaRow }, table);
    setSelection(
      extend
        ? { ...st.selection, focus: next }
        : { tableId: st.selection.tableId, anchor: next, focus: { ...next }, others: [] }
    );
  }

  return {
    clampSelection,
    rectOf,
    allRanges,
    currentRange,
    selectRange,
    addRange,
    extendFocus,
    setSelection,
    selectCell,
    moveSelection
  };
}
