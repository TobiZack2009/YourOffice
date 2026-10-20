import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createSheetEditor, parseCellInput, rawCellText } from "../src/app/sheet-editor.js";

function setup() {
  const ws = createWorkspace({ title: "W" });
  ws.dispatch("createPage", { type: "sheet", title: "Budget" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("createTable", { pageId, name: "Budget", rows: 4, columns: 3, x: 0, y: 0 });
  const tableId = ws.getPage(pageId).content.tableOrder[0];
  const editor = createSheetEditor(ws, pageId);
  document.body.append(editor.element);
  const table = () => ws.getPage(pageId).content.tables[tableId];
  const cell = (/** @type {number} */ col, /** @type {number} */ row) =>
    ws.getPage(pageId).content.tables[tableId].cells[`${col},${row}`];
  return { ws, pageId, tableId, editor, table, cell };
}

/** @param {HTMLElement} root @param {string} selector */
function query(root, selector) {
  return /** @type {HTMLElement | null} */ (root.querySelector(selector));
}

describe("parseCellInput", () => {
  it("parses numbers, booleans, formulas and text", () => {
    expect(parseCellInput("")).toBeNull();
    expect(parseCellInput("42")).toEqual({ value: 42 });
    expect(parseCellInput("-3.5e2")).toEqual({ value: -350 });
    expect(parseCellInput("TRUE")).toEqual({ value: true });
    expect(parseCellInput("false")).toEqual({ value: false });
    expect(parseCellInput("=A1+1")).toEqual({ formula: "=A1+1" });
    expect(parseCellInput("hello")).toEqual({ value: "hello" });
  });
});

describe("rawCellText", () => {
  it("shows formulas verbatim and values as text", () => {
    expect(rawCellText(undefined)).toBe("");
    expect(rawCellText({ formula: "=SUM(A1:A2)" })).toBe("=SUM(A1:A2)");
    expect(rawCellText({ value: 12 })).toBe("12");
    expect(rawCellText({ value: null })).toBe("");
  });
});

describe("createSheetEditor", () => {
  it("renders the canvas and formula bar, with no in-editor action buttons", () => {
    const { editor } = setup();
    expect(query(editor.element, ".sheet-canvas")).toBeTruthy();
    expect(query(editor.element, ".sheet-grid")).toBeTruthy();
    expect(query(editor.element, '[data-role="cell-address"]')?.textContent).toBe("—");
    expect(editor.element.querySelector(".sheet-actions")).toBeNull();
    expect(editor.element.querySelector(".sheet-action")).toBeNull();
  });

  it("selects a cell on mousedown and shows its raw content", () => {
    const { ws, pageId, tableId, editor } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 1, cell: { formula: "=A1*2" } });
    const cell = /** @type {HTMLElement} */ (query(editor.element, '[data-key="1,1"]'));
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(editor.getSelection()).toEqual({ tableId, col: 1, row: 1 });
    expect(query(editor.element, '[data-role="cell-address"]')?.textContent).toBe("B2");
    expect(/** @type {HTMLInputElement} */ (query(editor.element, '[data-role="formula-input"]')).value).toBe(
      "=A1*2"
    );
    expect(query(editor.element, '[data-key="1,1"]')?.classList.contains("is-selected")).toBe(true);
  });

  it("writes literals and formulas through the formula bar", () => {
    const { editor, ws, pageId, tableId, cell } = setup();
    editor.selectCell(tableId, 0, 0);
    editor.setInputValue("10");
    editor.commit();
    editor.selectCell(tableId, 1, 0);
    editor.setInputValue("=A1*3");
    editor.commit();
    expect(cell(0, 0)).toEqual({ value: 10 });
    expect(cell(1, 0)).toEqual({ formula: "=A1*3" });
    expect(query(editor.element, '[data-key="1,0"]')?.textContent).toBe("30");
    void ws;
    void pageId;
  });

  it("navigates with the keyboard", () => {
    const { editor, tableId } = setup();
    editor.selectCell(tableId, 0, 0);
    const input = /** @type {HTMLInputElement} */ (query(editor.element, '[data-role="formula-input"]'));
    input.value = "1";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(editor.getSelection()).toEqual({ tableId, col: 0, row: 1 });

    input.value = "2";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(editor.getSelection()).toEqual({ tableId, col: 1, row: 1 });
  });

  it("clamps navigation to the table bounds", () => {
    const { editor, tableId } = setup();
    editor.selectCell(tableId, 2, 3);
    const input = /** @type {HTMLInputElement} */ (query(editor.element, '[data-role="formula-input"]'));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(editor.getSelection()).toEqual({ tableId, col: 2, row: 3 });
  });

  it("clears a cell on Delete", () => {
    const { editor, ws, pageId, tableId, cell } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 9 } });
    editor.selectCell(tableId, 0, 0);
    editor.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(cell(0, 0)).toBeUndefined();
  });

  it("inserts and deletes rows and columns at the selection", () => {
    const { editor, ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: "moved" } });
    editor.selectCell(tableId, 0, 1);
    editor.insertRow();

    expect(table().rowCount).toBe(5);
    expect(table().cells["0,2"]).toEqual({ value: "moved" });

    editor.insertColumn();
    expect(table().columnCount).toBe(4);

    editor.deleteRow();
    expect(table().rowCount).toBe(4);

    editor.deleteColumn();
    expect(table().columnCount).toBe(3);
  });

  it("applies row and column operations to every line in a range", () => {
    const { editor, tableId, table } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    editor.insertRow();
    expect(table().rowCount).toBe(6);
    editor.insertColumn();
    expect(table().columnCount).toBe(5);
  });

  it("never deletes the last row or column", () => {
    const { editor, tableId, table } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 2, row: 3 });
    editor.deleteRow();
    expect(table().rowCount).toBe(1);
    editor.deleteColumn();
    expect(table().columnCount).toBe(1);
  });

  it("adds another table", () => {
    const { editor, ws, pageId } = setup();
    editor.addTable();
    expect(ws.getPage(pageId).content.tableOrder).toHaveLength(2);
    expect(editor.element.querySelectorAll(".sheet-table")).toHaveLength(2);
  });

  it("renames the selected table", () => {
    const { editor, tableId, table } = setup();
    expect(editor.selectedTableName()).toBeNull();
    editor.selectCell(tableId, 0, 0);
    expect(editor.selectedTableName()).toBe("Budget");
    editor.renameSelectedTable("  Quarter 1  ");
    expect(table().name).toBe("Quarter 1");
    editor.renameSelectedTable("   ");
    expect(table().name).toBe("Quarter 1");
  });

  it("sizes the rows and columns of the selection", () => {
    const { editor, tableId, table } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    editor.setSelectedRowHeight(48);
    editor.setSelectedColumnWidth(150);
    expect(table().rowOverrides["0"]).toBeTruthy();
    expect(editor.selectedRowHeight()).toBe(48);
    expect(editor.selectedColumnWidth()).toBe(150);
    editor.setSelectedRowHeight(-5);
    expect(editor.selectedRowHeight()).toBe(48);
  });
});

