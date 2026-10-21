import { describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createDocumentEditor } from "../src/app/block-editor.js";
import { FRAGMENT_MIME } from "../src/app/block-fragment.js";

const para = (text) => ({ type: "paragraph", runs: [{ text }] });

function setup(blocks) {
  const ws = createWorkspace({ title: "Doc" });
  ws.dispatch("createPage", { type: "document", title: "Doc" });
  const pageId = ws.getChildren(null)[0];
  for (const block of blocks) ws.dispatch("insertBlock", { pageId, block });
  const editor = createDocumentEditor(ws, pageId);
  document.body.append(editor.element);
  const order = () => ws.getPage(pageId).content.blockOrder;
  const blocks_ = () => ws.getPage(pageId).content.blocks;
  const texts = () => order().map((id) => (blocks_()[id].runs ?? []).map((r) => r.text).join(""));
  /** Select from a unit/offset to another. */
  const select = (anchor, focus, anchorOffset, focusOffset) =>
    editor.restoreSelection({ type: "units", anchor, focus, anchorOffset, focusOffset }, { focus: true });
  return { ws, pageId, editor, order, texts, block: (id) => blocks_()[id], select };
}

function clipboardEvent(type, target, store = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  event.clipboardData = {
    setData: (mime, value) => {
      store[mime] = value;
    },
    getData: (mime) => store[mime] ?? ""
  };
  target.dispatchEvent(event);
  return { event, store };
}

describe("document clipboard", () => {
  it("copies whole blocks as text, html and the private format", () => {
    const { editor, order, select } = setup([para("alpha"), para("beta"), para("gamma")]);
    select(order()[0], order()[1]);
    const { event, store } = clipboardEvent("copy", editor.element.querySelector("[data-block-id]"));
    expect(event.defaultPrevented).toBe(true);
    expect(store["text/plain"]).toBe("alpha\n\nbeta");
    expect(store["text/html"]).toContain("alpha");
    expect(store["text/html"]).not.toContain("data-block-id");
    expect(JSON.parse(store[FRAGMENT_MIME]).blocks).toHaveLength(2);
    editor.destroy();
  });

  it("copies only the selected part of the two end blocks", () => {
    const { editor, order, texts, select } = setup([para("alpha"), para("beta"), para("gamma")]);
    select(order()[0], order()[2], 2, 3);
    const { store } = clipboardEvent("copy", editor.element.querySelector("[data-block-id]"));
    expect(store["text/plain"]).toBe("pha\n\nbeta\n\ngam");
    expect(texts()).toEqual(["alpha", "beta", "gamma"]);
    editor.destroy();
  });

  it("leaves a plain text selection to the browser", () => {
    const { editor, order } = setup([para("alpha")]);
    editor.focusBlock(order()[0]);
    const { event } = clipboardEvent("copy", editor.element.querySelector("[data-block-id]"));
    expect(event.defaultPrevented).toBe(false);
    editor.destroy();
  });

  it("cuts a cross-block range into one undoable step and joins its ends", () => {
    const { ws, editor, order, texts, select } = setup([para("alpha"), para("beta"), para("gamma")]);
    select(order()[0], order()[2], 2, 3);
    const { store } = clipboardEvent("cut", editor.element.querySelector("[data-block-id]"));
    expect(store["text/plain"]).toBe("pha\n\nbeta\n\ngam");
    expect(texts()).toEqual(["alma"]);
    ws.undo();
    expect(texts()).toEqual(["alpha", "beta", "gamma"]);
    editor.destroy();
  });

  it("deleting a selection that spans partial blocks keeps the marks of what remains", () => {
    const { editor, order, block, select } = setup([
      { type: "paragraph", runs: [{ text: "ab", marks: { bold: true } }, { text: "cd" }] },
      para("efgh")
    ]);
    select(order()[0], order()[1], 1, 2);
    const { event } = clipboardEvent("cut", editor.element.querySelector("[data-block-id]"));
    expect(event.defaultPrevented).toBe(true);
    expect(order()).toHaveLength(1);
    expect(block(order()[0]).runs).toEqual([{ text: "a", marks: { bold: true } }, { text: "gh" }]);
    editor.destroy();
  });

  it("pastes the private format as new blocks with fresh ids, in one undo step", () => {
    const { ws, editor, order, texts, select } = setup([para("alpha"), para("beta"), para("tail")]);
    select(order()[0], order()[1]);
    const { store } = clipboardEvent("copy", editor.element.querySelector("[data-block-id]"));
    const before = [...order()];
    editor.clearSelection();
    editor.focusBlock(order()[2], "end");
    const el = editor.element.querySelector(`[data-block-id="${order()[2]}"]`);
    const { event } = clipboardEvent("paste", el, store);
    expect(event.defaultPrevented).toBe(true);
    expect(texts()).toEqual(["alpha", "beta", "tailalpha", "beta"]);
    expect(order().filter((id) => before.includes(id))).toEqual(before);
    expect(new Set(order()).size).toBe(4);
    ws.undo();
    expect(texts()).toEqual(["alpha", "beta", "tail"]);
    editor.destroy();
  });

  it("splits the paragraph around the caret when pasting several blocks", () => {
    const { editor, order, texts } = setup([para("headtail")]);
    editor.focusBlock(order()[0], "end");
    const el = editor.element.querySelector(`[data-block-id="${order()[0]}"]`);
    const range = document.createRange();
    range.setStart(el.firstChild, 4);
    range.collapse(true);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    clipboardEvent("paste", el, { "text/plain": "one\ntwo" });
    expect(texts()).toEqual(["headone", "twotail"]);
    editor.destroy();
  });

  it("pastes plain text inline when it is a single line", () => {
    const { editor, order, texts } = setup([para("ab")]);
    editor.focusBlock(order()[0], "end");
    const el = editor.element.querySelector(`[data-block-id="${order()[0]}"]`);
    clipboardEvent("paste", el, { "text/plain": "cd" });
    expect(texts()).toEqual(["abcd"]);
    editor.destroy();
  });

  it("replaces selected blocks with what is pasted", () => {
    const { ws, editor, order, texts, select } = setup([para("one"), para("two"), para("three")]);
    select(order()[1], order()[1]);
    clipboardEvent("paste", editor.element.querySelector("[data-block-id]"), { "text/plain": "new" });
    expect(texts()).toEqual(["one", "new", "three"]);
    ws.undo();
    expect(texts()).toEqual(["one", "two", "three"]);
    editor.destroy();
  });

  it("replaces a partial cross-block selection with the pasted text", () => {
    const { editor, order, texts, select } = setup([para("alpha"), para("beta")]);
    select(order()[0], order()[1], 2, 2);
    clipboardEvent("paste", editor.element.querySelector("[data-block-id]"), { "text/plain": "-" });
    expect(texts()).toEqual(["al-ta"]);
    editor.destroy();
  });

  it("restores list items and nested blocks with new ids", () => {
    const { ws, pageId, editor, order, texts, select } = setup([
      {
        type: "list",
        items: [
          { id: "i1", runs: [{ text: "one" }] },
          { id: "i2", runs: [{ text: "two" }] }
        ]
      },
      para("end")
    ]);
    const list = order()[0];
    select(`${list}:i1`, `${list}:i2`);
    const { store } = clipboardEvent("copy", editor.element.querySelector("[data-block-id]"));
    expect(store["text/plain"]).toBe("- one\n- two");
    editor.clearSelection();
    editor.focusBlock(order()[1], "end");
    clipboardEvent("paste", editor.element.querySelector(`[data-block-id="${order()[1]}"]`), store);
    const pasted = ws.getPage(pageId).content.blocks[order()[2]];
    expect(pasted.type).toBe("list");
    expect(pasted.items.map((i) => i.runs[0].text)).toEqual(["one", "two"]);
    expect(pasted.items.map((i) => i.id)).not.toContain("i1");
    expect(texts()[1]).toBe("end");
    editor.destroy();
  });

  it("ignores a paste into a code block so the code handler keeps it", () => {
    const { editor, order } = setup([{ type: "code", text: "x" }]);
    const el = editor.element.querySelector(`code[data-block-id="${order()[0]}"]`);
    editor.focusBlock(order()[0], "end");
    clipboardEvent("paste", el, { "text/plain": "yz" });
    expect(editor.element.querySelector("[data-block-id]").textContent).toBe("xyz");
    editor.destroy();
  });
});

