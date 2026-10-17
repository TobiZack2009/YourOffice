import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { CommandError } from "../src/core/errors.js";

/** Store with document commands + one document page. */
function setup() {
  const ws = Workspace.create({ title: "Docs" });
  registerDocumentCommands(ws);
  ws.dispatch("createPage", { type: "document", title: "Notes" });
  const pageId = ws.getChildren(null)[0];
  return { ws, pageId };
}

/** @param {Workspace} ws @param {string} pageId */
const content = (ws, pageId) => /** @type {import("../src/document/model.js").DocumentContent} */ (ws.getPage(pageId)?.content);

describe("insertBlock", () => {
  it("appends blocks and assigns stable ids", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "Hello" }] } });
    ws.dispatch("insertBlock", { pageId, block: { type: "divider" } });
    const c = content(ws, pageId);
    expect(c.blockOrder).toHaveLength(2);
    expect(c.blocks[c.blockOrder[0]].runs).toEqual([{ text: "Hello" }]);
    expect(c.blocks[c.blockOrder[1]].type).toBe("divider");
  });

  it("positions relative to neighbours and by index", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "one" }] } });
    const first = content(ws, pageId).blockOrder[0];
    ws.dispatch("insertBlock", {
      pageId,
      block: { type: "paragraph", runs: [{ text: "after" }] },
      afterBlockId: first
    });
    ws.dispatch("insertBlock", {
      pageId,
      block: { type: "paragraph", runs: [{ text: "before" }] },
      beforeBlockId: first
    });
    const order = content(ws, pageId).blockOrder;
    expect(content(ws, pageId).blocks[order[0]].runs[0].text).toBe("before");
    expect(order[1]).toBe(first);
    expect(content(ws, pageId).blocks[order[2]].runs[0].text).toBe("after");
  });

  it("initialises content on first insert", () => {
    const { ws, pageId } = setup();
    expect(ws.getPage(pageId)?.content).toBeUndefined();
    ws.dispatch("insertBlock", { pageId, block: { type: "divider" } });
    expect(content(ws, pageId).blockOrder).toHaveLength(1);
  });

  it("rejects invalid blocks, pages and neighbours", () => {
    const { ws, pageId } = setup();
    expect(() => ws.dispatch("insertBlock", { pageId, block: { type: "video" } })).toThrow(
      CommandError
    );
    expect(() => ws.dispatch("insertBlock", { pageId: "nope", block: { type: "divider" } })).toThrow(
      /does not exist/
    );
    expect(() =>
      ws.dispatch("insertBlock", { pageId, block: { type: "divider" }, afterBlockId: "nope" })
    ).toThrow(/afterBlockId/);
  });

  it("refuses non-document pages", () => {
    const { ws } = setup();
    ws.dispatch("createPage", { type: "sheet", title: "Budget" });
    const sheetId = ws.getChildren(null)[1];
    expect(() => ws.dispatch("insertBlock", { pageId: sheetId, block: { type: "divider" } })).toThrow(
      /not a document/
    );
  });
});

describe("updateBlock and setBlockRuns", () => {
  it("patches fields, preserving identity and type", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "heading", level: 1, runs: [{ text: "T" }] } });
    const blockId = content(ws, pageId).blockOrder[0];
    ws.dispatch("updateBlock", { pageId, blockId, patch: { level: 3 } });
    const block = content(ws, pageId).blocks[blockId];
    expect(block.id).toBe(blockId);
    expect(block.type).toBe("heading");
    expect(block.level).toBe(3);
  });

  it("rejects invalid patches", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "heading", level: 1 } });
    const blockId = content(ws, pageId).blockOrder[0];
    expect(() => ws.dispatch("updateBlock", { pageId, blockId, patch: { level: 9 } })).toThrow(
      /level/
    );
    // type cannot be changed through updateBlock
    ws.dispatch("updateBlock", { pageId, blockId, patch: { type: "divider" } });
    expect(content(ws, pageId).blocks[blockId].type).toBe("heading");
  });

  it("replaces runs and validates them", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "paragraph" } });
    const blockId = content(ws, pageId).blockOrder[0];
    ws.dispatch("setBlockRuns", {
      pageId,
      blockId,
      runs: [{ text: "bold", marks: { bold: true } }]
    });
    expect(content(ws, pageId).blocks[blockId].runs).toEqual([
      { text: "bold", marks: { bold: true } }
    ]);
    expect(() => ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: "" }] })).toThrow(
      CommandError
    );
  });

  it("refuses runs on code blocks", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "code", text: "let x" } });
    const blockId = content(ws, pageId).blockOrder[0];
    expect(() => ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: "x" }] })).toThrow(
      /does not carry runs/
    );
  });
});

describe("deleteBlock and moveBlock", () => {
  const addThree = (ws, pageId) => {
    for (const text of ["a", "b", "c"]) {
      ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text }] } });
    }
    return content(ws, pageId).blockOrder;
  };

  it("deletes from registry and order", () => {
    const { ws, pageId } = setup();
    const [a, b] = addThree(ws, pageId);
    ws.dispatch("deleteBlock", { pageId, blockId: b });
    const c = content(ws, pageId);
    expect(c.blockOrder).toEqual([a, c.blockOrder[1]]);
    expect(c.blocks[b]).toBeUndefined();
  });

  it("reorders blocks", () => {
    const { ws, pageId } = setup();
    const [a, , c] = addThree(ws, pageId);
    ws.dispatch("moveBlock", { pageId, blockId: c, index: 0 });
    expect(content(ws, pageId).blockOrder[0]).toBe(c);
    expect(content(ws, pageId).blockOrder[1]).toBe(a);
  });

  it("rejects out-of-range moves", () => {
    const { ws, pageId } = setup();
    const [a] = addThree(ws, pageId);
    expect(() => ws.dispatch("moveBlock", { pageId, blockId: a, index: 9 })).toThrow(
      /out of range/
    );
  });
});

