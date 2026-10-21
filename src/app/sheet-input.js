/**
 * Sheet canvas events: double click, context menu and keyboard.
 */


/** @param {any} ed The sheet editor kernel. */
export function createSheetInput(ed) {
  const { canvasWrap, cellInput, element, input, st, allRanges, cellFromTarget, clearSelectionCell, focusGrid, handleShortcut, moveSelection, openContextMenu, rectHas, selectCell, startCellEdit } = ed;

  canvasWrap.addEventListener("dblclick", (event) => {
    const hit = cellFromTarget(event.target);
    if (!hit || st.cellEditing) return;
    selectCell(hit.tableId, hit.col, hit.row);
    startCellEdit();
  });

  canvasWrap.addEventListener("contextmenu", (event) => {
    if (event.target === cellInput) return; // the browser's text menu, for the cell being edited
    const hit = cellFromTarget(event.target);
    if (!hit) return;
    event.preventDefault();
    st.gesture = null;
    const inside = allRanges().some((range) => range.tableId === hit.tableId && rectHas(range, hit));
    if (!inside) selectCell(hit.tableId, hit.col, hit.row);
    const mouse = /** @type {MouseEvent} */ (event);
    openContextMenu({ x: mouse.clientX, y: mouse.clientY });
  });

  element.addEventListener("keydown", (event) => {
    if (event.target === input || event.target === cellInput) return;
    const keyboard = /** @type {KeyboardEvent} */ (event);
    if (!st.selection) return;
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
        st.inputDirty = true;
        input.focus();
      }
    }
  });

}
