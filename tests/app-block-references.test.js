import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { registerSheetCommands } from "../src/sheet/commands.js";
import { registerPresentationCommands } from "../src/presentation/commands.js";
import { createDocumentEditor } from "../src/app/block-editor.js";
import { clearNotice } from "../src/app/notice.js";

/**
 * Notes (document)  one, two, three; section Intro = one..two
 * Other (document)  empty, with an editor mounted
 * Data (sheet)      table Costs, A1 = 5
 */
function setup() {
  const ws = Workspace.create({ title: "W" });
  registerDocumentCommands(ws);
  registerSheetCommands(ws);
  registerPresentationCommands(ws);
  const page = (type, title) => {
    ws.dispatch("createPage", { type, title });
    const list = ws.getChildren(null);
    return list[list.length - 1];
  };
  const notes = page("document", "Notes");
  const other = page("document", "Other");
  const data = page("sheet", "Data");
  for (const [id, text] of [["b1", "one"], ["b2", "two"], ["b3", "three"]]) {
    ws.dispatch("insertBlock", { pageId: notes, newBlockId: id, block: { type: "paragraph", runs: [{ text }] } });
  }
  ws.dispatch("createTable", { pageId: data, name: "Costs" });
  const costs = ws.getPage(data).content.tableOrder[0];
  ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 5 } });
  ws.dispatch("createSection", { pageId: notes, name: "Intro", locator: { startBlockId: "b1", endBlockId: "b2" }, sectionId: "sec_intro" });
  const mount = (pageId) => {
    const editor = createDocumentEditor(ws, pageId);
    document.body.append(editor.element);
    return editor;
  };
  return { ws, notes, other, data, costs, mount };
}

/** Give block elements a vertical layout so drops can be computed (jsdom has none). */
function layOut(editor) {
  const els = [...editor.element.children].filter((el) => el.hasAttribute("data-block-id"));
  els.forEach((el, index) => {
    el.getBoundingClientRect = () => ({ top: index * 40, bottom: index * 40 + 30, left: 0, right: 100, height: 30, width: 100 });
  });
  return els;
}

function click(el) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

afterEach(() => {
  clearNotice();
  document.body.replaceChildren();
});

