/**
 * Sheet pointer gestures: select, fill, move, resize and table drags.
 */

import { columnWidthOf, rowHeightOf } from "../sheet/render.js";
import { createGestureScope } from "./gesture.js";

/** Smallest size a header drag can shrink to. */
const MIN_COLUMN_WIDTH = 24;

/** Smallest size a header drag can shrink to. */
const MIN_ROW_HEIGHT = 16;
/** @typedef {import("./sheet-editor.js").Position} Position */
/** @typedef {import("./sheet-editor.js").Rect} Rect */

/** @param {any} ed The sheet editor kernel. */
export function createSheetGestures(ed) {
  const { canvasWrap, cellInput, pageId, refresh, st, tableOf, workspace, addRange, allRanges, attempt, commitInput, currentRange, endCellEdit, extendFocus, fillExtension, fillRangeTo, focusGrid, moveRange, selectCell, startCellEdit } = ed;

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

  canvasWrap.addEventListener("mousedown", (event) => {
    const mouse = /** @type {MouseEvent} */ (event);
    if (mouse.button === 2) return; // right-click: the context menu decides the selection
    const target = /** @type {HTMLElement} */ (event.target);
    if (target === cellInput) return; // place the caret inside the cell being edited
    // Pressing anywhere else in the grid finishes an in-place edit first.
    if (st.cellEditing) {
      endCellEdit();
      if (st.inputDirty) commitInput();
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
        st.gesture = {
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
    if (target.closest?.("[data-role=fill-handle]") && st.selection) {
      const range = currentRange();
      if (range) {
        event.preventDefault();
        st.gesture = { type: "fill", tableId: range.tableId, source: { start: range.start, end: range.end }, target: null, hit: null };
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
        st.selection &&
        hit.tableId === st.selection.tableId &&
        hit.col === st.selection.anchor.col &&
        hit.row === st.selection.anchor.row &&
        startCellEdit()
      ) {
        st.gesture = null;
        return;
      }
      if (mouse.shiftKey && st.selection && st.selection.tableId === hit.tableId) {
        extendFocus({ col: hit.col, row: hit.row });
        st.gesture = { type: "select" };
      } else if (mouse.ctrlKey || mouse.metaKey) {
        addRange(hit.tableId, { col: hit.col, row: hit.row }, { col: hit.col, row: hit.row });
        st.gesture = { type: "select" };
      } else {
        // Grabbing a cell that is already selected drags the selection (a plain
        // click on it still just selects that cell, on release).
        const grabbed = allRanges().filter((range) => range.tableId === hit.tableId && rectHas(range, hit));
        if (grabbed.length > 0) {
          const range = grabbed[grabbed.length - 1];
          st.gesture = {
            type: "move",
            tableId: hit.tableId,
            grab: { col: hit.col, row: hit.row },
            range: { start: range.start, end: range.end },
            delta: null
          };
        } else {
          selectCell(hit.tableId, hit.col, hit.row);
          st.gesture = { type: "select" };
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
    if (!st.gesture) return;
    const hit = cellFromTarget(event.target);
    if (!hit) return;
    if (st.gesture.type === "select") {
      if (!st.selection || hit.tableId !== st.selection.tableId) return;
      if (hit.col === st.selection.focus.col && hit.row === st.selection.focus.row) return;
      extendFocus({ col: hit.col, row: hit.row });
    } else if (st.gesture.type === "fill") {
      if (hit.tableId !== st.gesture.tableId) return;
      const extension = fillExtension(st.gesture.source, hit);
      st.gesture.target = extension;
      st.gesture.hit = { col: hit.col, row: hit.row };
      paintPreview(
        st.gesture.tableId,
        extension
          ? {
              start: {
                col: Math.min(st.gesture.source.start.col, extension.start.col),
                row: Math.min(st.gesture.source.start.row, extension.start.row)
              },
              end: {
                col: Math.max(st.gesture.source.end.col, extension.end.col),
                row: Math.max(st.gesture.source.end.row, extension.end.row)
              }
            }
          : null,
        "is-fill-preview"
      );
    } else if (st.gesture.type === "move") {
      if (hit.tableId !== st.gesture.tableId) return;
      const { range, grab } = st.gesture;
      const deltaCol = Math.max(hit.col - grab.col, -range.start.col);
      const deltaRow = Math.max(hit.row - grab.row, -range.start.row);
      st.gesture.delta = deltaCol === 0 && deltaRow === 0 ? null : { col: deltaCol, row: deltaRow };
      paintPreview(
        st.gesture.tableId,
        st.gesture.delta
          ? {
              start: { col: range.start.col + deltaCol, row: range.start.row + deltaRow },
              end: { col: range.end.col + deltaCol, row: range.end.row + deltaRow }
            }
          : null,
        "is-drop-preview"
      );
    }
  });

  const gestures = createGestureScope(document);

  const dragResize = (/** @type {Event} */ event) => {
    if (st.gesture?.type === "tablemove") {
      const mouse = /** @type {MouseEvent} */ (event);
      const dx = mouse.clientX - st.gesture.originX;
      const dy = mouse.clientY - st.gesture.originY;
      if (!st.gesture.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      st.gesture.moved = true;
      st.gesture.x = Math.max(0, Math.round(st.gesture.start.col + dx));
      st.gesture.y = Math.max(0, Math.round(st.gesture.start.row + dy));
      const host = [...canvasWrap.querySelectorAll(".sheet-table")].find((el) => el.getAttribute("data-table-id") === st.gesture?.tableId);
      if (host) {
        /** @type {HTMLElement} */ (host).style.left = `${st.gesture.x}px`;
        /** @type {HTMLElement} */ (host).style.top = `${st.gesture.y}px`;
      }
      return;
    }
    if (st.gesture?.type !== "resize") return;
    const mouse = /** @type {MouseEvent} */ (event);
    const pointer = st.gesture.axis === "col" ? mouse.clientX : mouse.clientY;
    const minimum = st.gesture.axis === "col" ? MIN_COLUMN_WIDTH : MIN_ROW_HEIGHT;
    st.gesture.size = Math.max(minimum, Math.round(st.gesture.original + pointer - st.gesture.origin));
    const host = [...canvasWrap.querySelectorAll(".sheet-table")].find(
      (el) => el.getAttribute("data-table-id") === st.gesture?.tableId
    );
    const line = host?.querySelector(
      st.gesture.axis === "col" ? `col[data-col="${st.gesture.index}"]` : `tr[data-row="${st.gesture.index}"]`
    );
    if (line) /** @type {HTMLElement} */ (line).style[st.gesture.axis === "col" ? "width" : "height"] = `${st.gesture.size}px`;
  };
  gestures.listen("mousemove", dragResize);

  /** Finish the gesture on mouse release: commit a fill, move or resize, or treat a bare grab as a click. */
  const finishGesture = () => {
    const done = st.gesture;
    st.gesture = null;
    if (!done || done.type === "select") return;
    if (done.type === "tablemove") {
      if (done.moved) {
        st.justDragged = true;
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

  return {
    cellFromTarget,
    rectHas,
    dispose: () => gestures.abort()
  };
}