const mouse = (/** @type {string} */ type, /** @type {object} */ init = {}) =>
  new MouseEvent(type, { bubbles: true, ...init });

describe("range selection", () => {
  it("selects a range by dragging across cells", () => {
    const { editor, tableId } = setup();
    query(editor.element, '[data-key="0,0"]')?.dispatchEvent(mouse("mousedown"));
    query(editor.element, '[data-key="1,1"]')?.dispatchEvent(mouse("mouseover"));
    query(editor.element, '[data-key="2,2"]')?.dispatchEvent(mouse("mouseover"));
    document.dispatchEvent(mouse("mouseup"));
    query(editor.element, '[data-key="0,3"]')?.dispatchEvent(mouse("mouseover"));

    expect(editor.getRange()).toEqual({
      tableId,
      start: { col: 0, row: 0 },
      end: { col: 2, row: 2 }
    });
    // The active cell stays the anchor.
    expect(editor.getSelection()).toEqual({ tableId, col: 0, row: 0 });
    expect(editor.element.querySelectorAll(".sheet-cell.is-in-range").length).toBeGreaterThan(0);
    expect(query(editor.element, '[data-key="0,0"]')?.classList.contains("is-selected")).toBe(true);
    expect(query(editor.element, '[data-key="1,1"]')?.classList.contains("is-in-range")).toBe(true);
  });

  it("extends the range with shift-click", () => {
    const { editor, tableId } = setup();
    editor.selectCell(tableId, 1, 1);
    query(editor.element, '[data-key="2,3"]')?.dispatchEvent(mouse("mousedown", { shiftKey: true }));
    document.dispatchEvent(mouse("mouseup"));
    expect(editor.getRange()).toEqual({
      tableId,
      start: { col: 1, row: 1 },
      end: { col: 2, row: 3 }
    });
  });

  it("normalises a range dragged up and to the left", () => {
    const { editor, tableId } = setup();
    editor.selectRange(tableId, { col: 2, row: 2 }, { col: 0, row: 1 });
    expect(editor.getRange()).toEqual({
      tableId,
      start: { col: 0, row: 1 },
      end: { col: 2, row: 2 }
    });
  });

  it("extends with shift+arrow and collapses on a plain arrow", () => {
    const { editor, tableId } = setup();
    editor.selectCell(tableId, 0, 0);
    editor.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }));
    editor.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    expect(editor.getRange()).toEqual({ tableId, start: { col: 0, row: 0 }, end: { col: 1, row: 1 } });

    editor.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const range = editor.getRange();
    expect(range?.start).toEqual(range?.end);
  });

  it("clears every cell in the range on Delete", () => {
    const { editor, ws, pageId, tableId, cell } = setup();
    for (const [col, row] of [[0, 0], [1, 0], [1, 1], [2, 2]]) {
      ws.dispatch("setCell", { pageId, tableId, col, row, cell: { value: 1 } });
    }
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    editor.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(cell(0, 0)).toBeUndefined();
    expect(cell(1, 0)).toBeUndefined();
    expect(cell(1, 1)).toBeUndefined();
    expect(cell(2, 2)).toEqual({ value: 1 });
  });

  it("reports selection changes", () => {
    const calls = [];
    const { ws, pageId, tableId } = setup();
    const editor = createSheetEditor(ws, pageId, { onSelectionChange: () => calls.push(1) });
    const before = calls.length;
    editor.selectCell(tableId, 1, 1);
    expect(calls.length).toBeGreaterThan(before);
    editor.destroy();
  });
});

