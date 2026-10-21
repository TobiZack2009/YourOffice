/**
 * Editing the active cell: the in-cell editor and the formula bar.
 */

import { parseCellInput } from "./sheet-cell-input.js";

/** @param {any} ed The sheet editor kernel. */
export function createSheetCellEdit(ed) {
  const { canvasWrap, cellInput, input, pageId, refresh, st, workspace, moveSelection } = ed;

  /** Keep the keyboard on the grid, so arrows move the selection and typing starts an edit. */
  function focusGrid() {
    canvasWrap.focus({ preventScroll: true });
  }

  /** The `<td>` of the active cell, if it is drawn (a cell covered by a merge is not). */
  function activeCellElement() {
    if (!st.selection) return null;
    const { tableId, anchor } = st.selection;
    const host = [...canvasWrap.querySelectorAll(".sheet-table")].find(
      (el) => el.getAttribute("data-table-id") === tableId
    );
    return /** @type {HTMLElement | null} */ (host?.querySelector(`td[data-key="${anchor.col},${anchor.row}"]`) ?? null);
  }

  /** Stop editing in place (the formula bar keeps whatever it holds). */
  function endCellEdit() {
    if (!st.cellEditing) return;
    st.cellEditing = false;
    st.suppressBlur = true;
    cellInput.parentElement?.classList.remove("is-editing");
    cellInput.remove();
    st.suppressBlur = false;
  }

  /**
   * Put the in-cell editor into the active cell's `<td>` (after every render) and focus it.
   * @param {number[] | null} [caret] Selection to restore.
   * @param {boolean} [focus] False to place it without taking the keyboard (the formula bar has it).
   */
  function placeCellEditor(caret, focus = true) {
    if (!st.cellEditing) return;
    const td = activeCellElement();
    if (!td) {
      st.cellEditing = false;
      return;
    }
    st.suppressBlur = true;
    td.classList.add("is-editing");
    if (cellInput.parentElement !== td) td.append(cellInput);
    if (focus) {
      cellInput.focus({ preventScroll: true });
      const end = cellInput.value.length;
      cellInput.setSelectionRange(caret ? caret[0] : end, caret ? caret[1] : end);
    }
    st.suppressBlur = false;
  }

  /**
   * Edit the active cell in place. With `text` the cell restarts from it (typing
   * over a cell); without, the cell's current content is edited (double-click, F2).
   * @param {string} [text]
   * @returns {boolean} Whether editing started.
   */
  function startCellEdit(text) {
    if (!st.selection || !activeCellElement()) return false;
    if (text !== undefined) {
      input.value = text;
      st.inputDirty = true;
    }
    st.cellEditing = true;
    cellInput.value = input.value;
    placeCellEditor();
    return st.cellEditing;
  }

  /** @param {[number, number]} [move] Selection step after the commit. */
  function commitCellEdit(move) {
    endCellEdit();
    commitInput(move);
    focusGrid();
  }

  function cancelCellEdit() {
    endCellEdit();
    st.inputDirty = false;
    refresh();
    focusGrid();
  }

  cellInput.addEventListener("input", () => {
    input.value = cellInput.value;
    st.inputDirty = true;
  });

  cellInput.addEventListener("keydown", (event) => {
    const keyboard = /** @type {KeyboardEvent} */ (event);
    if (ed.handleShortcut(keyboard, true, cellInput)) {
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
    if (st.suppressBlur || !st.cellEditing) return;
    // Moving to the formula bar continues the same edit there.
    if (/** @type {FocusEvent} */ (event).relatedTarget === input) return;
    endCellEdit();
    if (st.inputDirty) commitInput();
  });

  function commitInput(move) {
    if (!st.selection) return;
    endCellEdit();
    const payload = parseCellInput(input.value);
    workspace.dispatch("setCell", {
      pageId,
      tableId: st.selection.tableId,
      col: st.selection.anchor.col,
      row: st.selection.anchor.row,
      cell: payload
    });
    st.inputDirty = false;
    if (move) moveSelection(move[0], move[1]);
    else refresh();
  }

  input.addEventListener("input", () => {
    st.inputDirty = true;
    if (st.cellEditing) cellInput.value = input.value;
  });

  input.addEventListener("keydown", (event) => {
    const keyboard = /** @type {KeyboardEvent} */ (event);
    if (ed.handleShortcut(keyboard, true)) {
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
      st.inputDirty = false;
      refresh();
      input.blur();
    }
  });

  return {
    focusGrid,
    activeCellElement,
    endCellEdit,
    placeCellEditor,
    startCellEdit,
    commitCellEdit,
    cancelCellEdit,
    commitInput
  };
}