describe("partial block selection", () => {
  it("round-trips offsets through capture and restore, clamping to the text", () => {
    const { editor, order, select } = setup([para("alpha"), para("beta")]);
    select(order()[0], order()[1], 2, 99);
    expect(editor.captureSelection()).toEqual({
      type: "units",
      anchor: order()[0],
      focus: order()[1],
      anchorOffset: 2,
      focusOffset: 4
    });
    editor.destroy();
  });

  it("restyles only the selected range of the end blocks", () => {
    const { editor, order, block, select } = setup([para("alpha"), para("beta")]);
    select(order()[0], order()[1], 2, 2);
    editor.toggleMark("bold");
    expect(block(order()[0]).runs).toEqual([{ text: "al" }, { text: "pha", marks: { bold: true } }]);
    expect(block(order()[1]).runs).toEqual([{ text: "be", marks: { bold: true } }, { text: "ta" }]);
    editor.destroy();
  });

  it("Backspace over a partial selection removes the range", () => {
    const { editor, order, texts, select } = setup([para("alpha"), para("beta")]);
    select(order()[0], order()[1], 2, 2);
    const key = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
    editor.element.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(texts()).toEqual(["alta"]);
    editor.destroy();
  });

  it("typing a character over a partial selection removes the range, then inserts it at the caret", () => {
    const { editor, order, texts, select } = setup([para("alpha"), para("beta")]);
    const insert = vi.fn(() => true);
    document.execCommand = insert;
    select(order()[0], order()[1], 2, 2);
    const key = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    editor.element.dispatchEvent(key);
    delete document.execCommand;
    expect(key.defaultPrevented).toBe(true);
    expect(texts()).toEqual(["alta"]);
    expect(insert).toHaveBeenCalledWith("insertText", false, "x");
    editor.destroy();
  });

  it("typing over whole blocks does not delete them", () => {
    const { editor, order, texts, select } = setup([para("alpha"), para("beta")]);
    select(order()[0], order()[1]);
    editor.element.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }));
    expect(texts()).toEqual(["alpha", "beta"]);
    editor.destroy();
  });

  it("a whole-block selection is still painted with the block class when no highlight API exists", () => {
    const { editor, order, select } = setup([para("alpha"), para("beta")]);
    select(order()[0], order()[1], 2, 2);
    expect(editor.element.querySelectorAll(".is-block-selected").length).toBe(2);
    editor.destroy();
  });
});