describe("block handle", () => {
  it("appears beside the hovered top-level block", () => {
    const { notes, mount } = setup();
    const editor = mount(notes);
    const handle = editor.element.querySelector("[data-role=block-handle]");
    expect(handle).not.toBeNull();
    expect(handle.classList.contains("is-visible")).toBe(false);
    editor.element.querySelector('[data-block-id="b2"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    expect(handle.classList.contains("is-visible")).toBe(true);
  });

  it("makes a section from one block through its menu", () => {
    const { ws, notes, mount } = setup();
    const editor = mount(notes);
    editor.element.querySelector('[data-block-id="b3"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    click(editor.element.querySelector("[data-role=block-handle]"));
    click(document.querySelector("[data-action=section-make]"));
    document.querySelector(".name-prompt-input").value = "Closing";
    document.querySelector("[data-action=name-confirm]").click();
    const sections = Object.values(ws.getPage(notes).content.sections);
    expect(sections.find((s) => s.name === "Closing")?.locator).toEqual({ startBlockId: "b3", endBlockId: "b3" });
  });

  it("shows the section menu for a block inside a named section", () => {
    const { notes, mount } = setup();
    const editor = mount(notes);
    editor.element.querySelector('[data-block-id="b1"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    click(editor.element.querySelector("[data-role=block-handle]"));
    expect(document.querySelector("[data-action=section-menu]")?.textContent).toContain("Intro");
  });

  it("moves a block by dragging the handle and keeps it in one undo step", () => {
    const { ws, notes, mount } = setup();
    const editor = mount(notes);
    layOut(editor);
    const handle = editor.element.querySelector("[data-role=block-handle]");
    editor.element.querySelector('[data-block-id="b1"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 100 }));
    expect(editor.element.querySelector(".block-drop-indicator")).not.toBeNull();
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 100 }));
    expect(ws.getPage(notes).content.blockOrder).toEqual(["b2", "b3", "b1"]);
    expect(editor.element.querySelector(".block-drop-indicator")).toBeNull();
    // The section follows its blocks; undoing restores the order in one step.
    ws.undo();
    expect(ws.getPage(notes).content.blockOrder).toEqual(["b1", "b2", "b3"]);
  });

  it("treats a short press as a click, not a drag", () => {
    const { ws, notes, mount } = setup();
    const editor = mount(notes);
    layOut(editor);
    const handle = editor.element.querySelector("[data-role=block-handle]");
    editor.element.querySelector('[data-block-id="b1"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 10 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 11 }));
    expect(ws.getPage(notes).content.blockOrder).toEqual(["b1", "b2", "b3"]);
    click(handle);
    expect(document.querySelector("[data-action=section-make]")).not.toBeNull();
  });
});

describe("embeds in a document", () => {
  it("draws the source blocks inside the host and keeps them editable", () => {
    const { ws, notes, other, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    const editor = mount(other);
    const frame = editor.element.querySelector(".reference.is-embed");
    expect(frame.getAttribute("data-state")).toBe("live");
    const editable = [...frame.querySelectorAll('[contenteditable="true"]')];
    expect(editable.map((el) => el.textContent)).toEqual(["one", "two"]);

    editable[0].textContent = "uno";
    editable[0].dispatchEvent(new Event("input", { bubbles: true }));
    expect(ws.getPage(notes).content.blocks.b1.runs[0].text).toBe("uno");
  });

  it("updates every copy of a section while one of them is typed in", () => {
    const { ws, notes, other, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    const editor = mount(other);
    const copies = [...editor.element.querySelectorAll('.reference [contenteditable="true"][data-block-id="b2"]')];
    expect(copies).toHaveLength(2);
    copies[0].focus();
    copies[0].textContent = "deux";
    copies[0].dispatchEvent(new Event("input", { bubbles: true }));
    expect(ws.getPage(notes).content.blocks.b2.runs[0].text).toBe("deux");
    expect(copies[1].textContent).toBe("deux");
  });

  it("redraws embeds after an undo", () => {
    const { ws, other, mount } = setup();
    const editor = mount(other);
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    expect(editor.element.querySelector(".reference")).not.toBeNull();
    ws.undo();
    expect(editor.element.querySelector(".reference")).toBeNull();
  });

  it("keeps showing the content after the source is deleted", () => {
    const { ws, notes, other, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    const editor = mount(other);
    ws.dispatch("deletePage", { pageId: notes });
    const frame = editor.element.querySelector(".reference.is-embed");
    expect(frame.getAttribute("data-state")).toBe("removed");
    expect([...frame.querySelectorAll('[contenteditable="true"]')].map((el) => el.textContent)).toEqual(["one", "two"]);
  });

  it("opens the reference menu from the frame handle and removes the reference", () => {
    const { ws, other, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_intro", display: {} });
    const editor = mount(other);
    click(editor.element.querySelector("[data-role=reference-handle]"));
    expect(document.querySelector("[data-action=reference-go]")).not.toBeNull();
    click(document.querySelector("[data-action=reference-remove]"));
    expect(ws.getPage(other).content.blockOrder).toHaveLength(0);
    expect(editor.element.querySelector(".reference")).toBeNull();
  });

  it("draws a table embed as a static grid", () => {
    const { ws, other, data, costs, mount } = setup();
    ws.dispatch("createSection", { pageId: data, locator: { tableId: costs }, implicit: true, sectionId: "sec_t" });
    ws.dispatch("insertReference", { pageId: other, kind: "embed", sectionId: "sec_t", display: {} });
    const editor = mount(other);
    const frame = editor.element.querySelector(".reference.is-embed");
    expect(frame.getAttribute("data-section-kind")).toBe("table");
    expect(frame.querySelector(".reference-table").textContent).toContain("5");
  });
});

describe("expressions in a document", () => {
  it("shows the computed result and recomputes when the data changes", () => {
    const { ws, other, data, costs, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1 * 2", display: {} });
    const editor = mount(other);
    const frame = editor.element.querySelector(".reference.is-expression");
    expect(frame.textContent).toContain("10");
    ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 8 } });
    expect(editor.element.querySelector(".reference.is-expression").textContent).toContain("16");
  });

  it("shows IF as a show/hide of a read-only embed", () => {
    const { ws, other, data, costs, mount } = setup();
    ws.dispatch("insertReference", {
      pageId: other,
      kind: "expression",
      expression: 'IF(Data!Costs!A1 > 6, Notes!Intro, "")',
      display: {}
    });
    const editor = mount(other);
    const frame = () => editor.element.querySelector(".reference.is-expression");
    expect(frame().querySelector(".reference-blocks")).toBeNull();
    ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 9 } });
    expect(frame().querySelector(".reference-blocks")).not.toBeNull();
    expect(frame().querySelector('[contenteditable="true"]')).toBeNull();
  });

  it("renders a later error as a chip with its explanation", () => {
    const { ws, other, data, costs, mount } = setup();
    ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 1, cell: { value: 5 } });
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1 / Data!Costs!A2", display: {} });
    const editor = mount(other);
    expect(editor.element.querySelector(".reference.is-expression .reference-chip.is-error")).toBeNull();
    ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 1, cell: { value: 0 } });
    const chip = editor.element.querySelector(".reference.is-expression .reference-chip.is-error");
    expect(chip).not.toBeNull();
    expect(chip.getAttribute("data-explanation")).not.toBe("");
  });

  it("keeps an expression working when its table is deleted (the table is kept)", () => {
    const { ws, other, data, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1", display: {} });
    const editor = mount(other);
    ws.dispatch("deleteTable", { pageId: data, tableId: ws.getPage(data).content.tableOrder[0] });
    expect(editor.element.querySelector(".reference.is-expression").textContent).toContain("5");
  });

  it("edits the expression on double-click and refuses a bad one", () => {
    const { ws, other, mount } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1", display: {} });
    const editor = mount(other);
    editor.element.querySelector(".reference.is-expression").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = document.querySelector(".expression-input");
    expect(input.value).toBe("Data!Costs!A1");
    input.value = "Nope!A1";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector("[data-action=expression-apply]").disabled).toBe(true);
    input.value = "Data!Costs!A1 + 1";
    input.dispatchEvent(new Event("input"));
    document.querySelector("[data-action=expression-apply]").click();
    const block = Object.values(ws.getPage(other).content.blocks)[0];
    expect(block.expression).toBe("Data!Costs!A1 + 1");
  });
});

