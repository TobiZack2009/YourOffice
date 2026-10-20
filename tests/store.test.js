import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { CommandError } from "../src/core/errors.js";
describe("Workspace.create", () => {
  it("starts empty with metadata and a clean state", () => {
    const ws = Workspace.create({ title: "My Workspace" });
    expect(ws.title).toBe("My Workspace");
    expect(ws.id).toMatch(/^workspace_/);
    expect(ws.getPages()).toEqual([]);
    expect(ws.getChildren(null)).toEqual([]);
    expect(ws.dirty).toBe(false);
  });

  it("has ISO 8601 UTC timestamps", () => {
    const ws = Workspace.create();
    const doc = ws.serialized;
    expect(doc.metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("serialized state is a deep copy", () => {
    const ws = Workspace.create();
    ws.serialized.metadata.title = "tampered";
    expect(ws.title).toBe("");
  });
});

describe("createPage command", () => {
  it("creates a typed page and updates the hierarchy", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document", title: "Notes" });
    const pages = ws.getPages();
    expect(pages).toHaveLength(1);
    expect(pages[0].type).toBe("document");
    expect(pages[0].title).toBe("Notes");
    expect(pages[0].id).toMatch(/^document_/);
    expect(ws.getChildren(null)).toEqual([pages[0].id]);
  });

  it("uses prefixed ids per type", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "sheet" });
    ws.dispatch("createPage", { type: "presentation" });
    const ids = ws.getPages().map((p) => p.id);
    expect(ids[0]).toMatch(/^sheet_/);
    expect(ids[1]).toMatch(/^pres_/);
  });

  it("rejects unknown types", () => {
    const ws = Workspace.create();
    expect(() => ws.dispatch("createPage", { type: "spreadsheet" })).toThrow(CommandError);
    expect(ws.getPages()).toEqual([]);
    expect(ws.dirty).toBe(false);
  });

  it("nests under an existing parent at an index", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document", title: "Parent" });
    const parentId = ws.getChildren(null)[0];
    ws.dispatch("createPage", { type: "sheet", parentId, title: "Child" });
    ws.dispatch("createPage", { type: "document", parentId, title: "Child 2" });
    expect(ws.getChildren(parentId)).toHaveLength(2);
    ws.dispatch("movePage", { pageId: ws.getChildren(parentId)[1], index: 0 });
    expect(ws.getParent(ws.getChildren(parentId)[0])).toBe(parentId);
  });

  it("rejects an unknown parent without mutating", () => {
    const ws = Workspace.create();
    expect(() =>
      ws.dispatch("createPage", { type: "document", parentId: "nope" })
    ).toThrow(/does not exist/);
    expect(ws.getChildren(null)).toEqual([]);
  });

  it("rejects a bad index", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document" });
    expect(() => ws.dispatch("createPage", { type: "document", index: 5 })).toThrow(CommandError);
  });
});

describe("renamePage command", () => {
  it("renames and bumps page modifiedAt but keeps identity", () => {
    vi.useFakeTimers();
    try {
      const ws = Workspace.create();
      ws.dispatch("createPage", { type: "document", title: "Old" });
      const id = ws.getChildren(null)[0];
      const before = ws.getPage(id);
      vi.advanceTimersByTime(5);
      ws.dispatch("renamePage", { pageId: id, title: "New" });
      const after = ws.getPage(id);
      expect(after?.id).toBe(id);
      expect(after?.title).toBe("New");
      expect(after?.modifiedAt).not.toBe(before?.modifiedAt);
      expect(ws.dirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects missing pages", () => {
    const ws = Workspace.create();
    expect(() => ws.dispatch("renamePage", { pageId: "x", title: "New" })).toThrow(CommandError);
  });
});

describe("deletePage command", () => {
  const makeTree = () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document", title: "Root" });
    const rootId = ws.getChildren(null)[0];
    ws.dispatch("createPage", { type: "sheet", parentId: rootId, title: "Child" });
    const childId = ws.getChildren(rootId)[0];
    ws.dispatch("createPage", { type: "presentation", parentId: childId, title: "Grandchild" });
    return { ws, rootId, childId };
  };

  it("refuses to create orphans without cascade", () => {
    const { ws, rootId } = makeTree();
    expect(() => ws.dispatch("deletePage", { pageId: rootId })).toThrow(/cascade/);
  });

  it("cascades through the subtree and cleans the registry", () => {
    const { ws, rootId } = makeTree();
    ws.dispatch("deletePage", { pageId: rootId, cascade: true });
    expect(ws.getPages()).toEqual([]);
    expect(ws.getChildren(null)).toEqual([]);
    expect(ws.serialized.pageOrder).toEqual({ root: [] });
  });

  it("deleting a leaf keeps the rest", () => {
    const { ws, childId, rootId } = makeTree();
    const grandchildId = ws.getChildren(childId)[0];
    ws.dispatch("deletePage", { pageId: grandchildId });
    expect(ws.getPage(grandchildId)).toBeUndefined();
    expect(ws.getPage(childId)).toBeDefined();
    expect(ws.getPage(rootId)).toBeDefined();
    expect(ws.getChildren(childId)).toEqual([]);
  });
});

describe("movePage command", () => {
  it("moves pages across parents", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document", title: "A" });
    ws.dispatch("createPage", { type: "document", title: "B" });
    ws.dispatch("createPage", { type: "document", title: "A1", parentId: ws.getChildren(null)[0] });
    const [pageA, pageB] = ws.getChildren(null);
    const pageA1 = ws.getChildren(pageA)[0];
    ws.dispatch("movePage", { pageId: pageA1, newParentId: pageB });
    expect(ws.getChildren(pageB)).toEqual([pageA1]);
    expect(ws.getChildren(pageA)).toEqual([]);
    expect(ws.getParent(pageA1)).toBe(pageB);
  });

  it("forbids moving a page under its own descendant", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document", title: "A" });
    const a = ws.getChildren(null)[0];
    ws.dispatch("createPage", { type: "document", parentId: a, title: "A1" });
    const a1 = ws.getChildren(a)[0];
    expect(() =>
      ws.dispatch("movePage", { pageId: a, newParentId: a1 })
    ).toThrow(/under itself/);
  });

  it("supports reordering within the same parent", () => {
    const ws = Workspace.create();
    for (const title of ["A", "B", "C"]) {
      ws.dispatch("createPage", { type: "document", title });
    }
    const order = ws.getChildren(null);
    ws.dispatch("movePage", { pageId: order[2], index: 0 });
    expect(ws.getChildren(null)).toEqual([order[2], order[0], order[1]]);
  });
});

