import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createDocumentEditor, splitRunsAt } from "../src/app/block-editor.js";

/** @param {Array<Record<string, unknown>>} blocks */
function setup(blocks) {
  const ws = createWorkspace({ title: "Doc" });
  ws.dispatch("createPage", { type: "document", title: "Doc" });
  const pageId = ws.getChildren(null)[0];
  for (const block of blocks) ws.dispatch("insertBlock", { pageId, block });
  const editor = createDocumentEditor(ws, pageId);
  document.body.append(editor.element);
  return {
    ws,
    pageId,
    editor,
    content: () => ws.getPage(pageId).content,
    order: () => ws.getPage(pageId).content.blockOrder,
    block: (id) => ws.getPage(pageId).content.blocks[id]
  };
}

/** @param {Element} el @param {number} offset */
function setCaret(el, offset) {
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = (node.textContent ?? "").length;
    if (remaining <= length) {
      range.setStart(node, remaining);
      range.collapse(true);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    remaining -= length;
    node = walker.nextNode();
  }
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** @param {Element} el @param {number} offset */
function selectRange(el, start, end) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  const locate = (offset) => {
    let remaining = offset;
    for (const text of nodes) {
      const length = (text.textContent ?? "").length;
      if (remaining <= length) return { node: text, offset: remaining };
      remaining -= length;
    }
    const last = nodes[nodes.length - 1] ?? el;
    return { node: last, offset: (last.textContent ?? "").length };
  };
  const from = locate(start);
  const to = locate(end);
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/** @param {Element} el @param {string} key @param {KeyboardEventInit} [init] */
function key(el, keyName, init = {}) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init }));
}

/** @param {Element} el */
function editable(el) {
  return /** @type {HTMLElement} */ (el);
}

describe("splitRunsAt", () => {
  it("splits plain runs", () => {
    expect(splitRunsAt([{ text: "hello" }], 2)).toEqual({
      left: [{ text: "he" }],
      right: [{ text: "llo" }]
    });
  });

  it("splits across marked runs", () => {
    expect(splitRunsAt([{ text: "ab", marks: { bold: true } }, { text: "cd" }], 3)).toEqual({
      left: [{ text: "ab", marks: { bold: true } }, { text: "c" }],
      right: [{ text: "d" }]
    });
  });

  it("handles offsets at both extremes", () => {
    expect(splitRunsAt([{ text: "ab" }], 0).left).toEqual([]);
    expect(splitRunsAt([{ text: "ab" }], 2).right).toEqual([]);
  });
});

describe("createDocumentEditor rendering", () => {
  it("renders editable blocks per block with placeholders for empty text", () => {
    const { editor, order } = setup([
      { type: "paragraph", runs: [{ text: "Hello" }] },
      { type: "heading", level: 2, runs: [{ text: "Title" }] },
      { type: "divider" }
    ]);
    expect(editor.element.querySelectorAll("[contenteditable=true]")).toHaveLength(2);
    expect(editor.element.querySelector("h2")?.textContent).toBe("Title");
    expect(order()).toHaveLength(3);
  });

  it("shows a start-writing affordance for empty documents", () => {
    const { editor } = setup([]);
    const start = editor.element.querySelector(".empty-document");
    expect(start?.textContent).toContain("Start writing");
    start?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(editor.element.querySelectorAll("[contenteditable=true]")).toHaveLength(1);
  });
});