describe("merge and unmerge", () => {
  it("cannot merge without a multi-cell range", () => {
    const { editor, tableId, table } = setup();
    expect(editor.canMerge()).toBe(false);
    editor.selectCell(tableId, 0, 0);
    expect(editor.canMerge()).toBe(false);
    editor.mergeSelection();
    expect(table().merges).toHaveLength(0);
  });

  it("merges the selected range and renders it as one spanning cell", () => {
    const { editor, tableId, table } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    expect(editor.canMerge()).toBe(true);
    expect(editor.canUnmerge()).toBe(false);
    editor.mergeSelection();

    expect(table().merges).toEqual([{ start: { col: 0, row: 0 }, end: { col: 1, row: 1 } }]);
    const anchor = query(editor.element, '[data-key="0,0"]');
    expect(anchor?.getAttribute("colspan")).toBe("2");
    expect(anchor?.getAttribute("rowspan")).toBe("2");
    expect(query(editor.element, '[data-key="1,1"]')).toBeNull();
    expect(editor.canMerge()).toBe(false);
    expect(editor.canUnmerge()).toBe(true);
  });

  it("highlights a merged cell as a unit when any of it is selected", () => {
    const { editor, tableId } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    editor.mergeSelection();
    editor.selectCell(tableId, 1, 1);
    expect(query(editor.element, '[data-key="0,0"]')?.classList.contains("is-selected")).toBe(true);
  });

  it("unmerges every merge touched by the selection in one undo step", () => {
    const { editor, ws, tableId, table } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 0 });
    editor.mergeSelection();
    editor.selectRange(tableId, { col: 0, row: 2 }, { col: 1, row: 2 });
    editor.mergeSelection();
    expect(table().merges).toHaveLength(2);

    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 2 });
    editor.unmergeSelection();
    expect(table().merges).toHaveLength(0);

    ws.undo();
    expect(table().merges).toHaveLength(2);
  });

  it("refuses to merge over an existing merge", () => {
    const { editor, tableId, table } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 0 });
    editor.mergeSelection();
    editor.selectRange(tableId, { col: 1, row: 0 }, { col: 2, row: 1 });
    expect(editor.canMerge()).toBe(false);
    editor.mergeSelection();
    expect(table().merges).toHaveLength(1);
  });
});

