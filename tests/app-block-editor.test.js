import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { createDocumentEditor, splitRunsAt } from "../src/app/block-editor.js";

/** @param {Array<Record<string, unknown>>} blocks */
function setup(blocks) {
  const ws = Workspace.create({ title: "Doc" });
  registerDocumentCommands(ws);
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

  it("splits a code block into two code blocks", () => {
    const { editor, order, block } = setup([{ type: "code", text: "abcdef" }]);
    const el = editable(editor.element.querySelector("code[contenteditable=true]"));
    setCaret(el, 3);
    key(el, "Enter");
    const ids = order();
    expect(block(ids[0]).text).toBe("abc");
    expect(block(ids[1]).text).toBe("def");
    expect(block(ids[1]).type).toBe("code");
  });

  it("splits a list item into two items", () => {
    const { editor, order, block } = setup([
      { type: "list", ordered: false, items: [{ id: "item-1", runs: [{ text: "milk" }] }] }
    ]);
    const el = editable(editor.element.querySelector("li[contenteditable=true]"));
    setCaret(el, 2);
    key(el, "Enter");
    const list = block(order()[0]);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].runs).toEqual([{ text: "mi" }]);
    expect(list.items[1].runs).toEqual([{ text: "lk" }]);
  });

  it("removes an empty list item, exiting the list when it was the only one", () => {
    const { editor, order, block } = setup([
      { type: "list", ordered: false, items: [{ id: "item-1", runs: [{ text: "a" }] }, { id: "item-2", runs: [] }] }
    ]);
    const items = editable(editor.element.querySelectorAll("li[contenteditable=true]"));
    setCaret(items[1], 0);
    key(items[1], "Enter");
    expect(block(order()[0]).items).toHaveLength(1);

    // Now the only item, emptied, converts the whole list to a paragraph.
    editor.refresh();
    const single = editable(editor.element.querySelector("li[contenteditable=true]"));
    single.textContent = "";
    setCaret(single, 0);
    key(single, "Enter");
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
