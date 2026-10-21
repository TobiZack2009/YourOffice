/**
 * Sheet structure commands: rows, columns, cells, merges, sizes, moving and filling ranges.
 */

import { getCell } from "../calc/model.js";
import { columnWidthOf, rectsIntersect, rowHeightOf } from "../sheet/render.js";
/** @typedef {import("./sheet-editor.js").Position} Position */
/** @typedef {import("./sheet-editor.js").Rect} Rect */

/** @param {any} ed The sheet editor kernel. */
export function createSheetStructure(ed) {
  const { guard, pageId, st, tableOf, workspace, allRanges, currentRange, rectOf, selectRange } = ed;

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
    return st.selection ? (tableOf(st.selection.tableId)?.name ?? null) : null;
  }

  /** @param {string} name */
  function renameSelectedTable(name) {
    if (!st.selection) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    workspace.dispatch("renameTable", { pageId, tableId: st.selection.tableId, name: trimmed });
  }

  function selectedRowHeight() {
    const table = st.selection ? tableOf(st.selection.tableId) : undefined;
    return st.selection && table ? rowHeightOf(table, st.selection.anchor.row) : null;
  }

  function selectedColumnWidth() {
    const table = st.selection ? tableOf(st.selection.tableId) : undefined;
    return st.selection && table ? columnWidthOf(table, st.selection.anchor.col) : null;
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

  return {
    clearSelectionCell,
    changeLines,
    addTable,
    attempt,
    insertCells,
    deleteCells,
    canMerge,
    canUnmerge,
    mergeSelection,
    unmergeSelection,
    selectedTableName,
    renameSelectedTable,
    selectedRowHeight,
    selectedColumnWidth,
    setSelectedRowHeight,
    setSelectedColumnWidth,
    moveRange,
    fillExtension,
    fillRangeTo
  };
}
