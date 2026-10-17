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
  it("renders the canvas, formula bar and actions", () => {
    const { editor } = setup();
    expect(query(editor.element, ".sheet-canvas")).toBeTruthy();
    expect(query(editor.element, ".sheet-grid")).toBeTruthy();
    expect(query(editor.element, '[data-role="cell-address"]')?.textContent).toBe("—");
    expect(editor.element.querySelectorAll(".sheet-action")).toHaveLength(5);
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
    query(editor.element, "[data-action=delete-row]");
    editor.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(cell(0, 0)).toBeUndefined();
  });

  it("inserts and deletes rows and columns at the selection", () => {
    const { editor, ws, pageId, tableId, table } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 1, cell: { value: "moved" } });
    editor.selectCell(tableId, 0, 1);
    query(editor.element, "[data-action=add-row]")?.click();

    expect(table().rowCount).toBe(5);
    expect(table().cells["0,2"]).toEqual({ value: "moved" });

    query(editor.element, "[data-action=add-column]")?.click();
    expect(table().columnCount).toBe(4);

    query(editor.element, "[data-action=delete-row]")?.click();
    expect(table().rowCount).toBe(4);

    query(editor.element, "[data-action=delete-column]")?.click();
    expect(table().columnCount).toBe(3);
  });

  it("adds another table from the action bar", () => {
    const { editor, ws, pageId } = setup();
    query(editor.element, "[data-action=add-table]")?.click();
    expect(ws.getPage(pageId).content.tableOrder).toHaveLength(2);
    expect(editor.element.querySelectorAll(".sheet-table")).toHaveLength(2);
  });

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
