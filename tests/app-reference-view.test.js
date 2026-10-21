import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createDocumentEditor } from "../src/app/block-editor.js";
import { clearNotice } from "../src/app/notice.js";

/**
 * Notes (document)  one, two; section sec_intro = one..two
 * Other (document)  the host: references go here
 * Data (sheet)      table Costs, A1 = 5; section sec_t over the table
 */
function setup() {
  const ws = createWorkspace({ title: "W" });
  const page = (type, title) => {
    ws.dispatch("createPage", { type, title });
    const list = ws.getChildren(null);
    return list[list.length - 1];
  };
  const notes = page("document", "Notes");
  const other = page("document", "Other");
  const data = page("sheet", "Data");
  for (const [id, text] of [["b1", "one"], ["b2", "two"]]) {
    ws.dispatch("insertBlock", { pageId: notes, newBlockId: id, block: { type: "paragraph", runs: [{ text }] } });
  }
  ws.dispatch("createTable", { pageId: data, name: "Costs" });
  const costs = ws.getPage(data).content.tableOrder[0];
  ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 5 } });
  ws.dispatch("createSection", { pageId: notes, name: "Intro", locator: { startBlockId: "b1", endBlockId: "b2" }, sectionId: "sec_intro" });
  ws.dispatch("createSection", { pageId: data, locator: { tableId: costs }, implicit: true, sectionId: "sec_t" });
  const mount = (pageId) => {
    const editor = createDocumentEditor(ws, pageId);
    document.body.append(editor.element);
    return editor;
  };
  /** A change on the host page that redraws it. */
  const touchHost = (n) =>
    ws.dispatch("insertBlock", { pageId: other, newBlockId: `h${n}`, block: { type: "paragraph", runs: [{ text: "x" }] } });
  return { ws, notes, other, data, costs, mount, touchHost };
}

afterEach(() => {
  clearNotice();
  document.body.replaceChildren();
});

describe("reference frames are keyed", () => {
  it("keeps a table embed and its grid when only the host changed", () => {
    const { ws, other, mount, touchHost } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_t", display: {} });
    const editor = mount(other);
    const frame = editor.element.querySelector(".reference.is-embed");
    const grid = frame.querySelector(".reference-table");
    touchHost(1);
    expect(editor.element.querySelector(".reference.is-embed")).toBe(frame);
    expect(frame.querySelector(".reference-table")).toBe(grid);
  });

  it("keeps the frame but redraws the grid when the table changed", () => {
    const { ws, other, data, costs, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_t", display: {} });
    const editor = mount(other);
    const frame = editor.element.querySelector(".reference.is-embed");
    const grid = frame.querySelector(".reference-table");
    ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 8 } });
    expect(editor.element.querySelector(".reference.is-embed")).toBe(frame);
    expect(frame.querySelector(".reference-table")).not.toBe(grid);
    expect(frame.querySelector(".reference-table").textContent).toContain("8");
  });

  it("keeps a text embed, its nested editor and its frame", () => {
    const { ws, other, mount, touchHost } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    const editor = mount(other);
    const frame = editor.element.querySelector(".reference.is-embed");
    const nested = frame.querySelector(".reference-body > *");
    touchHost(1);
    touchHost(2);
    expect(editor.element.querySelector(".reference.is-embed")).toBe(frame);
    expect(frame.querySelector(".reference-body > *")).toBe(nested);
  });

  it("keeps an expression frame and value until the value changes", () => {
    const { ws, other, data, costs, mount, touchHost } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1 * 2", display: {} });
    const editor = mount(other);
    const frame = editor.element.querySelector(".reference.is-expression");
    const chip = frame.querySelector(".reference-chip");
    touchHost(1);
    expect(editor.element.querySelector(".reference.is-expression")).toBe(frame);
    expect(frame.querySelector(".reference-chip")).toBe(chip);
    ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 8 } });
    expect(editor.element.querySelector(".reference.is-expression")).toBe(frame);
    expect(frame.querySelector(".reference-chip")).not.toBe(chip);
    expect(frame.textContent).toContain("16");
  });

  it("keeps an inline reference chip while its paragraph is redrawn around it", () => {
    const { ws, other, mount, touchHost } = setup();
    ws.dispatch("insertBlock", {
      pageId: other,
      newBlockId: "p1",
      block: {
        type: "paragraph",
        runs: [{ text: "￼", ref: { id: "ref_1", kind: "expression", expression: "Data!Costs!A1", display: {} } }]
      }
    });
    const editor = mount(other);
    const chip = editor.element.querySelector(".inline-ref");
    expect(chip).not.toBeNull();
    touchHost(1);
    expect(editor.element.querySelector(".inline-ref")).toBe(chip);
  });

  it("drops the frame of a removed reference and gives a new one a fresh element", () => {
    const { ws, other, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1", display: {} });
    const editor = mount(other);
    const frame = editor.element.querySelector(".reference.is-expression");
    const id = frame.getAttribute("data-reference-id");
    ws.dispatch("deleteBlock", { pageId: other, blockId: id });
    expect(editor.element.querySelector(".reference")).toBeNull();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1", display: {} });
    expect(editor.element.querySelector(".reference.is-expression")).not.toBe(frame);
  });

  it("follows a section being removed in place", () => {
    const { ws, other, data, costs, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_t", display: {} });
    const editor = mount(other);
    const frame = editor.element.querySelector(".reference.is-embed");
    expect(frame.getAttribute("data-state")).toBe("live");
    ws.dispatch("deleteTable", { pageId: data, tableId: costs });
    expect(editor.element.querySelector(".reference.is-embed")).toBe(frame);
    expect(frame.getAttribute("data-state")).not.toBe("live");
    expect(frame.classList.contains("is-live")).toBe(false);
  });
});