describe("transactions", () => {
  it("groups multiple commands into one history entry", () => {
    const ws = Workspace.create();
    ws.transact("batch", () => {
      ws.dispatch("createPage", { type: "document", title: "A" });
      ws.dispatch("createPage", { type: "document", title: "B" });
    });
    const events = [];
    ws.events.on("change", (e) => events.push(/** @type {unknown} */ (e)));
    ws.dispatch("renamePage", { pageId: ws.getChildren(null)[0], title: "A2" });
    expect(events).toHaveLength(1);
    // undo removes both -- rollback restores state before the batch
    expect(ws.undo()).toBe(true);
    expect(ws.getPages()).toHaveLength(2);
  });

  it("rolls back when a command throws mid-transaction", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document", title: "Keep" });
    const before = ws.serialized;
    expect(() =>
      ws.transact("batch", () => {
        ws.dispatch("createPage", { type: "document", title: "Discard" });
        ws.dispatch("createPage", /** @type {never} */ ({ type: "bogus" }));
      })
    ).toThrow(CommandError);
    expect(ws.serialized).toEqual(before);
    expect(ws.getPages()).toHaveLength(1);
    // nothing leaked into history: the only commit is the earlier "Keep" page,
    // so a single undo reaches the empty pre-"Keep" state
    ws.undo();
    expect(ws.getPages()).toHaveLength(0);
  });

  it("nested transact calls join the outer transaction", () => {
    const ws = Workspace.create();
    ws.transact("outer", () => {
      ws.dispatch("createPage", { type: "document", title: "A" });
      ws.transact("inner", () => {});
    });
    expect(ws.getPages()).toHaveLength(1);
  });

  it("refuses to start a transaction twice or commit without one", () => {
    const ws = Workspace.create();
    ws.beginTransaction("x");
    expect(() => ws.beginTransaction("y")).toThrow(CommandError);
    ws.commitTransaction();
    expect(() => ws.commitTransaction()).toThrow(CommandError);
  });

  it("rolls back explicitly via rollbackTransaction", () => {
    const ws = Workspace.create();
    const before = ws.serialized;
    ws.beginTransaction("x");
    ws.dispatch("createPage", { type: "document", title: "Gone" });
    ws.rollbackTransaction();
    expect(ws.serialized).toEqual(before);
    expect(() => ws.commitTransaction()).toThrow(CommandError);
  });
});

describe("history (undo/redo)", () => {
  it("undoes and redos a command", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document", title: "A" });
    ws.dispatch("renamePage", { pageId: ws.getChildren(null)[0], title: "A2" });
    const id = ws.getChildren(null)[0];

    expect(ws.undo()).toBe(true);
    expect(ws.getPage(id)?.title).toBe("A");
    expect(ws.undo()).toBe(true);
    expect(ws.getPages()).toEqual([]);
    expect(ws.undo()).toBe(false);

    expect(ws.redo()).toBe(true);
    expect(ws.getPages()).toHaveLength(1);
    expect(ws.getPage(id)?.title).toBe("A");
    expect(ws.redo()).toBe(true);
    expect(ws.getPage(id)?.title).toBe("A2");
    expect(ws.redo()).toBe(false);
  });

  it("a new edit clears the redo stack", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document", title: "A" });
    expect(ws.undo()).toBe(true);
    ws.dispatch("createPage", { type: "document", title: "B" });
    expect(ws.redo()).toBe(false);
  });

  it("emits change events for undo/redo/commit", () => {
    const ws = Workspace.create();
    /** @type {{ kind: string, label?: string, commands?: string[] }[]} */
    const events = [];
    ws.events.on("change", (e) => events.push(/** @type {never} */ (e)));
    ws.dispatch("createPage", { type: "document", title: "A" });
    ws.undo();
    ws.redo();
    expect(events.map((e) => e.kind)).toEqual(["commit", "undo", "redo"]);
  });

  it("dirty state is set by history operations and clearable", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "document", title: "A" });
    expect(ws.dirty).toBe(true);
    ws.markSaved();
    expect(ws.dirty).toBe(false);
    ws.undo();
    expect(ws.dirty).toBe(true);
  });
});