describe("createSheetEditor lifecycle", () => {
  it("recomputes dependents after edits", () => {
    const { editor, tableId, ws, pageId } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 4 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A1*2" } });
    editor.selectCell(tableId, 0, 0);
    editor.setInputValue("5");
    editor.commit();
    expect(query(editor.element, '[data-key="1,0"]')?.textContent).toBe("10");
  });

  it("stops responding after destroy", () => {
    const { editor, ws, pageId, tableId } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: "before" } });
    expect(query(editor.element, '[data-key="0,0"]')?.textContent).toBe("before");

    editor.destroy();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: "after" } });
    expect(query(editor.element, '[data-key="0,0"]')?.textContent).toBe("before");
  });

  describe("multiple ranges, fill and clipboard", () => {
    const mouse = (type, init = {}) => new MouseEvent(type, { bubbles: true, ...init });
    const key = (target, k, init = {}) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

    it("adds a range on Ctrl/Cmd+click and keeps the earlier ones", () => {
      const { editor, tableId } = setup();
      query(editor.element, '[data-key="0,0"]')?.dispatchEvent(mouse("mousedown"));
      query(editor.element, '[data-key="2,2"]')?.dispatchEvent(mouse("mousedown", { ctrlKey: true }));
      query(editor.element, '[data-key="2,3"]')?.dispatchEvent(mouse("mouseover"));
      expect(editor.getRanges()).toEqual([
        { tableId, start: { col: 0, row: 0 }, end: { col: 0, row: 0 } },
        { tableId, start: { col: 2, row: 2 }, end: { col: 2, row: 3 } }
      ]);
      expect(editor.getRange()?.start).toEqual({ col: 2, row: 2 });
      const marked = [...editor.element.querySelectorAll(".is-in-range")].map((el) => el.getAttribute("data-key"));
      expect(marked.sort()).toEqual(["0,0", "2,2", "2,3"]);

      query(editor.element, '[data-key="1,1"]')?.dispatchEvent(mouse("mousedown"));
      expect(editor.getRanges()).toHaveLength(1);
    });

    it("fills the formula-bar content into every range with Ctrl+Enter, relative to the active cell", () => {
      const { ws, editor, tableId, cell } = setup();
      editor.selectCell(tableId, 2, 3);
      editor.addRange(tableId, { col: 0, row: 0 }, { col: 1, row: 0 });
      editor.setInputValue("=B2*2");
      const input = query(editor.element, '[data-role="formula-input"]');
      key(input, "Enter", { ctrlKey: true });
      expect(cell(0, 0)).toEqual({ formula: "=B2*2" });
      expect(cell(1, 0)).toEqual({ formula: "=C2*2" });
      expect(cell(2, 3)).toEqual({ formula: "=D5*2" });
      ws.undo();
      expect(cell(0, 0)).toBeUndefined();
      expect(cell(2, 3)).toBeUndefined();
    });

    it("fills plain values into disjoint ranges", () => {
      const { editor, tableId, cell } = setup();
      editor.selectRange(tableId, { col: 0, row: 0 }, { col: 0, row: 1 });
      editor.addRange(tableId, { col: 2, row: 3 }, { col: 2, row: 3 });
      editor.setInputValue("7");
      editor.fillSelection();
      expect([cell(0, 0), cell(0, 1), cell(2, 3)]).toEqual([{ value: 7 }, { value: 7 }, { value: 7 }]);
      expect(cell(1, 1)).toBeUndefined();
    });

    it("clears every range on Delete", () => {
      const { ws, pageId, tableId, editor, cell } = setup();
      for (const [col, row] of [[0, 0], [2, 2], [1, 1]]) {
        ws.dispatch("setCell", { pageId, tableId, col, row, cell: { value: 1 } });
      }
      editor.selectCell(tableId, 0, 0);
      editor.addRange(tableId, { col: 2, row: 2 }, { col: 2, row: 2 });
      key(editor.element, "Delete");
      expect(cell(0, 0)).toBeUndefined();
      expect(cell(2, 2)).toBeUndefined();
      expect(cell(1, 1)).toEqual({ value: 1 });
    });

    it("copies and pastes with relative references, tiling into a larger selection", () => {
      const { ws, pageId, tableId, editor, cell } = setup();
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 2 } });
      ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A1+1" } });
      editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 0 });
      expect(editor.canPaste()).toBe(false);
      expect(editor.copy()).toBe(true);
      expect(editor.canPaste()).toBe(true);

      editor.selectRange(tableId, { col: 0, row: 2 }, { col: 0, row: 2 });
      expect(editor.paste()).toBe(true);
      expect(cell(0, 2)).toEqual({ value: 2 });
      expect(cell(1, 2)).toEqual({ formula: "=A3+1" });
      expect(editor.getRange()).toMatchObject({ start: { col: 0, row: 2 }, end: { col: 1, row: 2 } });

      editor.selectRange(tableId, { col: 0, row: 3 }, { col: 1, row: 3 });
      editor.addRange(tableId, { col: 2, row: 0 }, { col: 2, row: 0 });
      editor.paste();
      expect(cell(0, 3)).toEqual({ value: 2 });
      expect(cell(1, 3)).toEqual({ formula: "=A4+1" });
      expect(cell(2, 0)).toEqual({ value: 2 });
      expect(cell(0, 0)).toEqual({ value: 2 });
    });

    it("tiles a single copied cell across a whole range", () => {
      const { ws, pageId, tableId, editor, cell } = setup();
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: "x" } });
      editor.selectCell(tableId, 0, 0);
      editor.copy();
      editor.selectRange(tableId, { col: 1, row: 1 }, { col: 2, row: 3 });
      editor.paste();
      expect(cell(1, 1)).toEqual({ value: "x" });
      expect(cell(2, 3)).toEqual({ value: "x" });
    });

    it("moves cut cells on paste and clears the clipboard", () => {
      const { ws, pageId, tableId, editor, cell } = setup();
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { formula: "=A1+1" } });
      editor.selectRange(tableId, { col: 0, row: 0 }, { col: 0, row: 1 });
      editor.cut();
      editor.selectCell(tableId, 2, 1);
      expect(editor.paste()).toBe(true);
      expect(cell(0, 0)).toBeUndefined();
      expect(cell(0, 1)).toBeUndefined();
      expect(cell(2, 1)).toEqual({ value: 1 });
      expect(cell(2, 2)).toEqual({ formula: "=C2+1" });
      expect(editor.canPaste()).toBe(false);
    });

    it("uses Ctrl+C / Ctrl+V on the cell clipboard but leaves native editing alone while typing", () => {
      const { ws, pageId, tableId, editor, cell } = setup();
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 4 } });
      const input = query(editor.element, '[data-role="formula-input"]');
      editor.selectCell(tableId, 0, 0);
      expect(key(input, "c", { ctrlKey: true })).toBe(false); // cell copy: default prevented
      editor.selectCell(tableId, 1, 1);
      expect(key(input, "v", { ctrlKey: true })).toBe(false);
      expect(cell(1, 1)).toEqual({ value: 4 });

      editor.selectCell(tableId, 2, 2);
      editor.setInputValue("typing");
      expect(key(input, "v", { ctrlKey: true })).toBe(true); // native paste into the input
      expect(cell(2, 2)).toBeUndefined();
    });

    it("fills down and right from the edge, or from the line above for a thin range", () => {
      const { ws, pageId, tableId, editor, cell } = setup();
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
      ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A1+1" } });
      editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 2 });
      key(editor.element, "d", { ctrlKey: true });
      expect(cell(0, 2)).toEqual({ value: 1 });
      expect(cell(1, 2)).toEqual({ formula: "=A3+1" });

      editor.selectRange(tableId, { col: 0, row: 3 }, { col: 1, row: 3 });
      editor.fillDown();
      expect(cell(1, 3)).toEqual({ formula: "=A4+1" });

      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 3, cell: { formula: "=A1" } });
      editor.selectRange(tableId, { col: 0, row: 3 }, { col: 2, row: 3 });
      key(editor.element, "r", { ctrlKey: true });
      expect(cell(1, 3)).toEqual({ formula: "=B1" });
      expect(cell(2, 3)).toEqual({ formula: "=C1" });
    });

    it("applies row height and column width to every range", () => {
      const { editor, tableId, table } = setup();
      editor.selectCell(tableId, 0, 0);
      editor.addRange(tableId, { col: 2, row: 3 }, { col: 2, row: 3 });
      editor.setSelectedRowHeight(50);
      editor.setSelectedColumnWidth(120);
      expect(table().rowOverrides["0"]).toEqual({ height: 50 });
      expect(table().rowOverrides["3"]).toEqual({ height: 50 });
      expect(table().columnOverrides["2"]).toEqual({ width: 120 });
    });
  });
});

