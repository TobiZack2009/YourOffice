import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import {
  canIndentBlock,
  canIndentItem,
  canOutdentBlock,
  collectDescendants,
  findContainer,
  validateDocumentContent
} from "../src/document/model.js";

function setup() {
  const ws = createWorkspace({ title: "Docs" });
  ws.dispatch("createPage", { type: "document", title: "Notes" });
  const pageId = ws.getChildren(null)[0];
  ws.dispatch("setPageContent", { pageId, content: { blockOrder: [], blocks: {} } });
  const content = () => ws.getPage(pageId).content;
  return { ws, pageId, content };
}

/** Insert a list with the given item texts; returns { listId, itemIds }. */
function addList(ctx, texts, ordered = false) {
  const { ws, pageId, content } = ctx;
  ws.dispatch("insertBlock", {
    pageId,
    newBlockId: `block_list${content().blockOrder.length}`,
    block: {
      type: "list",
      ordered,
      items: texts.map((text, i) => ({ id: `item_${text}${i}`, runs: text ? [{ text }] : [] }))
    }
  });
  const listId = content().blockOrder[content().blockOrder.length - 1];
  return { listId, itemIds: content().blocks[listId].items.map((item) => item.id) };
}

function addPara(ctx, text, extra = {}) {
  ctx.ws.dispatch("insertBlock", {
    pageId: ctx.pageId,
    block: { type: "paragraph", runs: text ? [{ text }] : [] },
    ...extra
  });
}

const texts = (block) => block.items.map((item) => item.runs.map((r) => r.text).join(""));
const valid = (ctx) => expect(validateDocumentContent(ctx.content())).toEqual([]);

describe("nested model", () => {
  it("validates children reachability and shape", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a"]);
    ctx.ws.dispatch("insertBlock", {
      pageId: ctx.pageId,
      block: { type: "quote", runs: [{ text: "q" }] },
      parent: { blockId: listId, itemId: itemIds[0] },
      newBlockId: "block_q"
    });
    valid(ctx);
    expect(ctx.content().blockOrder).toEqual([listId]);
    expect(findContainer(ctx.content(), "block_q")).toMatchObject({
      parent: { blockId: listId, itemId: itemIds[0] },
      index: 0
    });

    const broken = structuredClone(ctx.content());
    broken.blocks[listId].items[0].children = ["block_missing"];
    expect(validateDocumentContent(broken).join()).toContain("missing block");
    const dup = structuredClone(ctx.content());
    dup.blockOrder.push("block_q");
    expect(validateDocumentContent(dup).join()).toContain("more than once");
    const bad = structuredClone(ctx.content());
    bad.blocks[listId].items[0].children = [1];
    expect(validateDocumentContent(bad).join()).toContain("children");
  });

  it("reports blocks that are no longer reachable", () => {
    const ctx = setup();
    const { listId } = addList(ctx, ["a"]);
    addPara(ctx, "x", { newBlockId: "block_x" });
    const orphan = structuredClone(ctx.content());
    orphan.blockOrder = [listId];
    expect(validateDocumentContent(orphan).join()).toContain("not reachable");
  });
});

describe("insertBlock into containers", () => {
  it("inserts after/before a nested block within its container", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a"]);
    const parent = { blockId: listId, itemId: itemIds[0] };
    addPara(ctx, "one", { parent, newBlockId: "block_one" });
    addPara(ctx, "three", { parent, newBlockId: "block_three" });
    addPara(ctx, "two", { afterBlockId: "block_one", newBlockId: "block_two" });
    addPara(ctx, "zero", { beforeBlockId: "block_one", newBlockId: "block_zero" });
    expect(ctx.content().blocks[listId].items[0].children).toEqual([
      "block_zero",
      "block_one",
      "block_two",
      "block_three"
    ]);
    expect(ctx.content().blockOrder).toEqual([listId]);
    valid(ctx);
  });

  it("rejects an existing newBlockId", () => {
    const ctx = setup();
    addPara(ctx, "a", { newBlockId: "block_a" });
    expect(() => addPara(ctx, "b", { newBlockId: "block_a" })).toThrow(/already exists/);
  });
});