describe("setPageContent command", () => {
  it("stores and returns page content", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "sheet", title: "Budget" });
    const id = ws.getChildren(null)[0];
    ws.dispatch("setPageContent", { pageId: id, content: { tables: {}, tableOrder: [] } });
    expect(ws.getPage(id)?.content).toEqual({ tables: {}, tableOrder: [] });
    // structural clones protect the model
    const page = ws.getPage(id);
    page.content.tableOrder.push("tampered");
    expect(ws.getPage(id)?.content).toEqual({ tables: {}, tableOrder: [] });
  });

  it("rejects non-object content", () => {
    const ws = Workspace.create();
    ws.dispatch("createPage", { type: "sheet" });
    const id = ws.getChildren(null)[0];
    expect(() => ws.dispatch("setPageContent", { pageId: id, content: [1, 2] })).toThrow(
      /plain object/
    );
  });
});

describe("renameWorkspace command", () => {
  it("renames metadata title", () => {
    const ws = Workspace.create({ title: "First" });
    ws.dispatch("renameWorkspace", { title: "Second" });
    expect(ws.title).toBe("Second");
  });
});

describe("setFavorite command", () => {
  function pair() {
    const ws = Workspace.create({ title: "W" });
    ws.dispatch("createPage", { type: "document", title: "A" });
    ws.dispatch("createPage", { type: "sheet", title: "B" });
    const [a, b] = ws.getChildren(null);
    return { ws, a, b };
  }

  it("adds and removes favorites in the order they were chosen", () => {
    const { ws, a, b } = pair();
    expect(ws.getFavorites()).toEqual([]);
    ws.dispatch("setFavorite", { pageId: b, favorite: true });
    ws.dispatch("setFavorite", { pageId: a, favorite: true });
    expect(ws.getFavorites()).toEqual([b, a]);
    ws.dispatch("setFavorite", { pageId: b, favorite: false });
    expect(ws.getFavorites()).toEqual([a]);
  });

  it("does not duplicate a page that is favorited twice", () => {
    const { ws, a } = pair();
    ws.dispatch("setFavorite", { pageId: a, favorite: true });
    ws.dispatch("setFavorite", { pageId: a, favorite: true });
    expect(ws.getFavorites()).toEqual([a]);
  });

  it("rejects unknown pages and non-boolean flags", () => {
    const { ws, a } = pair();
    expect(() => ws.dispatch("setFavorite", { pageId: "ghost", favorite: true })).toThrow(CommandError);
    expect(() => ws.dispatch("setFavorite", { pageId: a, favorite: "yes" })).toThrow(CommandError);
  });

  it("prunes deleted pages, including cascaded children", () => {
    const { ws, a, b } = pair();
    ws.dispatch("createPage", { type: "document", title: "child", parentId: a });
    const child = ws.getChildren(a)[0];
    ws.dispatch("setFavorite", { pageId: a, favorite: true });
    ws.dispatch("setFavorite", { pageId: child, favorite: true });
    ws.dispatch("setFavorite", { pageId: b, favorite: true });
    ws.dispatch("deletePage", { pageId: a, cascade: true });
    expect(ws.getFavorites()).toEqual([b]);
    expect(ws.serialized.settings.favoritePageIds).toEqual([b]);
  });

  it("is undoable", () => {
    const { ws, a } = pair();
    ws.dispatch("setFavorite", { pageId: a, favorite: true });
    ws.undo();
    expect(ws.getFavorites()).toEqual([]);
    ws.redo();
    expect(ws.getFavorites()).toEqual([a]);
  });

  it("survives a serialization round trip and is validated", async () => {
    const { ws, a } = pair();
    ws.dispatch("setFavorite", { pageId: a, favorite: true });
    const { exportWorkspaceJSON, importWorkspaceJSON } = await import("../src/workspace/format.js");
    const copy = importWorkspaceJSON(exportWorkspaceJSON(ws));
    expect(copy.getFavorites()).toEqual([a]);
    const bad = ws.serialized;
    bad.settings.favoritePageIds = [1];
    expect(() => importWorkspaceJSON(JSON.stringify(bad))).toThrow();
  });
});