describe("inserting references", () => {
  it("embeds a picked section after the active block", () => {
    const { ws, other, mount } = setup();
    const editor = mount(other);
    editor.insertEmbed(document.body);
    click(document.querySelector('.picker-item[data-kind="section"]'));
    const blocks = Object.values(ws.getPage(other).content.blocks).filter((b) => b.type === "sectionRef");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sectionId).toBe("sec_intro");
    expect(editor.element.querySelector(".reference.is-embed")).not.toBeNull();
  });

  it("creates the section and the embed as one undo step when naming unsectioned text", () => {
    const { ws, notes, other, mount } = setup();
    const editor = mount(other);
    editor.insertEmbed(document.body);
    click(document.querySelector('.picker-item[data-key="block:b3"]'));
    document.querySelector(".name-prompt-input").value = "Closing";
    document.querySelector("[data-action=picker-name-confirm]").click();
    expect(Object.values(ws.getPage(notes).content.sections).some((s) => s.name === "Closing")).toBe(true);
    ws.undo();
    expect(Object.values(ws.getPage(notes).content.sections).some((s) => s.name === "Closing")).toBe(false);
    expect(ws.getPage(other).content?.blockOrder ?? []).toHaveLength(0);
  });

  it("inserts a valid expression and blocks an invalid one", () => {
    const { ws, other, mount } = setup();
    const editor = mount(other);
    editor.insertExpression(document.body);
    const input = document.querySelector(".expression-input");
    input.value = "Missing!A1";
    input.dispatchEvent(new Event("input"));
    expect(document.querySelector("[data-action=expression-apply]").disabled).toBe(true);
    input.value = "Data!Costs!A1";
    input.dispatchEvent(new Event("input"));
    document.querySelector("[data-action=expression-apply]").click();
    const refs = Object.values(ws.getPage(other).content.blocks).filter((b) => b.type === "sectionRef");
    expect(refs.map((b) => b.expression)).toEqual(["Data!Costs!A1"]);
  });

  it("offers Insert embed, Insert expression and Make section in the context menu", () => {
    const { notes, mount } = setup();
    const editor = mount(notes);
    editor.openContextMenu({ x: 5, y: 5 });
    expect(document.querySelector("[data-action=ctx-insert-embed]")).not.toBeNull();
    expect(document.querySelector("[data-action=ctx-insert-expression]")).not.toBeNull();
    expect(document.querySelector("[data-action=ctx-make-section]")).not.toBeNull();
  });
});
