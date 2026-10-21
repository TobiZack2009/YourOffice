/**
 * Sheet menus: the section handle by the table corner and the cell context menu.
 */

import { findSectionByLocator } from "../references/sections.js";
import { h } from "./dom.js";
import { promptName, referenceCount, sectionMenuItems, showMenu, showReferenceList } from "./handles.js";
import { icon } from "./icons.js";
import { buildMenu } from "./popover.js";
/** @typedef {import("./sheet-editor.js").Rect} Rect */

/** @param {any} ed The sheet editor kernel. */
export function createSheetMenus(ed) {
  const { canvasWrap, guard, options, pageId, popovers, st, tableOf, workspace, canMerge, canPaste, canUnmerge, changeLines, clearSelectionCell, copy, currentRange, cut, deleteCells, insertCells, mergeSelection, paste, unmergeSelection } = ed;

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
        st.gesture = {
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
      if (st.justDragged) {
        st.justDragged = false;
        return;
      }
      showMenu(popovers, handle, handleMenu(target));
    });
    (canvasWrap.querySelector(".sheet-canvas") ?? canvasWrap).append(handle);
  }

  /** @param {{ x: number, y: number }} point */
  function openContextMenu(point) {
    if (!st.selection) return;
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

  return {
    placeSheetHandle,
    openContextMenu
  };
}