describe("fill handle, drag-to-move and the context menu", () => {
  const key = (/** @type {EventTarget} */ target, /** @type {string} */ k, init = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  const over = (/** @type {HTMLElement} */ root, /** @type {string} */ at) =>
    query(root, `[data-key="${at}"]`)?.dispatchEvent(mouse("mouseover"));
  const menuItem = (/** @type {string} */ action) =>
    /** @type {HTMLButtonElement | null} */ (document.body.querySelector(`.context-menu [data-action="${action}"]`));

  it("shows the fill handle in the corner of the selection", () => {
    const { editor, tableId } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    const handles = editor.element.querySelectorAll("[data-role=fill-handle]");
    expect(handles).toHaveLength(1);
    expect(handles[0].closest("[data-key]")?.getAttribute("data-key")).toBe("1,1");
  });

  it("duplicates a cell by dragging the fill handle down, shifting relative references", () => {
    const { ws, pageId, tableId, editor, cell } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 5 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A1*2" } });
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 0 });
    query(editor.element, "[data-role=fill-handle]")?.dispatchEvent(mouse("mousedown"));
    over(editor.element, "1,1");
    expect(editor.element.querySelectorAll(".is-fill-preview").length).toBeGreaterThan(0);
    over(editor.element, "1,2");
    document.dispatchEvent(mouse("mouseup"));

    expect(cell(0, 1)).toEqual({ value: 5 });
    expect(cell(0, 2)).toEqual({ value: 5 });
    expect(cell(1, 1)).toEqual({ formula: "=A2*2" });
    expect(cell(1, 2)).toEqual({ formula: "=A3*2" });
    expect(editor.getRange()).toEqual({ tableId, start: { col: 0, row: 0 }, end: { col: 1, row: 2 } });
    expect(editor.element.querySelectorAll(".is-fill-preview")).toHaveLength(0);
    ws.undo();
    expect(cell(0, 2)).toBeUndefined();
  });

  it("recalculates formulas elsewhere that read a cell after it is dragged away", () => {
    const { ws, pageId, tableId, editor, cell } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 5 } });
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 0, cell: { formula: "=A1*2" } });
    editor.selectCell(tableId, 0, 0);
    query(editor.element, '[data-key="0,0"]')?.dispatchEvent(mouse("mousedown"));
    over(editor.element, "1,2");
    document.dispatchEvent(mouse("mouseup"));
    expect(cell(1, 2)).toEqual({ value: 5 });
    expect(cell(2, 0)).toEqual({ formula: "=B3*2" });
    expect(query(editor.element, '[data-key="2,0"]')?.textContent).toBe("10");
    editor.destroy();
  });

  it("fills to the left or up from the fill handle", () => {
    const { ws, pageId, tableId, editor, cell } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 3, cell: { value: 9 } });
    editor.selectCell(tableId, 2, 3);
    query(editor.element, "[data-role=fill-handle]")?.dispatchEvent(mouse("mousedown"));
    over(editor.element, "2,1");
    document.dispatchEvent(mouse("mouseup"));
    expect(cell(2, 1)).toEqual({ value: 9 });
    expect(cell(2, 2)).toEqual({ value: 9 });
    expect(editor.getRange()).toEqual({ tableId, start: { col: 2, row: 1 }, end: { col: 2, row: 3 } });
  });

  it("does nothing when a fill drag ends on the source", () => {
    const { ws, pageId, tableId, editor, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
    editor.selectCell(tableId, 0, 0);
    const before = JSON.stringify(table().cells);
    query(editor.element, "[data-role=fill-handle]")?.dispatchEvent(mouse("mousedown"));
    over(editor.element, "0,0");
    document.dispatchEvent(mouse("mouseup"));
    expect(JSON.stringify(table().cells)).toBe(before);
  });

  it("moves the selected cells by dragging them", () => {
    const { ws, pageId, tableId, editor, cell } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 3 } });
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { formula: "=A1+1" } });
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 0, row: 1 });
    query(editor.element, '[data-key="0,0"]')?.dispatchEvent(mouse("mousedown"));
    over(editor.element, "1,0");
    over(editor.element, "2,0");
    expect(editor.element.querySelectorAll(".is-drop-preview")).toHaveLength(2);
    document.dispatchEvent(mouse("mouseup"));

    expect(cell(0, 0)).toBeUndefined();
    expect(cell(2, 0)).toEqual({ value: 3 });
    expect(cell(2, 1)).toEqual({ formula: "=C1+1" });
    expect(editor.getRange()).toEqual({ tableId, start: { col: 2, row: 0 }, end: { col: 2, row: 1 } });
    expect(editor.element.querySelectorAll(".is-drop-preview")).toHaveLength(0);
  });

  it("treats a press-and-release on a selected cell as a plain click", () => {
    const { editor, tableId } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 2, row: 2 });
    query(editor.element, '[data-key="1,1"]')?.dispatchEvent(mouse("mousedown"));
    document.dispatchEvent(mouse("mouseup"));
    expect(editor.getRange()).toEqual({ tableId, start: { col: 1, row: 1 }, end: { col: 1, row: 1 } });
  });

  it("ignores the right mouse button on mousedown", () => {
    const { editor, tableId } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    query(editor.element, '[data-key="2,2"]')?.dispatchEvent(mouse("mousedown", { button: 2 }));
    expect(editor.getRange()).toEqual({ tableId, start: { col: 0, row: 0 }, end: { col: 1, row: 1 } });
  });

  describe("context menu", () => {
    const openOn = (/** @type {HTMLElement} */ root, /** @type {string} */ at) =>
      query(root, `[data-key="${at}"]`)?.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
      );

    it("opens on right-click, selecting the cell when it is outside the selection", () => {
      const { editor, tableId } = setup();
      editor.selectCell(tableId, 0, 0);
      openOn(editor.element, "2,2");
      expect(document.body.querySelector(".popover.context-menu")).toBeTruthy();
      expect(editor.getRange()).toEqual({ tableId, start: { col: 2, row: 2 }, end: { col: 2, row: 2 } });
      editor.destroy();
      expect(document.body.querySelector(".popover.context-menu")).toBeNull();
    });

    it("groups the shift options under Insert and Delete submenus", () => {
      const { editor, tableId } = setup();
      editor.selectCell(tableId, 0, 0);
      openOn(editor.element, "0,0");
      const menu = document.body.querySelector(".popover.context-menu .menu");
      const sections = [...(menu?.querySelectorAll(":scope > .menu-submenu > .menu-submenu-trigger") ?? [])];
      expect(sections.map((el) => el.textContent?.replace("\u203A", ""))).toEqual(["Insert", "Delete"]);
      // The shift options are not top-level rows.
      const topLevel = [...(menu?.children ?? [])].filter((el) => el.matches(".menu-item"));
      expect(topLevel.some((el) => el.getAttribute("data-action")?.startsWith("insert-cells"))).toBe(false);
      const insert = menu?.querySelector(".menu-submenu");
      expect(insert?.querySelector('[data-action="insert-cells-right"]')).toBeTruthy();
      expect(insert?.classList.contains("is-open")).toBe(false);
      insert?.dispatchEvent(new MouseEvent("mouseenter"));
      expect(insert?.classList.contains("is-open")).toBe(true);
      editor.destroy();
    });

    it("keeps a multi-cell selection when right-clicking inside it", () => {
      const { editor, tableId } = setup();
      editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
      openOn(editor.element, "1,1");
      expect(editor.getRange()).toEqual({ tableId, start: { col: 0, row: 0 }, end: { col: 1, row: 1 } });
      editor.destroy();
    });

    it("shifts cells down and right, and back up and left", () => {
      const { ws, pageId, tableId, editor, cell } = setup();
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: "a" } });
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: "b" } });
      openOn(editor.element, "0,0");
      menuItem("insert-cells-down")?.click();
      expect(cell(0, 0)).toBeUndefined();
      expect(cell(0, 1)).toEqual({ value: "a" });
      expect(cell(0, 2)).toEqual({ value: "b" });
      expect(document.body.querySelector(".popover.context-menu")).toBeNull();

      openOn(editor.element, "0,0");
      menuItem("delete-cells-up")?.click();
      expect(cell(0, 0)).toEqual({ value: "a" });
      expect(cell(0, 1)).toEqual({ value: "b" });

      openOn(editor.element, "0,0");
      menuItem("insert-cells-right")?.click();
      expect(cell(1, 0)).toEqual({ value: "a" });
      expect(cell(0, 0)).toBeUndefined();

      openOn(editor.element, "0,0");
      menuItem("delete-cells-left")?.click();
      expect(cell(0, 0)).toEqual({ value: "a" });
      editor.destroy();
    });

    it("retargets formulas when cells shift", () => {
      const { ws, pageId, tableId, editor, cell } = setup();
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 7 } });
      ws.dispatch("setCell", { pageId, tableId, col: 2, row: 0, cell: { formula: "=A1" } });
      openOn(editor.element, "0,0");
      menuItem("insert-cells-down")?.click();
      expect(cell(0, 1)).toEqual({ value: 7 });
      expect(cell(2, 0)).toEqual({ formula: "=A2" });
      ws.undo();
      expect(cell(2, 0)).toEqual({ formula: "=A1" });
      editor.destroy();
    });

    it("copies, cuts and pastes, with Paste disabled until something is copied", () => {
      const { ws, pageId, tableId, editor, cell } = setup();
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 4 } });
      openOn(editor.element, "0,0");
      expect(menuItem("sheet-paste")?.disabled).toBe(true);
      menuItem("sheet-copy")?.click();

      openOn(editor.element, "2,2");
      expect(menuItem("sheet-paste")?.disabled).toBe(false);
      menuItem("sheet-paste")?.click();
      expect(cell(2, 2)).toEqual({ value: 4 });
      expect(cell(0, 0)).toEqual({ value: 4 });

      openOn(editor.element, "0,0");
      menuItem("sheet-cut")?.click();
      openOn(editor.element, "1,1");
      menuItem("sheet-paste")?.click();
      expect(cell(1, 1)).toEqual({ value: 4 });
      expect(cell(0, 0)).toBeUndefined();
      editor.destroy();
    });

    it("clears cells and offers row/column and merge actions", () => {
      const { ws, pageId, tableId, editor, cell, table } = setup();
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
      ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { value: 2 } });
      editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 0 });
      openOn(editor.element, "0,0");
      expect(menuItem("merge")?.disabled).toBe(false);
      expect(menuItem("unmerge")?.disabled).toBe(true);
      menuItem("sheet-clear")?.click();
      expect(cell(0, 0)).toBeUndefined();
      expect(cell(1, 0)).toBeUndefined();

      openOn(editor.element, "0,0");
      menuItem("add-row")?.click();
      expect(table().rowCount).toBe(5);
      openOn(editor.element, "0,0");
      menuItem("delete-column")?.click(); // the two selected columns go
      expect(table().columnCount).toBe(1);
      editor.destroy();
    });

    it("leaves the sheet alone when a shift would cross a merged cell", () => {
      const { ws, pageId, tableId, editor, table } = setup();
      ws.dispatch("mergeCells", { pageId, tableId, start: { col: 0, row: 1 }, end: { col: 1, row: 1 } });
      ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 1 } });
      const before = JSON.stringify(table().cells);
      openOn(editor.element, "0,0");
      expect(() => menuItem("insert-cells-down")?.click()).not.toThrow();
      expect(JSON.stringify(table().cells)).toBe(before);
      editor.destroy();
    });
  });
});