describe("deleteBlock / moveBlock with nesting", () => {
  it("deletes nested descendants and removes from the parent item", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b"]);
    ctx.ws.dispatch("indentListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[1] });
    const nestedId = ctx.content().blocks[listId].items[0].children[0];
    ctx.ws.dispatch("deleteBlock", { pageId: ctx.pageId, blockId: nestedId });
    expect(ctx.content().blocks[listId].items[0].children).toEqual([]);
    expect(ctx.content().blocks[nestedId]).toBeUndefined();
    valid(ctx);

    ctx.ws.dispatch("deleteBlock", { pageId: ctx.pageId, blockId: listId });
    expect(Object.keys(ctx.content().blocks)).toEqual([]);
  });

  it("moves a nested block inside its own container", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a"]);
    const parent = { blockId: listId, itemId: itemIds[0] };
    addPara(ctx, "1", { parent, newBlockId: "block_1" });
    addPara(ctx, "2", { parent, newBlockId: "block_2" });
    ctx.ws.dispatch("moveBlock", { pageId: ctx.pageId, blockId: "block_2", index: 0 });
    expect(ctx.content().blocks[listId].items[0].children).toEqual(["block_2", "block_1"]);
  });
});

describe("changeBlockType and lists", () => {
  it("seeds an item when converting an empty paragraph to a list", () => {
    const ctx = setup();
    addPara(ctx, "", { newBlockId: "block_p" });
    ctx.ws.dispatch("changeBlockType", { pageId: ctx.pageId, blockId: "block_p", type: "list" });
    expect(ctx.content().blocks.block_p.items).toHaveLength(1);
    valid(ctx);
  });

  it("keeps nested blocks as siblings when a list becomes a paragraph", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a"]);
    addPara(ctx, "n", { parent: { blockId: listId, itemId: itemIds[0] }, newBlockId: "block_n" });
    ctx.ws.dispatch("changeBlockType", { pageId: ctx.pageId, blockId: listId, type: "paragraph" });
    expect(ctx.content().blockOrder).toEqual([listId, "block_n"]);
    valid(ctx);
  });
});

