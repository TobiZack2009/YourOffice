import { afterEach, describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createDocumentEditor } from "../src/app/block-editor.js";
import { clearNotice } from "../src/app/notice.js";
import { REF_CHAR, validateDocumentContent } from "../src/document/model.js";
import { insertRunAt, plainTextOf } from "../src/document/runs.js";
import { renderRuns } from "../src/document/render.js";
import { mergeRuns, modelLength, parseInlineRuns, runsEqual, runsToPlainText } from "../src/app/inline.js";

const ref = { id: "ref_1", kind: "expression", expression: "1+1", display: {} };

describe("inline reference runs", () => {
  it("insertRunAt splits text and never splits a reference", () => {
    const runs = [{ text: "hello", marks: { bold: true } }];
    const out = insertRunAt(runs, 2, { text: REF_CHAR, ref });
    expect(out).toEqual([
      { text: "he", marks: { bold: true } },
      { text: REF_CHAR, ref },
      { text: "llo", marks: { bold: true } }
    ]);
    expect(insertRunAt(out, 1, { text: REF_CHAR, ref: { ...ref, id: "ref_2" } }).map((r) => r.text)).toEqual(["h", REF_CHAR, "e", REF_CHAR, "llo"]);
    expect(insertRunAt(runs, 99, { text: REF_CHAR, ref }).at(-1).ref).toBe(ref);
    expect(plainTextOf(out)).toBe("hello");
  });

  it("round-trips through the DOM", () => {
    const runs = [{ text: "a " }, { text: REF_CHAR, ref }, { text: " b", marks: { italic: true } }];
    const host = document.createElement("p");
    host.append(renderRuns(runs));
    const chip = host.querySelector(".inline-ref");
    expect(chip.getAttribute("contenteditable")).toBe("false");
    expect(chip.getAttribute("data-ref-id")).toBe("ref_1");
    expect(runsEqual(parseInlineRuns(host), runs)).toBe(true);
    // The chip counts as one character, whatever it draws.
    chip.textContent = "a long drawn result";
    expect(modelLength(host)).toBe(2 + 1 + 2);
    expect(runsToPlainText(runs)).toBe("a  b");
  });

  it("never merges references with neighbours", () => {
    const merged = mergeRuns([{ text: "a" }, { text: REF_CHAR, ref }, { text: REF_CHAR, ref }, { text: "b" }]);
    expect(merged).toHaveLength(4);
  });

  it("validates reference runs", () => {
    const base = (runs) => ({ blockOrder: ["p"], blocks: { p: { id: "p", type: "paragraph", runs } } });
    expect(validateDocumentContent(base([{ text: REF_CHAR, ref }]))).toEqual([]);
    expect(validateDocumentContent(base([{ text: "x", ref }])).length).toBeGreaterThan(0);
    expect(validateDocumentContent(base([{ text: REF_CHAR, ref: { ...ref, id: "" } }])).length).toBeGreaterThan(0);
    expect(validateDocumentContent(base([{ text: REF_CHAR, ref, marks: { bold: true } }])).length).toBeGreaterThan(0);
  });
});

function setup() {
  const ws = createWorkspace({ title: "W" });
  const page = (type, title) => {
    ws.dispatch("createPage", { type, title });
    const list = ws.getChildren(null);
    return list[list.length - 1];
  };
  const notes = page("document", "Notes");
  const memo = page("document", "Memo");
  const data = page("sheet", "Data");
  ws.dispatch("insertBlock", { pageId: notes, newBlockId: "b1", block: { type: "paragraph", runs: [{ text: "Only this" }] } });
  ws.dispatch("insertBlock", { pageId: notes, newBlockId: "b2", block: { type: "paragraph", runs: [{ text: "first" }] } });
  ws.dispatch("insertBlock", { pageId: notes, newBlockId: "b3", block: { type: "paragraph", runs: [{ text: "second" }] } });
  ws.dispatch("createSection", { pageId: notes, name: "One", locator: { startBlockId: "b1", endBlockId: "b1" }, sectionId: "sec_one" });
  ws.dispatch("createSection", { pageId: notes, name: "Pair", locator: { startBlockId: "b2", endBlockId: "b3" }, sectionId: "sec_pair" });
  ws.dispatch("insertBlock", { pageId: memo, newBlockId: "m1", block: { type: "paragraph", runs: [{ text: "Total: done" }] } });
  ws.dispatch("createTable", { pageId: data, name: "Costs" });
  const costs = ws.getPage(data).content.tableOrder[0];
  ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 5 } });
  const mount = (pageId) => {
    const editor = createDocumentEditor(ws, pageId);
    document.body.append(editor.element);
    return editor;
  };
  const caret = (editor, blockId, offset) => {
    const el = editor.element.querySelector(`[data-block-id="${blockId}"][contenteditable="true"]`);
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild, offset);
    range.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  return { ws, notes, memo, data, costs, mount, caret };
}

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