describe("in-cell editing", () => {
  const key = (/** @type {EventTarget} */ target, /** @type {string} */ k, init = {}) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  const cellEditor = (/** @type {HTMLElement} */ root) => /** @type {HTMLInputElement | null} */ (query(root, ".sheet-cell-editor"));
  const type = (/** @type {HTMLInputElement} */ field, /** @type {string} */ text) => {
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  it("starts editing inside the cell when a character is typed, replacing its content", () => {
    const { ws, pageId, tableId, editor, cell } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 1, cell: { value: "old" } });
    editor.selectCell(tableId, 1, 1);
    key(editor.element.querySelector(".sheet-canvas-wrap"), "7");
    const field = cellEditor(editor.element);
    expect(field).toBeTruthy();
    expect(field?.value).toBe("7");
    expect(field?.closest("td")?.getAttribute("data-key")).toBe("1,1");
    expect(query(editor.element, '[data-role="formula-input"]')?.value).toBe("7");

    type(/** @type {HTMLInputElement} */ (field), "72");
    key(field, "Enter");
    expect(cell(1, 1)).toEqual({ value: 72 });
    expect(cellEditor(editor.element)).toBeNull();
    expect(editor.getSelection()).toEqual({ tableId, col: 1, row: 2 });
    editor.destroy();
  });

  it("edits the existing content on double-click and F2, committing with Tab", () => {
    const { ws, pageId, tableId, editor, cell } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { formula: "=1+1" } });
    editor.selectCell(tableId, 0, 0);
    query(editor.element, '[data-key="0,0"]')?.dispatchEvent(mouse("mousedown", { detail: 2 }));
    let field = cellEditor(editor.element);
    expect(field?.value).toBe("=1+1");
    key(/** @type {HTMLInputElement} */ (field), "Tab");
    expect(cell(0, 0)).toEqual({ formula: "=1+1" });
    expect(editor.getSelection()).toEqual({ tableId, col: 1, row: 0 });

    key(editor.element.querySelector(".sheet-canvas-wrap"), "F2");
    field = cellEditor(editor.element);
    expect(field).toBeTruthy();
    expect(field?.closest("td")?.getAttribute("data-key")).toBe("1,0");
    editor.destroy();
  });

  it("cancels with Escape and leaves the cell as it was", () => {
    const { ws, pageId, tableId, editor, cell } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 5 } });
    editor.selectCell(tableId, 0, 0);
    key(editor.element.querySelector(".sheet-canvas-wrap"), "x");
    key(/** @type {HTMLInputElement} */ (cellEditor(editor.element)), "Escape");
    expect(cellEditor(editor.element)).toBeNull();
    expect(cell(0, 0)).toEqual({ value: 5 });
    expect(query(editor.element, '[data-role="formula-input"]')?.value).toBe("5");
    editor.destroy();
  });

  it("mirrors the formula bar and survives a re-render while editing", () => {
    const { ws, pageId, tableId, editor } = setup();
    editor.selectCell(tableId, 0, 0);
    key(editor.element.querySelector(".sheet-canvas-wrap"), "a");
    const bar = /** @type {HTMLInputElement} */ (query(editor.element, '[data-role="formula-input"]'));
    bar.value = "abc";
    bar.dispatchEvent(new Event("input", { bubbles: true }));
    expect(cellEditor(editor.element)?.value).toBe("abc");

    // Something else changes the sheet; the edit in progress stays put.
    ws.dispatch("setCell", { pageId, tableId, col: 2, row: 2, cell: { value: 1 } });
    const field = cellEditor(editor.element);
    expect(field?.value).toBe("abc");
    expect(field?.closest("td")?.getAttribute("data-key")).toBe("0,0");
    editor.destroy();
  });

  it("commits when another cell is pressed, and when the formula bar commits", () => {
    const { editor, tableId, cell } = setup();
    editor.selectCell(tableId, 0, 0);
    key(editor.element.querySelector(".sheet-canvas-wrap"), "5");
    query(editor.element, '[data-key="2,2"]')?.dispatchEvent(mouse("mousedown"));
    expect(cell(0, 0)).toEqual({ value: 5 });
    expect(cellEditor(editor.element)).toBeNull();
    expect(editor.getSelection()).toEqual({ tableId, col: 2, row: 2 });

    key(editor.element.querySelector(".sheet-canvas-wrap"), "9");
    const bar = /** @type {HTMLInputElement} */ (query(editor.element, '[data-role="formula-input"]'));
    key(bar, "Enter");
    expect(cell(2, 2)).toEqual({ value: 9 });
    expect(cellEditor(editor.element)).toBeNull();
    editor.destroy();
  });
});

