import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { registerSheetCommands } from "../src/sheet/commands.js";
import { createSheetEditor, parseCellInput, rawCellText } from "../src/app/sheet-editor.js";

function setup() {
  const ws = Workspace.create({ title: "W" });
  registerDocumentCommands(ws);
  registerSheetCommands(ws);
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
    editor.renameSelectedTable("  Q1  ");
    expect(table().name).toBe("Q1");
    editor.renameSelectedTable("   ");
    expect(table().name).toBe("Q1");
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
});
