import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { createDocumentEditor } from "../src/app/block-editor.js";
import { buildLinkForm, linkPages, normalizeLinkUrl, pageIdOfLink, pageLinkUrl } from "../src/app/link-form.js";

/** @param {Array<Record<string, unknown>>} blocks */
function setup(blocks, options = {}) {
  const ws = Workspace.create({ title: "Doc" });
  registerDocumentCommands(ws);
  ws.dispatch("createPage", { type: "document", title: "Doc" });
  const pageId = ws.getChildren(null)[0];
  for (const block of blocks) ws.dispatch("insertBlock", { pageId, block });
  const editor = createDocumentEditor(ws, pageId, options);
  document.body.append(editor.element);
  return {
    ws,
    pageId,
    editor,
    order: () => ws.getPage(pageId).content.blockOrder,
    block: (id) => ws.getPage(pageId).content.blocks[id],
    editables: () => [...editor.element.querySelectorAll("[contenteditable=true]")]
  };
}

/** @param {Element} el @param {number} start @param {number} end */
function selectRange(el, start, end) {
  const nodes = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("normalizeLinkUrl", () => {
  it("adds https when no scheme is given", () => {
    expect(normalizeLinkUrl(" example.com/a ")).toBe("https://example.com/a");
  });

  it("keeps schemes the user typed", () => {
    expect(normalizeLinkUrl("http://x.test")).toBe("http://x.test");
    expect(normalizeLinkUrl("tel:+15550100")).toBe("tel:+15550100");
    expect(normalizeLinkUrl("#top")).toBe("#top");
  });

  it("turns an email address into mailto", () => {
    expect(normalizeLinkUrl("me@example.com")).toBe("mailto:me@example.com");
  });

  it("rejects schemes that run code", () => {
    expect(normalizeLinkUrl("javascript:alert(1)")).toBe("");
    expect(normalizeLinkUrl("  DATA:text/html,x")).toBe("");
    expect(normalizeLinkUrl("")).toBe("");
  });
});

describe("links in the document editor", () => {
  it("rejects an unsafe address and leaves the text alone", () => {
    const { editor, order, block, editables } = setup([{ type: "paragraph", runs: [{ text: "site" }] }]);
    editor.focusBlock(order()[0], "start");
    selectRange(editables()[0], 0, 4);
    expect(editor.setLink("javascript:alert(1)")).toBe(false);
    expect(block(order()[0]).runs).toEqual([{ text: "site" }]);
  });

  it("links part of a paragraph", () => {
    const { editor, order, block, editables } = setup([{ type: "paragraph", runs: [{ text: "read the docs now" }] }]);
    editor.focusBlock(order()[0], "start");
    selectRange(editables()[0], 9, 13);
    editor.setLink("example.com");
    expect(block(order()[0]).runs).toEqual([
      { text: "read the " },
      { text: "docs", marks: { link: "https://example.com" } },
      { text: " now" }
    ]);
  });

  it("reports the link under the caret and its address", () => {
    const { editor, order, editables } = setup([
      { type: "paragraph", runs: [{ text: "go " }, { text: "here", marks: { link: "https://a.test" } }] }
    ]);
    editor.focusBlock(order()[0], "start");
    selectRange(editables()[0], 4, 4);
    expect(editor.getLinkInfo()).toMatchObject({ canLink: true, inLink: true, url: "https://a.test", text: "here" });
    selectRange(editables()[0], 1, 1);
    expect(editor.getLinkInfo()).toMatchObject({ canLink: true, inLink: false, url: "" });
  });

  it("edits the address of an existing link from a caret inside it", () => {
    const { editor, order, block, editables } = setup([
      { type: "paragraph", runs: [{ text: "go " }, { text: "here", marks: { link: "https://a.test" } }] }
    ]);
    editor.focusBlock(order()[0], "start");
    selectRange(editables()[0], 5, 5);
    editor.setLink("https://b.test");
    expect(block(order()[0]).runs).toEqual([{ text: "go " }, { text: "here", marks: { link: "https://b.test" } }]);
  });

  it("edits the displayed text of an existing link", () => {
    const { editor, order, block, editables } = setup([
      { type: "paragraph", runs: [{ text: "go " }, { text: "here", marks: { link: "https://a.test" } }] }
    ]);
    editor.focusBlock(order()[0], "start");
    selectRange(editables()[0], 5, 5);
    editor.setLink("https://a.test", "there");
    expect(block(order()[0]).runs).toEqual([{ text: "go " }, { text: "there", marks: { link: "https://a.test" } }]);
  });

  it("removes a link but keeps its text", () => {
    const { editor, order, block, editables } = setup([
      { type: "paragraph", runs: [{ text: "go " }, { text: "here", marks: { link: "https://a.test" } }] }
    ]);
    editor.focusBlock(order()[0], "start");
    selectRange(editables()[0], 5, 5);
    editor.setLink("");
    expect(block(order()[0]).runs).toEqual([{ text: "go here" }]);
  });

  it("replaces links that a selection overlaps with one link", () => {
    const { editor, order, block, editables } = setup([
      {
        type: "paragraph",
        runs: [
          { text: "ab", marks: { link: "https://a.test" } },
          { text: "cd" },
          { text: "ef", marks: { link: "https://b.test" } }
        ]
      }
    ]);
    editor.focusBlock(order()[0], "start");
    selectRange(editables()[0], 1, 5);
    editor.setLink("https://c.test");
    expect(block(order()[0]).runs.map((r) => [r.text, r.marks?.link])).toEqual([
      ["a", "https://a.test"],
      ["bcde", "https://c.test"],
      ["f", "https://b.test"]
    ]);
  });

  it("inserts a new link at a bare caret", () => {
    const { editor, order, block, editables } = setup([{ type: "paragraph", runs: [{ text: "see " }] }]);
    editor.focusBlock(order()[0], "end");
    selectRange(editables()[0], 4, 4);
    editor.setLink("example.com", "the site");
    expect(block(order()[0]).runs).toEqual([
      { text: "see " },
      { text: "the site", marks: { link: "https://example.com" } }
    ]);
  });

  it("uses the address as the text when none is given at a caret", () => {
    const { editor, order, block, editables } = setup([{ type: "paragraph", runs: [{ text: "x" }] }]);
    editor.focusBlock(order()[0], "end");
    selectRange(editables()[0], 1, 1);
    editor.setLink("example.com");
    expect(block(order()[0]).runs.at(-1)).toEqual({ text: "https://example.com", marks: { link: "https://example.com" } });
  });

  it("links every selected block", () => {
    const { editor, order, block, editables } = setup([
      { type: "paragraph", runs: [{ text: "one" }] },
      { type: "paragraph", runs: [{ text: "two" }] }
    ]);
    editor.focusBlock(order()[0], "start");
    editables()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    editables()[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true })
    );
    expect(editor.getLinkInfo()).toMatchObject({ canLink: true, wholeBlocks: true });
    editor.setLink("https://all.test");
    expect(block(order()[0]).runs).toEqual([{ text: "one", marks: { link: "https://all.test" } }]);
    expect(block(order()[1]).runs).toEqual([{ text: "two", marks: { link: "https://all.test" } }]);
  });

  it("opens the link form prefilled", () => {
    const { editor, order, editables } = setup([
      { type: "paragraph", runs: [{ text: "go " }, { text: "here", marks: { link: "https://a.test" } }] }
    ]);
    editor.focusBlock(order()[0], "start");
    selectRange(editables()[0], 5, 5);
    expect(editor.openLinkEditor()).toBe(true);
    const input = document.querySelector('[data-role="link-input"]');
    expect(input?.value).toBe("https://a.test");
    expect(document.querySelector('[data-role="link-text-input"]')?.value).toBe("here");
    input.value = "https://c.test";
    document.querySelector(".popover-apply").click();
    expect(editor.element.querySelector("a")?.getAttribute("href")).toBe("https://c.test");
  });

  it("shows a card with the address when a link is clicked", () => {
    const { editor, order, block, editables } = setup([
      { type: "paragraph", runs: [{ text: "go " }, { text: "here", marks: { link: "https://a.test" } }] }
    ]);
    editor.focusBlock(order()[0], "start");
    editor.element.querySelector("a").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const card = document.querySelector(".link-card");
    expect(card?.querySelector('[data-role="link-open"]')?.getAttribute("href")).toBe("https://a.test");
    card.querySelector('[data-action="link-unlink"]').click();
    expect(block(order()[0]).runs).toEqual([{ text: "go here" }]);
    expect(editables()[0].querySelector("a")).toBeNull();
  });

  it("opens the editor from the link card", () => {
    const { editor, order } = setup([
      { type: "paragraph", runs: [{ text: "here", marks: { link: "https://a.test" } }] }
    ]);
    editor.focusBlock(order()[0], "start");
    const anchor = editor.element.querySelector("a");
    selectRange(editor.element.querySelector("[contenteditable=true]"), 1, 1);
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.querySelector('[data-action="link-edit"]').click();
    expect(document.querySelector('[data-role="link-input"]')?.value).toBe("https://a.test");
  });
});