describe("resizing from the headers", () => {
  it("drags a column's header edge to set its width, in one undoable step", () => {
    const { ws, editor, table } = setup();
    const grip = query(editor.element, '[data-role="col-resize"][data-col="1"]');
    expect(grip).toBeTruthy();
    grip?.dispatchEvent(mouse("mousedown", { clientX: 100 }));
    document.dispatchEvent(mouse("mousemove", { clientX: 140 }));
    expect(query(editor.element, 'col[data-col="1"]')?.style.width).toBe("136px");
    document.dispatchEvent(mouse("mouseup"));
    expect(table().columnOverrides["1"]).toEqual({ width: 136 });
    expect(editor.selectedColumnWidth()).toBeNull();
    ws.undo();
    expect(table().columnOverrides["1"]).toBeUndefined();
    editor.destroy();
  });

  it("drags a row's header edge, never below the minimum, and ignores a drag that goes nowhere", () => {
    const { editor, table } = setup();
    query(editor.element, '[data-role="row-resize"][data-row="2"]')?.dispatchEvent(mouse("mousedown", { clientY: 80 }));
    document.dispatchEvent(mouse("mousemove", { clientY: -400 }));
    document.dispatchEvent(mouse("mouseup"));
    expect(table().rowOverrides["2"]).toEqual({ height: 16 });

    query(editor.element, '[data-role="col-resize"][data-col="0"]')?.dispatchEvent(mouse("mousedown", { clientX: 10 }));
    document.dispatchEvent(mouse("mouseup"));
    expect(table().columnOverrides["0"]).toBeUndefined();
    editor.destroy();
  });
});