describe("addListItem", () => {
  it("appends items with stable ids and empty runs by default", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "list", ordered: false } });
    const listId = content(ws, pageId).blockOrder[0];
    ws.dispatch("addListItem", { pageId, blockId: listId });
    ws.dispatch("addListItem", { pageId, blockId: listId, runs: [{ text: "milk" }] });
    const items = content(ws, pageId).blocks[listId].items;
    expect(items).toHaveLength(2);
    expect(items[0].id).toMatch(/^item_/);
    expect(items[0].runs).toEqual([]);
    expect(items[1].runs).toEqual([{ text: "milk" }]);
  });
});

describe("changeBlockType", () => {
  it("converts a paragraph to a heading, preserving text", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "Title" }] } });
    const blockId = content(ws, pageId).blockOrder[0];
    ws.dispatch("changeBlockType", { pageId, blockId, type: "heading" });
    const block = content(ws, pageId).blocks[blockId];
    expect(block.id).toBe(blockId);
    expect(block.type).toBe("heading");
    expect(block.level).toBe(1);
    expect(block.runs).toEqual([{ text: "Title" }]);
  });

  it("converts a paragraph to code, flattening runs to text", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", {
      pageId,
      block: { type: "paragraph", runs: [{ text: "a" }, { text: "b", marks: { bold: true } }] }
    });
    const blockId = content(ws, pageId).blockOrder[0];
    ws.dispatch("changeBlockType", { pageId, blockId, type: "code" });
    const block = content(ws, pageId).blocks[blockId];
    expect(block.type).toBe("code");
    expect(block.text).toBe("ab");
  });

  it("converts code back to a paragraph run", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "code", text: "let x = 1" } });
    const blockId = content(ws, pageId).blockOrder[0];
    ws.dispatch("changeBlockType", { pageId, blockId, type: "paragraph" });
    expect(content(ws, pageId).blocks[blockId].runs).toEqual([{ text: "let x = 1" }]);
  });

  it("converts a paragraph to a list with one item", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "milk" }] } });
    const blockId = content(ws, pageId).blockOrder[0];
    ws.dispatch("changeBlockType", { pageId, blockId, type: "list" });
    const block = content(ws, pageId).blocks[blockId];
    expect(block.type).toBe("list");
    expect(block.items).toHaveLength(1);
    expect(block.items[0].runs).toEqual([{ text: "milk" }]);
  });

  it("converts to a divider, dropping content", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "x" }] } });
    const blockId = content(ws, pageId).blockOrder[0];
    ws.dispatch("changeBlockType", { pageId, blockId, type: "divider" });
    const block = content(ws, pageId).blocks[blockId];
    expect(block.type).toBe("divider");
    expect(block.runs).toBeUndefined();
  });

  it("is a no-op when the type is unchanged and rejects unknown types", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "x" }] } });
    const blockId = content(ws, pageId).blockOrder[0];
    ws.dispatch("changeBlockType", { pageId, blockId, type: "paragraph" });
    expect(content(ws, pageId).blocks[blockId].type).toBe("paragraph");
    expect(() => ws.dispatch("changeBlockType", { pageId, blockId, type: "video" })).toThrow(
      CommandError
    );
  });
});

describe("document commands integrate with transactions and history", () => {
  it("undo restores block edits", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "one" }] } });
    expect(content(ws, pageId).blockOrder).toHaveLength(1);
    ws.undo();
    expect(ws.getPage(pageId)?.content).toBeUndefined();
    ws.redo();
    expect(content(ws, pageId).blockOrder).toHaveLength(1);
    expect(ws.dirty).toBe(true);
  });

  it("groups document edits into one transaction", () => {
    const { ws, pageId } = setup();
    ws.transact("compose", () => {
      ws.dispatch("insertBlock", { pageId, block: { type: "heading", level: 1 } });
      const headingId = content(ws, pageId).blockOrder[0];
      ws.dispatch("insertBlock", {
        pageId,
        block: { type: "paragraph", runs: [{ text: "body" }] },
        afterBlockId: headingId
      });
    });
    expect(content(ws, pageId).blockOrder).toHaveLength(2);
    ws.undo();
    expect(ws.getPage(pageId)?.content).toBeUndefined();
  });

  it("returns isolated copies of page content", () => {
    const { ws, pageId } = setup();
    ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "safe" }] } });
    const copy = content(ws, pageId);
    copy.blocks[copy.blockOrder[0]].runs[0].text = "tampered";
    expect(content(ws, pageId).blocks[content(ws, pageId).blockOrder[0]].runs[0].text).toBe("safe");
  });

  it("touches the page modifiedAt", () => {
    vi.useFakeTimers();
    try {
      const { ws, pageId } = setup();
      const before = ws.getPage(pageId)?.modifiedAt;
      vi.advanceTimersByTime(5);
      ws.dispatch("insertBlock", { pageId, block: { type: "divider" } });
      expect(ws.getPage(pageId)?.modifiedAt).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