describe("extractListItem", () => {
  it("splits a list around the extracted item", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b", "c"], true);
    ctx.ws.dispatch("extractListItem", {
      pageId: ctx.pageId,
      blockId: listId,
      itemId: itemIds[1],
      type: "quote",
      newBlockId: "block_new"
    });
    const order = ctx.content().blockOrder;
    expect(order).toHaveLength(3);
    expect(order[0]).toBe(listId);
    expect(order[1]).toBe("block_new");
    expect(texts(ctx.content().blocks[listId])).toEqual(["a"]);
    expect(texts(ctx.content().blocks[order[2]])).toEqual(["c"]);
    expect(ctx.content().blocks[order[2]].ordered).toBe(true);
    expect(ctx.content().blocks.block_new).toMatchObject({ type: "quote", runs: [{ text: "b" }] });
    valid(ctx);
  });

  it("handles first, last and only items", () => {
    const first = setup();
    const a = addList(first, ["a", "b"]);
    first.ws.dispatch("extractListItem", { pageId: first.pageId, blockId: a.listId, itemId: a.itemIds[0], type: "heading", fields: { level: 2 }, newBlockId: "block_h" });
    expect(first.content().blockOrder).toEqual(["block_h", a.listId]);
    expect(first.content().blocks.block_h.level).toBe(2);
    valid(first);

    const last = setup();
    const b = addList(last, ["a", "b"]);
    last.ws.dispatch("extractListItem", { pageId: last.pageId, blockId: b.listId, itemId: b.itemIds[1], type: "paragraph", newBlockId: "block_p" });
    expect(last.content().blockOrder).toEqual([b.listId, "block_p"]);

    const only = setup();
    const c = addList(only, ["a"]);
    only.ws.dispatch("extractListItem", { pageId: only.pageId, blockId: c.listId, itemId: c.itemIds[0], type: "code", newBlockId: "block_c" });
    expect(only.content().blockOrder).toEqual(["block_c"]);
    expect(only.content().blocks.block_c.text).toBe("a");
    expect(only.content().blocks[c.listId]).toBeUndefined();
    valid(only);
  });

  it("places the item's nested blocks after the new block", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b"]);
    addPara(ctx, "n", { parent: { blockId: listId, itemId: itemIds[0] }, newBlockId: "block_n" });
    ctx.ws.dispatch("extractListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[0], type: "paragraph", newBlockId: "block_p" });
    expect(ctx.content().blockOrder.slice(0, 2)).toEqual(["block_p", "block_n"]);
    valid(ctx);
  });

  it("extracts from a nested list into the parent item's children", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b"]);
    ctx.ws.dispatch("indentListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[1] });
    const nestedId = ctx.content().blocks[listId].items[0].children[0];
    ctx.ws.dispatch("extractListItem", { pageId: ctx.pageId, blockId: nestedId, itemId: itemIds[1], type: "quote", newBlockId: "block_q" });
    expect(ctx.content().blocks[listId].items[0].children).toEqual(["block_q"]);
    valid(ctx);
  });

  it("rejects bad targets", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a"]);
    expect(() => ctx.ws.dispatch("extractListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[0], type: "list" })).toThrow();
    expect(() => ctx.ws.dispatch("extractListItem", { pageId: ctx.pageId, blockId: listId, itemId: "nope", type: "paragraph" })).toThrow(/does not exist/);
  });
});