describe("clicking below the last block", () => {
  const press = (editor) =>
    editor.element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 9999 }));

  it("adds a paragraph after text and puts the caret in it", () => {
    const { editor, order, block } = setup([{ type: "paragraph", runs: [{ text: "end" }] }]);
    press(editor);
    expect(order()).toHaveLength(2);
    expect(block(order()[1])).toMatchObject({ type: "paragraph" });
    expect(document.activeElement?.getAttribute("data-block-id")).toBe(order()[1]);
  });

  it("adds a paragraph after a non-text block", () => {
    const { editor, order, block } = setup([{ type: "divider" }]);
    press(editor);
    expect(order()).toHaveLength(2);
    expect(block(order()[1]).type).toBe("paragraph");
  });

  it("reuses an empty trailing paragraph instead of piling up new ones", () => {
    const { editor, order } = setup([
      { type: "paragraph", runs: [{ text: "end" }] },
      { type: "paragraph", runs: [] }
    ]);
    press(editor);
    press(editor);
    expect(order()).toHaveLength(2);
    expect(document.activeElement?.getAttribute("data-block-id")).toBe(order()[1]);
  });
});

describe("page links share the link control", () => {
  const withPages = (blocks, options) => {
    const made = setup(blocks, { resolvePageTitle: undefined, ...options });
    made.ws.dispatch("createPage", { type: "sheet", title: "Budget" });
    made.ws.dispatch("createPage", { type: "document", title: "Meeting notes" });
    const find = (title) => made.ws.getPages().find((page) => page.title === title).id;
    return { ...made, find };
  };
  const rows = () => [...document.querySelectorAll('[data-role="link-page"]')];

  it("tells page links from web addresses", () => {
    expect(pageIdOfLink("#document_k3v8m2w9x1q4o")).toBe("document_k3v8m2w9x1q4o");
    expect(pageIdOfLink("#top")).toBe("");
    expect(pageIdOfLink("https://a.test/#document_abc")).toBe("");
    expect(pageLinkUrl("sheet_abc")).toBe("#sheet_abc");
  });

  it("lists every page in the form and narrows them as the user types", () => {
    const { editor, order } = withPages([{ type: "paragraph", runs: [{ text: "see " }] }]);
    editor.focusBlock(order()[0], "end");
    editor.openLinkEditor();
    expect(rows().map((row) => row.textContent)).toEqual(["Doc", "Budget", "Meeting notes"]);
    const input = document.querySelector('[data-role="link-input"]');
    input.value = "bud";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rows().map((row) => row.textContent)).toEqual(["Budget"]);
  });

  it("links a page picked from the list, with the title as the text", () => {
    const { editor, order, block, find } = withPages([{ type: "paragraph", runs: [{ text: "see " }] }]);
    editor.focusBlock(order()[0], "end");
    editor.openLinkEditor();
    rows().find((row) => row.textContent === "Budget").click();
    expect(document.querySelector('[data-role="link-input"]').value).toBe("Budget");
    expect(document.querySelector('[data-role="link-text-input"]').value).toBe("Budget");
    document.querySelector(".popover-apply").click();
    expect(block(order()[0]).runs.at(-1)).toEqual({ text: "Budget", marks: { link: `#${find("Budget")}` } });
  });

  it("keeps text the user typed when a page is picked", () => {
    const { editor, order, block, find } = withPages([{ type: "paragraph", runs: [{ text: "see " }] }]);
    editor.focusBlock(order()[0], "end");
    editor.openLinkEditor();
    document.querySelector('[data-role="link-text-input"]').value = "the numbers";
    rows().find((row) => row.textContent === "Budget").click();
    document.querySelector(".popover-apply").click();
    expect(block(order()[0]).runs.at(-1)).toEqual({ text: "the numbers", marks: { link: `#${find("Budget")}` } });
  });

  it("takes the first matching page when words rather than an address are entered", () => {
    const { editor, order, block, find } = withPages([{ type: "paragraph", runs: [{ text: "see " }] }]);
    editor.focusBlock(order()[0], "end");
    editor.openLinkEditor();
    const input = document.querySelector('[data-role="link-input"]');
    input.value = "meeting";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector(".popover-apply").click();
    expect(block(order()[0]).runs.at(-1).marks.link).toBe(`#${find("Meeting notes")}`);
  });

  it("still links a web address from the same field", () => {
    const { editor, order, block } = withPages([{ type: "paragraph", runs: [{ text: "see " }] }]);
    editor.focusBlock(order()[0], "end");
    editor.openLinkEditor();
    const input = document.querySelector('[data-role="link-input"]');
    input.value = "example.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector('[data-role="link-text-input"]').value = "site";
    document.querySelector(".popover-apply").click();
    expect(block(order()[0]).runs.at(-1)).toEqual({ text: "site", marks: { link: "https://example.com" } });
  });

  it("links selected text to a page", () => {
    const { editor, order, block, editables, find } = withPages([{ type: "paragraph", runs: [{ text: "open the budget now" }] }]);
    editor.focusBlock(order()[0], "start");
    selectRange(editables()[0], 9, 15);
    editor.openLinkEditor();
    expect(document.querySelector('[data-role="link-text-input"]')).toBeNull();
    rows().find((row) => row.textContent === "Budget").click();
    document.querySelector(".popover-apply").click();
    expect(block(order()[0]).runs[1]).toEqual({ text: "budget", marks: { link: `#${find("Budget")}` } });
  });

  it("opens the form on the chosen page when a page link is edited", () => {
    const { editor, order, find } = withPages([{ type: "paragraph", runs: [{ text: "x" }] }]);
    editor.focusBlock(order()[0], "end");
    editor.setLink(`#${find("Budget")}`, "Budget");
    selectRange(editor.element.querySelector("[contenteditable=true]"), 3, 3);
    editor.openLinkEditor();
    expect(document.querySelector('[data-role="link-input"]').value).toBe("Budget");
    expect(document.querySelector(".link-page-item.is-selected")?.textContent).toBe("Budget");
  });

  it("uses the page title as the text when none is given", () => {
    const { editor, order, block, find } = withPages([{ type: "paragraph", runs: [{ text: "x" }] }], {
      resolvePageTitle: (id) => (id ? "Budget" : undefined)
    });
    editor.focusBlock(order()[0], "end");
    selectRange(editor.element.querySelector("[contenteditable=true]"), 1, 1);
    editor.setLink(`#${find("Budget")}`);
    expect(block(order()[0]).runs.at(-1)).toEqual({ text: "Budget", marks: { link: `#${find("Budget")}` } });
  });

  it("shows the page on the card and goes there", () => {
    const visited = [];
    const { editor, order, find } = withPages(
      [{ type: "paragraph", runs: [{ text: "see " }] }],
      { navigate: (id) => visited.push(id) }
    );
    editor.focusBlock(order()[0], "end");
    editor.setLink(`#${find("Budget")}`, "numbers");
    editor.element.querySelector("a").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const open = document.querySelector('[data-role="link-open-page"]');
    expect(open.textContent).toBe("Budget");
    expect(document.querySelector('[data-role="link-open"]')).toBeNull();
    open.click();
    expect(visited).toEqual([find("Budget")]);
    expect(document.querySelector(".link-card")).toBeNull();
  });

  it("goes to the page on Cmd/Ctrl+click without a card", () => {
    const visited = [];
    const { editor, order, find } = withPages(
      [{ type: "paragraph", runs: [{ text: "see " }] }],
      { navigate: (id) => visited.push(id) }
    );
    editor.focusBlock(order()[0], "end");
    editor.setLink(`#${find("Budget")}`, "numbers");
    editor.element.querySelector("a").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    expect(visited).toEqual([find("Budget")]);
    expect(document.querySelector(".link-card")).toBeNull();
  });

  it("says so on the card when the page was removed", () => {
    const { editor, order } = withPages([{ type: "paragraph", runs: [{ text: "see " }] }]);
    editor.focusBlock(order()[0], "end");
    editor.setLink("#document_gone0000000a", "old page");
    editor.element.querySelector("a").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(document.querySelector('[data-role="link-missing"]')?.textContent).toBe("Page removed");
  });

  it("opens the page behind an existing page-link block when it is clicked", () => {
    const visited = [];
    const { editor, find, ws, pageId } = withPages([], { navigate: (id) => visited.push(id) });
    ws.dispatch("insertBlock", { pageId, block: { type: "pageLink", pageId: find("Budget") } });
    editor.element.querySelector("a.page-link").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(visited).toEqual([find("Budget")]);
  });

  it("offers pages to the standalone form builder", () => {
    const { ws } = withPages([]);
    const pages = linkPages(ws);
    expect(pages.map((page) => page.title)).toEqual(["Doc", "Budget", "Meeting notes"]);
    const applied = [];
    const form = buildLinkForm({
      info: { canLink: true, inLink: false, url: "", text: "", hasSelection: true, wholeBlocks: false },
      pages,
      onApply: (value) => applied.push(value),
      onRemove() {},
      close() {}
    });
    document.body.append(form);
    form.querySelector('[data-page-id="' + pages[1].id + '"]').click();
    form.querySelector(".popover-apply").click();
    expect(applied).toEqual([{ url: `#${pages[1].id}`, text: "" }]);
  });
});
