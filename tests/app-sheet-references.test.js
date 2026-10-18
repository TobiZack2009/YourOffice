import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerSheetCommands } from "../src/sheet/commands.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { createSheetEditor } from "../src/app/sheet-editor.js";
import { clearNotice } from "../src/app/notice.js";

function setup() {
  const ws = Workspace.create({ title: "W" });
  registerDocumentCommands(ws);
  registerSheetCommands(ws);
  ws.dispatch("createPage", { type: "sheet", title: "Budget" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("createTable", { pageId, name: "Costs", rows: 4, columns: 3, x: 40, y: 30 });
  const tableId = ws.getPage(pageId).content.tableOrder[0];
  const editor = createSheetEditor(ws, pageId);
  document.body.append(editor.element);
  return { ws, pageId, tableId, editor, table: () => ws.getPage(pageId).content.tables[tableId] };
}

const handle = (editor) => editor.element.querySelector("[data-role=sheet-handle]");
const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

afterEach(() => {
  clearNotice();
  document.body.replaceChildren();
});

describe("sheet section handle", () => {
  it("stands for the table when a cell (or nothing) is selected", () => {
    const { editor, tableId } = setup();
    expect(handle(editor).getAttribute("data-mode")).toBe("table");
    editor.selectCell(tableId, 1, 1);
    expect(handle(editor).getAttribute("data-mode")).toBe("table");
  });

  it("follows a multi-cell selection as a range handle", () => {
    const { editor, tableId } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    expect(handle(editor).getAttribute("data-mode")).toBe("range");
  });

  it("is placed inside the canvas beside the table", () => {
    const { editor, table } = setup();
    const el = handle(editor);
    expect(el.parentElement.classList.contains("sheet-canvas")).toBe(true);
    expect(el.style.left).toBe(`${table().position.x - 24}px`);
    expect(el.style.top).toBe(`${table().position.y}px`);
  });

  it("renames the table through its menu", () => {
    const { ws, pageId, editor, table } = setup();
    click(handle(editor));
    click(document.querySelector("[data-action=table-rename]"));
    document.querySelector(".name-prompt-input").value = "Spend";
    document.querySelector("[data-action=name-confirm]").click();
    expect(table().name).toBe("Spend");
    expect(ws.getPage(pageId).content.tables[table().id].name).toBe("Spend");
  });

  it("makes a named section from a range and then shows its count", () => {
    const { ws, pageId, editor, tableId } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    click(handle(editor));
    click(document.querySelector("[data-action=section-make]"));
    document.querySelector(".name-prompt-input").value = "Top";
    document.querySelector("[data-action=name-confirm]").click();
    const section = Object.values(ws.getPage(pageId).content.sections).find((s) => s.name === "Top");
    expect(section.locator).toEqual({ tableId, range: { start: { col: 0, row: 0 }, end: { col: 1, row: 1 } } });

    // A second page reads it; the handle on the same range now carries a badge.
    ws.dispatch("createPage", { type: "document", title: "Doc" });
    const doc = ws.getChildren(null)[1];
    ws.dispatch("insertReference", { pageId: doc, kind: "embed", sectionId: section.id, display: {} });
    editor.refresh?.();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    expect(handle(editor).querySelector(".handle-badge")?.textContent).toBe("1");
  });

  it("drags the table and commits one moveTable on release", () => {
    const { ws, editor, table } = setup();
    const before = ws.getPage(ws.getChildren(null)[0]).content;
    expect(before.tables[table().id].position).toEqual({ x: 40, y: 30 });
    handle(editor).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 60, clientY: 30 }));
    const wrapper = editor.element.querySelector(".sheet-table");
    expect(wrapper.style.left).toBe("90px");
    expect(wrapper.style.top).toBe("50px");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(table().position).toEqual({ x: 90, y: 50 });
    ws.undo();
    expect(table().position).toEqual({ x: 40, y: 30 });
  });

  it("does not move the table on a bare click", () => {
    const { editor, table } = setup();
    handle(editor).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(table().position).toEqual({ x: 40, y: 30 });
  });

  it("keeps a range handle click-only", () => {
    const { editor, table, tableId } = setup();
    editor.selectRange(tableId, { col: 0, row: 0 }, { col: 1, row: 1 });
    handle(editor).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 90, clientY: 90 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(table().position).toEqual({ x: 40, y: 30 });
  });
});

describe("formula errors explain themselves", () => {
  it("puts the explanation on the cell and under the formula bar", () => {
    const { ws, pageId, tableId, editor } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { formula: "=Nowhere!A1" } });
    const cell = editor.element.querySelector('[data-key="0,0"]');
    expect(cell.classList.contains("is-error")).toBe(true);
    expect(cell.title).not.toBe("");

    const message = editor.element.querySelector(".formula-message");
    expect(message.classList.contains("is-visible")).toBe(false);
    editor.selectCell(tableId, 0, 0);
    expect(message.classList.contains("is-visible")).toBe(true);
    expect(message.textContent).toBe(cell.title);
    editor.selectCell(tableId, 1, 1);
    expect(message.classList.contains("is-visible")).toBe(false);
  });

  it("leaves healthy formulas without a message", () => {
    const { ws, pageId, tableId, editor } = setup();
    ws.dispatch("setCell", { pageId, tableId, col: 0, row: 0, cell: { value: 2 } });
    ws.dispatch("setCell", { pageId, tableId, col: 1, row: 0, cell: { formula: "=A1*3" } });
    const cell = editor.element.querySelector('[data-key="1,0"]');
    expect(cell.classList.contains("is-error")).toBe(false);
    expect(cell.title).toBe("");
    editor.selectCell(tableId, 1, 0);
    expect(editor.element.querySelector(".formula-message").classList.contains("is-visible")).toBe(false);
  });
});
