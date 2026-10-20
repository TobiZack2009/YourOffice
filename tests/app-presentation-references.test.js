import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createPresentationEditor } from "../src/app/presentation-editor.js";
import { createObject } from "../src/presentation/model.js";
import { clearNotice } from "../src/app/notice.js";
import { REF_CHAR } from "../src/document/model.js";
import { getTabs } from "../src/app/ribbon-tabs.js";

function setup() {
  const ws = createWorkspace({ title: "W" });
  const page = (type, title) => {
    ws.dispatch("createPage", { type, title });
    const list = ws.getChildren(null);
    return list[list.length - 1];
  };
  const notes = page("document", "Notes");
  const other = page("document", "Other");
  const deck = page("presentation", "Deck");
  ws.dispatch("insertBlock", { pageId: notes, newBlockId: "b1", block: { type: "paragraph", runs: [{ text: "Only this" }] } });
  ws.dispatch("insertBlock", { pageId: other, newBlockId: "o1", block: { type: "paragraph", runs: [{ text: "Different" }] } });
  ws.dispatch("createSection", { pageId: notes, name: "One", locator: { startBlockId: "b1", endBlockId: "b1" }, sectionId: "sec_one" });
  ws.dispatch("createSection", { pageId: other, name: "Two", locator: { startBlockId: "o1", endBlockId: "o1" }, sectionId: "sec_two" });
  ws.dispatch("createSlide", { pageId: deck, layout: "blank" });
  const slideId = ws.getPage(deck).content.slideOrder[0];
  const editor = createPresentationEditor(ws, deck, {});
  document.body.append(editor.element);
  const slide = () => ws.getPage(deck).content.slides[slideId];
  return { ws, notes, deck, slideId, editor, slide };
}

const pick = (sectionId) =>
  document.querySelector(`.picker-item[data-key="section:${sectionId}"], .picker-item[data-kind="section"][data-section-id="${sectionId}"]`)?.click();

function typeExpression(text) {
  const input = document.querySelector(".expression-input");
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event("input"));
  document.querySelector("[data-action=expression-apply]").click();
}

afterEach(() => {
  clearNotice();
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("reference objects on slides", () => {
  it("embeds a section as a standalone object and draws it", () => {
    const { editor, slide } = setup();
    editor.insertEmbed(document.body);
    pick("sec_one");
    const objects = Object.values(slide().objects);
    expect(objects).toHaveLength(1);
    expect(objects[0].type).toBe("reference");
    expect(objects[0].sectionId).toBe("sec_one");
    expect(editor.getSelection()).toEqual([objects[0].id]);
    const el = editor.element.querySelector(`.stage .slide-object[data-object-id="${objects[0].id}"]`);
    expect(el.textContent).toContain("Only this");
    expect(editor.element.querySelector("[data-role=reference-handle]")).not.toBeNull();
  });

  it("shows an expression result and refreshes it when the source changes", () => {
    const { ws, notes, editor, slide } = setup();
    editor.insertExpression(document.body);
    typeExpression("Notes!One");
    const [object] = Object.values(slide().objects);
    expect(object.kind).toBe("expression");
    const el = () => editor.element.querySelector(`.stage .slide-object[data-object-id="${object.id}"]`);
    expect(el().textContent).toContain("Only this");
    ws.dispatch("setBlockRuns", { pageId: notes, blockId: "b1", runs: [{ text: "Changed" }] });
    expect(el().textContent).toContain("Changed");
  });

  it("removes a reference object through its handle menu", () => {
    const { editor, slide } = setup();
    editor.insertEmbed(document.body);
    pick("sec_one");
    editor.element.querySelector("[data-role=reference-handle]").click();
    const remove = document.querySelector("[data-action=reference-remove]");
    expect(remove).not.toBeNull();
    remove.click();
    expect(Object.keys(slide().objects)).toHaveLength(0);
  });

  it("swaps the embedded source from the handle menu", () => {
    const { editor, slide } = setup();
    editor.insertEmbed(document.body);
    pick("sec_one");
    editor.element.querySelector("[data-role=reference-handle]").click();
    document.querySelector("[data-action=reference-replace]").click();
    pick("sec_two");
    const [object] = Object.values(slide().objects);
    expect(object.sectionId).toBe("sec_two");
    expect(editor.element.querySelector(".stage .slide-reference").textContent).toContain("Different");
  });

  it("edits an expression object with a double click", () => {
    const { editor, slide } = setup();
    editor.insertExpression(document.body);
    typeExpression("1 + 1");
    const [object] = Object.values(slide().objects);
    const el = editor.element.querySelector(`.stage .slide-object[data-object-id="${object.id}"]`);
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    typeExpression("2 + 3");
    expect(Object.values(slide().objects)[0].expression).toBe("2 + 3");
  });
});

describe("inline references in slide text", () => {
  it("puts a reference at the caret of the text being edited and marks the box to grow", () => {
    const { ws, deck, slideId, editor, slide } = setup();
    const object = createObject("text", { x: 100, y: 100, width: 300, height: 80 });
    ws.dispatch("insertObject", { pageId: deck, slideId, object });
    ws.dispatch("setObjectRuns", { pageId: deck, slideId, objectId: object.id, runs: [{ text: "Total: done" }] });
    editor.selectObjects([object.id]);
    editor.startEdit(object.id);
    const host = editor.element.querySelector(".slide-text[contenteditable=true]");
    const range = document.createRange();
    range.setStart(host.firstChild, 7);
    range.collapse(true);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    editor.insertExpression(document.body);
    typeExpression("1 + 1");

    const stored = slide().objects[object.id];
    expect(stored.text.runs.map((r) => r.text)).toEqual(["Total: ", REF_CHAR, "done"]);
    expect(stored.text.runs[1].ref.expression).toBe("1 + 1");
    expect(stored.autoHeight).toBe(true);
    const chip = editor.element.querySelector(`.slide-object[data-object-id="${object.id}"] .inline-ref`);
    expect(chip.textContent).toContain("2");
  });

  it("falls back to a standalone object when the text is empty", () => {
    const { ws, deck, slideId, editor, slide } = setup();
    const object = createObject("text", { x: 100, y: 100, width: 300, height: 80 });
    ws.dispatch("insertObject", { pageId: deck, slideId, object });
    editor.selectObjects([object.id]);
    editor.startEdit(object.id);
    editor.insertExpression(document.body);
    typeExpression("1 + 1");
    expect(Object.values(slide().objects).some((o) => o.type === "reference")).toBe(true);
  });

  it("allows autoHeight only on text objects", () => {
    const { ws, deck, slideId, slide } = setup();
    const shape = createObject("shape", { x: 0, y: 0, width: 100, height: 100 });
    ws.dispatch("insertObject", { pageId: deck, slideId, object: shape });
    expect(() => ws.dispatch("updateObject", { pageId: deck, slideId, objectId: shape.id, patch: { autoHeight: true } })).toThrow();
    expect(slide().objects[shape.id].autoHeight).toBeUndefined();
  });
});

describe("ribbon", () => {
  it("offers Embed and Expression in the presentation Insert tab", () => {
    const insert = getTabs("presentation").find((tab) => tab.id === "insert");
    const group = insert.groups.find((g) => g.id === "references");
    expect(group.controls.map((c) => c.id)).toEqual(["reference-embed", "reference-expression"]);
  });
});