describe("inserting inline references", () => {
  it("places an expression at the caret and draws its value in the text", () => {
    const { ws, memo, mount, caret } = setup();
    const editor = mount(memo);
    caret(editor, "m1", 7);
    editor.insertExpression(document.body);
    typeExpression("Data!Costs!A1");
    const runs = ws.getPage(memo).content.blocks.m1.runs;
    expect(runs.map((r) => r.text)).toEqual(["Total: ", REF_CHAR, "done"]);
    expect(runs[1].ref.expression).toBe("Data!Costs!A1");
    expect(ws.getPage(memo).content.blockOrder).toEqual(["m1"]);
    const chip = editor.element.querySelector(".inline-ref");
    expect(chip.getAttribute("data-fit")).toBe("inline");
    expect(chip.textContent).toContain("5");
    expect(editor.element.querySelectorAll("[data-block-id]").length).toBe(1);
  });

  it("flows a single-paragraph embed and breaks a multi-block embed", () => {
    const { ws, memo, mount, caret } = setup();
    const editor = mount(memo);
    const embed = (sectionId) => {
      caret(editor, "m1", 3);
      editor.insertEmbed(document.body);
      document.querySelector(`.picker-item[data-key="section:${sectionId}"], .picker-item[data-kind="section"][data-section-id="${sectionId}"]`)?.click();
    };
    embed("sec_one");
    let chips = editor.element.querySelectorAll(".inline-ref");
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute("data-fit")).toBe("inline");
    expect(chips[0].textContent).toContain("Only this");

    // Retarget the same reference to the two-block section: it now breaks the line.
    const id = ws.getPage(memo).content.blocks.m1.runs.find((r) => r.ref).ref.id;
    ws.dispatch("updateReference", { pageId: memo, instanceId: id, patch: { sectionId: "sec_pair" } });
    chips = editor.element.querySelectorAll(".inline-ref");
    expect(chips[0].getAttribute("data-fit")).toBe("break");
    expect(ws.getPage(memo).content.blockOrder).toEqual(["m1"]);
  });

  it("uses a block-level reference when the text is empty", () => {
    const { ws, memo, mount } = setup();
    ws.dispatch("insertBlock", { pageId: memo, newBlockId: "m2", block: { type: "paragraph", runs: [] } });
    const editor = mount(memo);
    const el = editor.element.querySelector('[data-block-id="m2"][contenteditable="true"]');
    el.focus();
    editor.insertExpression(document.body);
    typeExpression("1 + 1");
    const types = ws.getPage(memo).content.blockOrder.map((id) => ws.getPage(memo).content.blocks[id].type);
    expect(types).toContain("sectionRef");
  });

  it("refreshes an inline expression when its source changes", () => {
    const { ws, memo, data, costs, mount, caret } = setup();
    const editor = mount(memo);
    caret(editor, "m1", 7);
    editor.insertExpression(document.body);
    typeExpression("Data!Costs!A1");
    ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 9 } });
    expect(editor.element.querySelector(".inline-ref").textContent).toContain("9");
  });

  it("removes an inline reference through its handle menu", () => {
    const { ws, memo, mount, caret } = setup();
    const editor = mount(memo);
    caret(editor, "m1", 7);
    editor.insertExpression(document.body);
    typeExpression("1 + 1");
    editor.element.querySelector(".inline-ref .reference-handle").click();
    const remove = document.querySelector("[data-action=reference-remove]");
    expect(remove).not.toBeNull();
    remove.click();
    expect(ws.getPage(memo).content.blocks.m1.runs.some((r) => r.ref)).toBe(false);
  });

  it("rejects an inline reference that would create a cycle", () => {
    const { ws, notes } = setup();
    expect(() =>
      ws.dispatch("insertReference", {
        pageId: notes,
        kind: "embed",
        sectionId: "sec_pair",
        display: {},
        inline: { blockId: "b2", offset: 2 }
      })
    ).toThrow();
    expect(ws.getPage(notes).content.blocks.b2.runs.some((r) => r.ref)).toBe(false);
  });
});