describe("typing commits to the model", () => {
  it("updates runs on input", () => {
    const { editor, ws, pageId, order, block } = setup([{ type: "paragraph", runs: [{ text: "old" }] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    el.textContent = "new text";
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(block(order()[0]).runs).toEqual([{ text: "new text" }]);
    expect(ws.dirty).toBe(true);
  });

  it("skips re-render for inline-only commits so the caret survives", () => {
    const { editor, order } = setup([{ type: "paragraph", runs: [{ text: "old" }] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    el.textContent = "typed";
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    // Same DOM element instance remains (no rebuild).
    expect(editor.element.querySelector("[contenteditable=true]")).toBe(el);
    expect(order()).toHaveLength(1);
  });

  it("undoes a run of typing in one block as a single step", () => {
    const { editor, ws, order, block } = setup([{ type: "paragraph", runs: [{ text: "old" }] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    for (const text of ["n", "ne", "new"]) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    expect(block(order()[0]).runs).toEqual([{ text: "new" }]);
    ws.undo();
    expect(block(order()[0]).runs).toEqual([{ text: "old" }]);
  });

  it("updates code text on input", () => {
    const { editor, order, block } = setup([{ type: "code", text: "x" }]);
    const el = editable(editor.element.querySelector("code[contenteditable=true]"));
    el.textContent = "let x = 1";
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(block(order()[0]).text).toBe("let x = 1");
  });
});

describe("Enter behaviour", () => {
  it("splits a paragraph at the caret", () => {
    const { editor, order, block } = setup([{ type: "paragraph", runs: [{ text: "HelloWorld" }] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    setCaret(el, 5);
    key(el, "Enter");

    const ids = order();
    expect(ids).toHaveLength(2);
    expect(block(ids[0]).runs).toEqual([{ text: "Hello" }]);
    expect(block(ids[1]).runs).toEqual([{ text: "World" }]);
    expect(block(ids[1]).type).toBe("paragraph");
  });

  it("creates a paragraph after a heading, preserving marks in the tail", () => {
    const { editor, order, block } = setup([
      { type: "heading", level: 1, runs: [{ text: "Hi" }, { text: "there", marks: { bold: true } }] }
    ]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    setCaret(el, 2);
    key(el, "Enter");
    const ids = order();
    expect(block(ids[1]).type).toBe("paragraph");
    expect(block(ids[1]).runs).toEqual([{ text: "there", marks: { bold: true } }]);
  });

  it("inserts a newline inside a code block instead of splitting it", () => {
    const { editor, order, block } = setup([{ type: "code", text: "abcdef" }]);
    const el = editable(editor.element.querySelector("code[contenteditable=true]"));
    setCaret(el, 3);
    key(el, "Enter");
    expect(order()).toHaveLength(1);
    expect(block(order()[0]).text).toBe("abc\ndef");
    expect(el.textContent).toBe("abc\ndef");
  });

  it("leaves the code block on Enter at an empty last line", () => {
    const { editor, order, block } = setup([{ type: "code", text: "abc\n" }]);
    const el = editable(editor.element.querySelector("code[contenteditable=true]"));
    setCaret(el, 4);
    key(el, "Enter");
    const ids = order();
    expect(ids).toHaveLength(2);
    expect(block(ids[0]).text).toBe("abc");
    expect(block(ids[1]).type).toBe("paragraph");
    expect(editor.getActiveBlockId()).toBe(ids[1]);
  });

  it("makes code blocks typeable: edits commit to the model", () => {
    const { editor, order, block } = setup([{ type: "code", text: "" }]);
    const el = editable(editor.element.querySelector("code[contenteditable=true]"));
    el.textContent = "let x";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    expect(block(order()[0]).text).toBe("let x");
  });

  it("indents with spaces in code on Tab", () => {
    const { editor, order, block } = setup([{ type: "code", text: "x" }]);
    const el = editable(editor.element.querySelector("code[contenteditable=true]"));
    setCaret(el, 0);
    key(el, "Tab");
    expect(block(order()[0]).text).toBe("  x");
  });

  it("splits a list item into two items", () => {
    const { editor, order, block } = setup([
      { type: "list", ordered: false, items: [{ id: "item-1", runs: [{ text: "milk" }] }] }
    ]);
    const el = editable(editor.element.querySelector(".block-item[contenteditable=true]"));
    setCaret(el, 2);
    key(el, "Enter");
    const list = block(order()[0]);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].runs).toEqual([{ text: "mi" }]);
    expect(list.items[1].runs).toEqual([{ text: "lk" }]);
  });

  it("ends the list on Enter in an empty last item, leaving a paragraph after it", () => {
    const { editor, order, block } = setup([
      { type: "list", ordered: false, items: [{ id: "item-1", runs: [{ text: "a" }] }, { id: "item-2", runs: [] }] }
    ]);
    const items = editable(editor.element.querySelectorAll(".block-item[contenteditable=true]"));
    setCaret(items[1], 0);
    key(items[1], "Enter");
    const ids = order();
    expect(ids).toHaveLength(2);
    expect(block(ids[0]).type).toBe("list");
    expect(block(ids[0]).items).toHaveLength(1);
    expect(block(ids[1]).type).toBe("paragraph");
    expect(editor.getActiveBlockId()).toBe(ids[1]);
  });

  it("turns an emptied sole list item into a paragraph", () => {
    const { editor, order, block } = setup([{ type: "list", ordered: false, items: [{ id: "item-1", runs: [] }] }]);
    const single = editable(editor.element.querySelector(".block-item[contenteditable=true]"));
    setCaret(single, 0);
    key(single, "Enter");
    expect(order()).toHaveLength(1);
    expect(block(order()[0]).type).toBe("paragraph");
  });

  it("splits the list around an empty item in the middle", () => {
    const { editor, order, block } = setup([
      {
        type: "list",
        ordered: true,
        items: [
          { id: "i1", runs: [{ text: "one" }] },
          { id: "i2", runs: [] },
          { id: "i3", runs: [{ text: "three" }] }
        ]
      }
    ]);
    const items = editable(editor.element.querySelectorAll(".block-item[contenteditable=true]"));
    setCaret(items[1], 0);
    key(items[1], "Enter");
    const ids = order();
    expect(ids.map((id) => block(id).type)).toEqual(["list", "paragraph", "list"]);
    expect(block(ids[0]).items.map((item) => item.id)).toEqual(["i1"]);
    expect(block(ids[2]).items.map((item) => item.id)).toEqual(["i3"]);
    expect(block(ids[2]).ordered).toBe(true);
  });

  it("starts a paragraph, not another quote, on Enter in a quote", () => {
    const { editor, order, block } = setup([{ type: "quote", runs: [{ text: "QuoteMore" }] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    setCaret(el, 5);
    key(el, "Enter");
    const ids = order();
    expect(block(ids[0]).type).toBe("quote");
    expect(block(ids[0]).runs).toEqual([{ text: "Quote" }]);
    expect(block(ids[1]).type).toBe("paragraph");
    expect(block(ids[1]).runs).toEqual([{ text: "More" }]);
  });

  it("ends an empty quote by turning it into a paragraph", () => {
    const { editor, order, block } = setup([{ type: "quote", runs: [] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    setCaret(el, 0);
    key(el, "Enter");
    expect(order()).toHaveLength(1);
    expect(block(order()[0]).type).toBe("paragraph");
  });
});

describe("Backspace behaviour", () => {
  it("merges a block into the previous paragraph", () => {
    const { editor, order, block } = setup([
      { type: "paragraph", runs: [{ text: "one" }] },
      { type: "paragraph", runs: [{ text: "two" }] }
    ]);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    const second = editable(els[1]);
    second.textContent = "two";
    setCaret(second, 0);
    key(second, "Backspace");

    const ids = order();
    expect(ids).toHaveLength(1);
    expect(block(ids[0]).runs).toEqual([{ text: "onetwo" }]);
  });

  it("does nothing at the start of the first block", () => {
    const { editor, order } = setup([{ type: "paragraph", runs: [{ text: "only" }] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    setCaret(el, 0);
    key(el, "Backspace");
    expect(order()).toHaveLength(1);
  });

  it("merges into the previous code block as text", () => {
    const { editor, order, block } = setup([
      { type: "code", text: "const a = 1;" },
      { type: "paragraph", runs: [{ text: "// note" }] }
    ]);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    const paragraph = editable(els[1]);
    paragraph.textContent = "// note";
    setCaret(paragraph, 0);
    key(paragraph, "Backspace");
    const ids = order();
    expect(ids).toHaveLength(1);
    expect(block(ids[0]).text).toBe("const a = 1;// note");
  });
});

describe("arrow navigation", () => {
  it("moves to the next block at the end with ArrowDown", () => {
    const { editor, order } = setup([
      { type: "paragraph", runs: [{ text: "a" }] },
      { type: "paragraph", runs: [{ text: "b" }] }
    ]);
    const first = editable(editor.element.querySelectorAll("[contenteditable=true]")[0]);
    setCaret(first, 1);
    key(first, "ArrowDown");
    expect(editor.getActiveBlockId()).toBe(order()[1]);
  });

  it("moves to the previous block at the start with ArrowUp", () => {
    const { editor, order } = setup([
      { type: "paragraph", runs: [{ text: "a" }] },
      { type: "paragraph", runs: [{ text: "b" }] }
    ]);
    const second = editable(editor.element.querySelectorAll("[contenteditable=true]")[1]);
    setCaret(second, 0);
    key(second, "ArrowUp");
    expect(editor.getActiveBlockId()).toBe(order()[0]);
  });
});

describe("inline marks", () => {
  it("toggles bold over a selection and commits to the model", () => {
    const { editor, order, block } = setup([{ type: "paragraph", runs: [{ text: "abc" }] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    editor.focusBlock(order()[0], "start");
    selectRange(el, 0, 3);
    editor.toggleMark("bold");
    expect(block(order()[0]).runs).toEqual([{ text: "abc", marks: { bold: true } }]);
  });

  it("toggles bold off when the selection is already bold", () => {
    const { editor, order, block } = setup([
      { type: "paragraph", runs: [{ text: "abc", marks: { bold: true } }] }
    ]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    editor.focusBlock(order()[0], "start");
    selectRange(el, 0, 3);
    editor.toggleMark("bold");
    expect(block(order()[0]).runs).toEqual([{ text: "abc" }]);
  });

  it("ignores a collapsed selection", () => {
    const { editor, order, block } = setup([{ type: "paragraph", runs: [{ text: "abc" }] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    editor.focusBlock(order()[0], "start");
    setCaret(el, 1);
    expect(editor.toggleMark("bold")).toBe(false);
    expect(block(order()[0]).runs).toEqual([{ text: "abc" }]);
  });

  it("applies a link over a selection", () => {
    const { editor, order, block } = setup([{ type: "paragraph", runs: [{ text: "site" }] }]);
    const el = editable(editor.element.querySelector("[contenteditable=true]"));
    editor.focusBlock(order()[0], "start");
    selectRange(el, 0, 4);
    editor.setLink("https://example.test");
    expect(block(order()[0]).runs).toEqual([
      { text: "site", marks: { link: "https://example.test" } }
    ]);
  });
});

describe("toolbar-driven structure", () => {
  it("changes the active block type and re-renders", () => {
    const { editor, order } = setup([{ type: "paragraph", runs: [{ text: "T" }] }]);
    editor.focusBlock(order()[0], "end");
    editor.setActiveType({ type: "heading", level: 1 });
    expect(editor.element.querySelector("h1")?.textContent).toBe("T");
  });

  it("changes only the list item under the caret, splitting the list around it", () => {
    const { editor, order, block } = setup([
      {
        type: "list",
        ordered: false,
        items: [
          { id: "i1", runs: [{ text: "one" }] },
          { id: "i2", runs: [{ text: "two" }] },
          { id: "i3", runs: [{ text: "three" }] }
        ]
      }
    ]);
    const items = [...editor.element.querySelectorAll(".block-item[contenteditable=true]")];
    items[1].dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    editor.setActiveType({ type: "quote" });

    const ids = order();
    expect(ids.map((id) => block(id).type)).toEqual(["list", "quote", "list"]);
    expect(block(ids[0]).items.map((item) => item.id)).toEqual(["i1"]);
    expect(block(ids[1]).runs).toEqual([{ text: "two" }]);
    expect(block(ids[2]).items.map((item) => item.id)).toEqual(["i3"]);
    expect(editor.getActiveBlockId()).toBe(ids[1]);
  });

  it("puts a quote ahead of the list when the first item changes", () => {
    const { editor, order, block } = setup([
      {
        type: "list",
        ordered: false,
        items: [
          { id: "i1", runs: [{ text: "one" }] },
          { id: "i2", runs: [{ text: "two" }] }
        ]
      }
    ]);
    const items = [...editor.element.querySelectorAll(".block-item[contenteditable=true]")];
    items[0].dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    editor.setActiveType({ type: "quote" });
    const ids = order();
    expect(ids.map((id) => block(id).type)).toEqual(["quote", "list"]);
    expect(block(ids[1]).items.map((item) => item.id)).toEqual(["i2"]);
  });

  it("inserts a block at the end and focuses it", () => {
    const { editor, order } = setup([{ type: "paragraph", runs: [{ text: "one" }] }]);
    const id = editor.insertAtEnd({ type: "quote" });
    expect(order()).toHaveLength(2);
    expect(editor.getActiveBlockId()).toBe(id);
  });

  it("inserts after the active block", () => {
    const { editor, order } = setup([
      { type: "paragraph", runs: [{ text: "one" }] },
      { type: "paragraph", runs: [{ text: "two" }] }
    ]);
    const first = order()[0];
    editor.focusBlock(first, "end");
    const id = editor.insertAfterActive({ type: "divider" });
    expect(order()[1]).toBe(id);
    expect(order()).toHaveLength(3);
  });

  it("reports active block info", () => {
    const { editor, order } = setup([{ type: "list", ordered: true, items: [{ id: "i1", runs: [{ text: "x" }] }] }]);
    editor.focusBlock(order()[0], "start");
    expect(editor.activeInfo()).toMatchObject({ type: "list", ordered: true });
  });
});

describe("renderer reacts to model changes", () => {
  it("re-renders when a structural command runs", () => {
    const { editor, ws, pageId, order } = setup([{ type: "paragraph", runs: [{ text: "T" }] }]);
    ws.dispatch("changeBlockType", { pageId, blockId: order()[0], type: "heading", fields: { level: 2 } });
    expect(editor.element.querySelector("h2")?.textContent).toBe("T");
  });

  it("stops listening after destroy", () => {
    const { editor, ws, pageId, order } = setup([{ type: "paragraph", runs: [{ text: "T" }] }]);
    editor.destroy();
    ws.dispatch("changeBlockType", { pageId, blockId: order()[0], type: "heading", fields: { level: 2 } });
    expect(editor.element.querySelector("h2")).toBeNull();
  });
});

/** @param {Element} el @param {string} type @param {MouseEventInit} [init] */
function mouse(el, type, init = {}) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}

const THREE = [
  { type: "paragraph", runs: [{ text: "one" }] },
  { type: "paragraph", runs: [{ text: "two" }] },
  { type: "paragraph", runs: [{ text: "three" }] }
];

describe("multi-block selection", () => {
  it("selects every block between a mousedown and a drag", () => {
    const { editor } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    mouse(els[0], "mousedown");
    mouse(els[2], "mousemove", { buttons: 1 });
    mouse(document.body, "mouseup");
    expect(editor.getSelectedUnits()).toHaveLength(3);
    expect(editor.element.querySelectorAll(".is-block-selected")).toHaveLength(3);
    expect(editor.activeInfo().selectionSize).toBe(3);
  });

  it("does not select anything for a plain click or a drag inside one block", () => {
    const { editor } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    mouse(els[0], "mousedown");
    mouse(els[0], "mousemove", { buttons: 1 });
    expect(editor.getSelectedUnits()).toHaveLength(0);
  });

  it("shift-click selects from the active block to the clicked one", () => {
    const { editor } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    editor.focusBlock(editor.element.querySelector("[data-block-id]").getAttribute("data-block-id"), "end");
    mouse(els[1], "mousedown", { shiftKey: true });
    expect(editor.getSelectedUnits()).toHaveLength(2);
  });

  it("Escape selects the current block and Shift+ArrowDown extends the selection", () => {
    const { editor } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    editor.focusBlock(editor.element.querySelector("[data-block-id]").getAttribute("data-block-id"), "end");
    key(els[0], "Escape");
    expect(editor.getSelectedUnits()).toHaveLength(1);
    key(editor.element, "ArrowDown", { shiftKey: true });
    expect(editor.getSelectedUnits()).toHaveLength(2);
    key(editor.element, "ArrowDown", { shiftKey: true });
    expect(editor.getSelectedUnits()).toHaveLength(3);
  });

  it("grows Select All from the unit text to every block", () => {
    const { editor } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    setCaret(els[1], 0);
    selectRange(els[1], 0, 3);
    key(els[1], "a", { metaKey: true });
    expect(editor.getSelectedUnits()).toHaveLength(3);
  });

  it("Escape/Enter returns to text editing and clears the selection", () => {
    const { editor } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    editor.focusBlock(editor.element.querySelector("[data-block-id]").getAttribute("data-block-id"), "end");
    key(els[0], "Escape");
    key(editor.element, "Enter");
    expect(editor.getSelectedUnits()).toHaveLength(0);
  });

  it("deletes the selected blocks with Backspace as one undoable step", () => {
    const { editor, ws, order } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    mouse(els[0], "mousedown");
    mouse(els[1], "mousemove", { buttons: 1 });
    key(editor.element, "Backspace");
    expect(order()).toHaveLength(1);
    expect(editor.getSelectedUnits()).toHaveLength(0);
    ws.undo();
    expect(order()).toHaveLength(3);
  });

  it("keeps an empty paragraph when every block is deleted", () => {
    const { editor, order, block } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    selectRange(els[0], 0, 3);
    key(els[0], "a", { metaKey: true });
    key(editor.element, "Delete");
    expect(order()).toHaveLength(1);
    expect(block(order()[0]).type).toBe("paragraph");
  });

  it("applies a block type to every selected block", () => {
    const { editor, order, block } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    mouse(els[0], "mousedown");
    mouse(els[2], "mousemove", { buttons: 1 });
    editor.setActiveType({ type: "heading", level: 2 });
    for (const id of order()) {
      expect(block(id)).toMatchObject({ type: "heading", level: 2 });
    }
  });

  it("applies a mark to every selected block", () => {
    const { editor, order, block } = setup(THREE);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    mouse(els[0], "mousedown");
    mouse(els[1], "mousemove", { buttons: 1 });
    editor.toggleMark("bold");
    expect(block(order()[0]).runs.every((run) => run.marks?.bold)).toBe(true);
    expect(block(order()[1]).runs.every((run) => run.marks?.bold)).toBe(true);
    expect(block(order()[2]).runs.some((run) => run.marks?.bold)).toBe(false);
  });
});

describe("heading levels", () => {
  it("switches between heading levels and back to a paragraph", () => {
    const { editor, order, block } = setup([{ type: "heading", level: 1, runs: [{ text: "T" }] }]);
    editor.focusBlock(order()[0], "end");
    editor.setActiveType({ type: "heading", level: 3 });
    expect(block(order()[0])).toMatchObject({ type: "heading", level: 3 });
    expect(editor.element.querySelector("h3")?.textContent).toBe("T");
    editor.setActiveType({ type: "paragraph" });
    expect(block(order()[0]).type).toBe("paragraph");
    expect(editor.element.querySelector("h3")).toBeNull();
  });
});

describe("lists and nesting", () => {
  const makeList = () => ({
    type: "list",
    ordered: false,
    items: [
      { id: "item-a", runs: [{ text: "a" }] },
      { id: "item-b", runs: [{ text: "b" }] }
    ]
  });

  it("inserts a usable list: one empty editable item that takes focus", () => {
    const { editor, order, block } = setup([{ type: "paragraph", runs: [{ text: "x" }] }]);
    editor.focusBlock(order()[0], "end");
    editor.insertAfterActive({ type: "list" });
    const list = block(order()[1]);
    expect(list.type).toBe("list");
    expect(list.items).toHaveLength(1);
    expect(editor.element.querySelectorAll(".block-item[contenteditable=true]")).toHaveLength(1);
    expect(editor.activeInfo()).toMatchObject({ type: "list", itemId: list.items[0].id });
  });

  it("indents a list item under the previous one on Tab and lifts it on Shift+Tab", () => {
    const { editor, order, block } = setup([makeList()]);
    const items = editor.element.querySelectorAll(".block-item[contenteditable=true]");
    setCaret(items[1], 1);
    key(items[1], "Tab");
    const parent = block(order()[0]);
    expect(parent.items).toHaveLength(1);
    expect(parent.items[0].children).toHaveLength(1);
    const nested = block(parent.items[0].children[0]);
    expect(nested.type).toBe("list");
    expect(nested.items[0].runs).toEqual([{ text: "b" }]);
    expect(editor.element.querySelector(".item-children .block-item")?.textContent).toBe("b");

    const moved = editable(editor.element.querySelector(".item-children .block-item[contenteditable=true]"));
    setCaret(moved, 1);
    key(moved, "Tab", { shiftKey: true });
    expect(block(order()[0]).items).toHaveLength(2);
    expect(editor.element.querySelector(".item-children")).toBeNull();
  });

  it("does not indent the first item", () => {
    const { editor, order, block } = setup([makeList()]);
    const items = editor.element.querySelectorAll(".block-item[contenteditable=true]");
    setCaret(items[0], 0);
    key(items[0], "Tab");
    expect(block(order()[0]).items).toHaveLength(2);
  });

  it("nests a quote and a heading under a list item with Tab", () => {
    const { editor, order, block } = setup([
      makeList(),
      { type: "quote", runs: [{ text: "q" }] },
      { type: "heading", level: 2, runs: [{ text: "h" }] }
    ]);
    const quote = editable(editor.element.querySelector("blockquote[contenteditable=true]"));
    setCaret(quote, 0);
    key(quote, "Tab");
    expect(order()).toHaveLength(2);
    const lastItem = block(order()[0]).items[1];
    expect(lastItem.children).toHaveLength(1);
    expect(block(lastItem.children[0]).type).toBe("quote");
    expect(editor.element.querySelector(".item-children blockquote")?.textContent).toBe("q");

    const heading = editable(editor.element.querySelector("h2[contenteditable=true]"));
    setCaret(heading, 0);
    key(heading, "Tab");
    expect(order()).toHaveLength(1);
    expect(block(order()[0]).items[1].children).toHaveLength(2);
  });

  it("lifts a nested quote back out with Shift+Tab", () => {
    const { editor, order, block } = setup([makeList(), { type: "quote", runs: [{ text: "q" }] }]);
    const quote = editable(editor.element.querySelector("blockquote[contenteditable=true]"));
    setCaret(quote, 0);
    key(quote, "Tab");
    const nested = editable(editor.element.querySelector(".item-children blockquote[contenteditable=true]"));
    setCaret(nested, 0);
    key(nested, "Tab", { shiftKey: true });
    expect(order()).toHaveLength(2);
    expect(block(order()[1]).type).toBe("quote");
  });

  it("ends a nested quote on Enter when it is empty", () => {
    const { editor, order, block } = setup([makeList(), { type: "quote", runs: [] }]);
    const quote = editable(editor.element.querySelector("blockquote[contenteditable=true]"));
    setCaret(quote, 0);
    key(quote, "Tab");
    const nested = editable(editor.element.querySelector(".item-children blockquote[contenteditable=true]"));
    setCaret(nested, 0);
    key(nested, "Enter");
    expect(order()).toHaveLength(2);
    expect(block(order()[0]).items[1].children ?? []).toHaveLength(0);
  });

  it("merges a list item into the previous one on Backspace, keeping nested children", () => {
    const { editor, order, block } = setup([makeList()]);
    const items = editor.element.querySelectorAll(".block-item[contenteditable=true]");
    setCaret(items[1], 0);
    key(items[1], "Backspace");
    const list = block(order()[0]);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].runs.map((run) => run.text).join("")).toBe("ab");
  });

  it("exposes indent and outdent on the handle", () => {
    const { editor, order, block } = setup([makeList()]);
    const items = editor.element.querySelectorAll(".block-item[contenteditable=true]");
    setCaret(items[1], 0);
    items[1].dispatchEvent(new Event("focusin", { bubbles: true }));
    editor.indent();
    expect(block(order()[0]).items).toHaveLength(1);
    const nested = editable(editor.element.querySelector(".item-children .block-item[contenteditable=true]"));
    nested.dispatchEvent(new Event("focusin", { bubbles: true }));
    editor.outdent();
    expect(block(order()[0]).items).toHaveLength(2);
  });
});

describe("code blocks", () => {
  it("inserts a newline on Enter instead of splitting the block", () => {
    const { editor, order, block } = setup([{ type: "code", text: "ab" }]);
    const el = editable(editor.element.querySelector("code[contenteditable=true]"));
    setCaret(el, 1);
    key(el, "Enter");
    expect(order()).toHaveLength(1);
    expect(block(order()[0]).text).toBe("a\nb");
  });

  it("pastes plain text into code", () => {
    const { editor, order, block } = setup([{ type: "code", text: "" }]);
    const el = editable(editor.element.querySelector("code[contenteditable=true]"));
    setCaret(el, 0);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "x = 1\r\ny = 2" } });
    el.dispatchEvent(event);
    expect(block(order()[0]).text).toBe("x = 1\ny = 2");
  });

  it("focuses the code when the padding of the block is clicked", () => {
    const { editor, order } = setup([{ type: "code", text: "abc" }]);
    mouse(editor.element.querySelector("pre.block-code"), "mousedown");
    expect(editor.getActiveBlockId()).toBe(order()[0]);
  });
});

describe("context menu", () => {
  const openOn = (/** @type {Element} */ el) =>
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  const item = (/** @type {string} */ action, extra = "") =>
    /** @type {HTMLButtonElement | null} */ (document.body.querySelector(`.context-menu [data-action="${action}"]${extra}`));
  const closeMenu = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  it("opens on right-click in a block and makes that block active", () => {
    const { editor, order } = setup([{ type: "paragraph" }, { type: "paragraph" }]);
    const second = editor.element.querySelectorAll("[contenteditable=true]")[1];
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    second.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.body.querySelector(".popover.context-menu")).toBeTruthy();
    expect(editor.getActiveBlockId()).toBe(order()[1]);
    editor.destroy();
    expect(document.body.querySelector(".popover.context-menu")).toBeNull();
  });

  it("picks the nearest block when the click lands outside every block", () => {
    const { editor, order } = setup([{ type: "paragraph" }, { type: "paragraph" }, { type: "paragraph" }]);
    const units = [...editor.element.querySelectorAll("[data-unit]")];
    const rect = (/** @type {number} */ top) => () => /** @type {DOMRect} */ ({ top, bottom: top + 20, height: 20 });
    units.forEach((unit, index) => (unit.getBoundingClientRect = rect(index * 100)));
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientY: 190 });
    editor.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.body.querySelector(".popover.context-menu")).toBeTruthy();
    expect(editor.getActiveBlockId()).toBe(order()[2]);
    closeMenu();

    const above = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientY: 2 });
    editor.element.dispatchEvent(above);
    expect(editor.getActiveBlockId()).toBe(order()[0]);
    editor.destroy();
  });

  it("falls back to the active block when nothing has layout", () => {
    const { editor, order } = setup([{ type: "paragraph" }, { type: "paragraph" }]);
    editor.focusBlock(order()[0]);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    editor.element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getActiveBlockId()).toBe(order()[0]);
    editor.destroy();
  });

  it("turns the block into another type", () => {
    const { editor, order, block } = setup([{ type: "paragraph", runs: [{ text: "hi" }] }]);
    openOn(editor.element.querySelector("[contenteditable=true]"));
    item("ctx-block-type", '[data-type="heading-2"]')?.click();
    expect(block(order()[0]).type).toBe("heading");
    expect(block(order()[0]).level).toBe(2);
    expect(document.body.querySelector(".context-menu")).toBeNull();

    openOn(editor.element.querySelector("[contenteditable=true]"));
    item("ctx-block-type", '[data-type="quote"]')?.click();
    expect(block(order()[0]).type).toBe("quote");
    editor.destroy();
  });

  it("only offers text formatting while text is selected", () => {
    const { editor } = setup([{ type: "paragraph", runs: [{ text: "hello" }] }]);
    const el = editor.element.querySelector("[contenteditable=true]");
    setCaret(el, 2);
    openOn(el);
    expect(item("ctx-mark", '[data-mark="bold"]')?.disabled).toBe(true);
    expect(item("ctx-cut")?.disabled).toBe(true);
    closeMenu();
    editor.destroy();
  });

  it("inserts a divider below and deletes the block", () => {
    const { editor, order, block } = setup([
      { type: "paragraph", runs: [{ text: "a" }] },
      { type: "paragraph", runs: [{ text: "b" }] }
    ]);
    const first = editor.element.querySelectorAll("[contenteditable=true]")[0];
    openOn(first);
    item("ctx-insert-divider")?.click();
    expect(order().map((id) => block(id).type)).toEqual(["paragraph", "divider", "paragraph"]);

    const again = editor.element.querySelectorAll("[contenteditable=true]")[0];
    openOn(again);
    item("ctx-delete")?.click();
    expect(order().map((id) => block(id).type)).toEqual(["divider", "paragraph"]);
    editor.destroy();
  });

  it("deletes every selected block and keeps the selection when right-clicking inside it", () => {
    const { editor, order } = setup([{ type: "paragraph" }, { type: "paragraph" }, { type: "paragraph" }]);
    const els = editor.element.querySelectorAll("[contenteditable=true]");
    editor.focusBlock(order()[0], "end");
    els[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, shiftKey: true }));
    expect(editor.getSelectedUnits()).toHaveLength(2);
    openOn(els[1]);
    expect(editor.getSelectedUnits()).toHaveLength(2);
    expect(item("ctx-delete")?.textContent).toContain("Delete blocks");
    item("ctx-delete")?.click();
    expect(order()).toHaveLength(1);
    editor.destroy();
  });

  it("indents and outdents from the menu", () => {
    const list = {
      type: "list",
      ordered: false,
      items: [
        { id: "item-a", runs: [{ text: "a" }] },
        { id: "item-b", runs: [{ text: "b" }] }
      ]
    };
    const { editor, order, block } = setup([list, { type: "quote", runs: [{ text: "q" }] }]);
    const quote = editor.element.querySelector("blockquote[contenteditable=true]");
    openOn(quote);
    expect(item("ctx-outdent")?.disabled).toBe(true);
    item("ctx-indent")?.click();
    expect(order()).toHaveLength(1);
    expect(block(block(order()[0]).items[1].children[0]).type).toBe("quote");

    const nested = editor.element.querySelector(".item-children blockquote[contenteditable=true]");
    openOn(nested);
    item("ctx-outdent")?.click();
    expect(order()).toHaveLength(2);
    editor.destroy();
  });

});

describe("selection capture and restore", () => {
  it("round-trips a caret through the logical selection and clamps a shrunk text", () => {
    const { editor, order } = setup([{ type: "paragraph", runs: [{ text: "Hello" }] }]);
    const blockId = order()[0];
    expect(editor.restoreSelection({ type: "text", anchor: { blockId, offset: 2 }, focus: { blockId, offset: 9 } })).toBe(true);
    expect(editor.captureSelection()).toEqual({ type: "text", anchor: { blockId, offset: 2 }, focus: { blockId, offset: 5 } });
    expect(editor.restoreSelection({ type: "text", anchor: { blockId: "gone", offset: 0 }, focus: { blockId: "gone", offset: 0 } })).toBe(false);
    expect(editor.restoreSelection("junk")).toBe(false);
    expect(editor.dependsOn()).toBeInstanceOf(Set);
  });
});