describe("deleteListItem", () => {
  it("removes the item with its nested blocks and the list when emptied", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b"]);
    addPara(ctx, "n", { parent: { blockId: listId, itemId: itemIds[0] }, newBlockId: "block_n" });
    ctx.ws.dispatch("deleteListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[0] });
    expect(texts(ctx.content().blocks[listId])).toEqual(["b"]);
    expect(ctx.content().blocks.block_n).toBeUndefined();
    ctx.ws.dispatch("deleteListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[1] });
    expect(ctx.content().blockOrder).toEqual([]);
    expect(ctx.content().blocks).toEqual({});
  });
});

describe("indent / outdent list items", () => {
  it("indents under the previous item and reuses a trailing nested list", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b", "c"]);
    expect(canIndentItem(ctx.content(), listId, itemIds[0])).toBe(false);
    expect(canIndentItem(ctx.content(), listId, itemIds[1])).toBe(true);
    ctx.ws.dispatch("indentListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[1] });
    ctx.ws.dispatch("indentListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[2] });
    const list = ctx.content().blocks[listId];
    expect(texts(list)).toEqual(["a"]);
    expect(list.items[0].children).toHaveLength(1);
    expect(texts(ctx.content().blocks[list.items[0].children[0]])).toEqual(["b", "c"]);
    valid(ctx);
    expect(() => ctx.ws.dispatch("indentListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[0] })).toThrow(/first list item/);
  });

  it("outdents a nested item, adopting later siblings", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b", "c", "d"]);
    for (const id of itemIds.slice(1)) ctx.ws.dispatch("indentListItem", { pageId: ctx.pageId, blockId: listId, itemId: id });
    const nestedId = ctx.content().blocks[listId].items[0].children[0];
    ctx.ws.dispatch("outdentListItem", { pageId: ctx.pageId, blockId: nestedId, itemId: itemIds[2] });
    const list = ctx.content().blocks[listId];
    expect(texts(list)).toEqual(["a", "c"]);
    expect(texts(ctx.content().blocks[nestedId])).toEqual(["b"]);
    const adopted = ctx.content().blocks[list.items[1].children[0]];
    expect(texts(adopted)).toEqual(["d"]);
    valid(ctx);
  });

  it("removes the nested list when its only item is outdented", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b"]);
    ctx.ws.dispatch("indentListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[1] });
    const nestedId = ctx.content().blocks[listId].items[0].children[0];
    ctx.ws.dispatch("outdentListItem", { pageId: ctx.pageId, blockId: nestedId, itemId: itemIds[1] });
    expect(texts(ctx.content().blocks[listId])).toEqual(["a", "b"]);
    expect(ctx.content().blocks[nestedId]).toBeUndefined();
    expect(ctx.content().blocks[listId].items[0].children).toEqual([]);
    valid(ctx);
  });

  it("outdenting a top-level item turns it into a paragraph", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b"]);
    ctx.ws.dispatch("outdentListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[1], newBlockId: "block_p" });
    expect(ctx.content().blockOrder).toEqual([listId, "block_p"]);
    expect(ctx.content().blocks.block_p.type).toBe("paragraph");
  });
});

describe("indent / outdent blocks", () => {
  it("indents a block under the list above and outdents it again", () => {
    const ctx = setup();
    const { listId } = addList(ctx, ["a", "b"]);
    addPara(ctx, "x", { newBlockId: "block_x" });
    expect(canIndentBlock(ctx.content(), "block_x")).toBe(true);
    expect(canIndentBlock(ctx.content(), listId)).toBe(false);
    ctx.ws.dispatch("indentBlock", { pageId: ctx.pageId, blockId: "block_x" });
    expect(ctx.content().blockOrder).toEqual([listId]);
    expect(ctx.content().blocks[listId].items[1].children).toEqual(["block_x"]);
    expect(canOutdentBlock(ctx.content(), "block_x")).toBe(true);
    valid(ctx);
    ctx.ws.dispatch("outdentBlock", { pageId: ctx.pageId, blockId: "block_x" });
    expect(ctx.content().blockOrder).toEqual([listId, "block_x"]);
    expect(ctx.content().blocks[listId].items[1].children).toEqual([]);
    valid(ctx);
  });

  it("splits the list when outdenting from a middle item", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b"]);
    const parent = { blockId: listId, itemId: itemIds[0] };
    addPara(ctx, "x", { parent, newBlockId: "block_x" });
    addPara(ctx, "y", { parent, newBlockId: "block_y" });
    ctx.ws.dispatch("outdentBlock", { pageId: ctx.pageId, blockId: "block_x" });
    const order = ctx.content().blockOrder;
    expect(order.slice(0, 3)).toEqual([listId, "block_x", "block_y"]);
    expect(order).toHaveLength(4);
    expect(texts(ctx.content().blocks[listId])).toEqual(["a"]);
    expect(texts(ctx.content().blocks[order[3]])).toEqual(["b"]);
    valid(ctx);
  });

  it("rejects impossible indent / outdent", () => {
    const ctx = setup();
    addPara(ctx, "x", { newBlockId: "block_x" });
    expect(() => ctx.ws.dispatch("indentBlock", { pageId: ctx.pageId, blockId: "block_x" })).toThrow();
    expect(() => ctx.ws.dispatch("outdentBlock", { pageId: ctx.pageId, blockId: "block_x" })).toThrow();
  });

  it("collects descendants and supports undo of a nesting change", () => {
    const ctx = setup();
    const { listId, itemIds } = addList(ctx, ["a", "b"]);
    ctx.ws.dispatch("indentListItem", { pageId: ctx.pageId, blockId: listId, itemId: itemIds[1] });
    expect(collectDescendants(ctx.content(), listId)).toHaveLength(1);
    ctx.ws.undo();
    expect(texts(ctx.content().blocks[listId])).toEqual(["a", "b"]);
    valid(ctx);
  });
});
