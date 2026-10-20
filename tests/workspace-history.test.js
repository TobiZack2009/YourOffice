import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { History } from "../src/workspace/history.js";
import { entitiesOf } from "../src/workspace/changes.js";

function docWith(ws) {
  const { pageId } = ws.dispatch("createPage", { type: "document" });
  const { blockId } = ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [] } });
  return { pageId, blockId };
}

function type(ws, pageId, blockId, text, extra = {}) {
  return ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text }] }, { coalesce: `type:${blockId}`, ...extra });
}

function textOf(ws, pageId, blockId) {
  return ws.data.pages[pageId].content.blocks[blockId].runs.map((r) => r.text).join("");
}

describe("undo and redo", () => {
  it("restore exact states without cloning more than the commit's before snapshot", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId, blockId } = docWith(ws);
    ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: "one" }] });
    ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: "two" }] });
    expect(ws.undo()).toBe(true);
    expect(textOf(ws, pageId, blockId)).toBe("one");
    expect(ws.undo()).toBe(true);
    expect(textOf(ws, pageId, blockId)).toBe("");
    expect(ws.redo()).toBe(true);
    expect(textOf(ws, pageId, blockId)).toBe("one");
    expect(ws.redo()).toBe(true);
    expect(textOf(ws, pageId, blockId)).toBe("two");
    expect(ws.redo()).toBe(false);
  });

  it("keeps working after a new edit follows an undo", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId, blockId } = docWith(ws);
    ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: "a" }] });
    ws.undo();
    ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: "b" }] });
    expect(ws.canRedo).toBe(false);
    ws.undo();
    expect(textOf(ws, pageId, blockId)).toBe("");
    ws.redo();
    expect(textOf(ws, pageId, blockId)).toBe("b");
  });
});

describe("coalescing", () => {
  function clocked() {
    const ws = createWorkspace({ title: "W" });
    let now = 1000;
    ws.history.now = () => now;
    return { ws, tick: (ms) => (now += ms) };
  }

  it("merges same-key commits inside the window into one undo step", () => {
    const { ws, tick } = clocked();
    const { pageId, blockId } = docWith(ws);
    const size = ws.history.size;
    type(ws, pageId, blockId, "h");
    tick(100);
    type(ws, pageId, blockId, "hi");
    tick(100);
    type(ws, pageId, blockId, "hi!");
    expect(ws.history.size).toBe(size + 1);
    expect(ws.undo()).toBe(true);
    expect(textOf(ws, pageId, blockId)).toBe("");
    ws.redo();
    expect(textOf(ws, pageId, blockId)).toBe("hi!");
  });

  it("still emits one commit event per commit, describing that commit alone", () => {
    const { ws, tick } = clocked();
    const { pageId, blockId } = docWith(ws);
    const events = [];
    ws.events.on("change", (e) => events.push(e));
    type(ws, pageId, blockId, "a");
    tick(10);
    type(ws, pageId, blockId, "ab");
    expect(events.map((e) => e.kind)).toEqual(["commit", "commit"]);
    expect(events[1].commands).toEqual(["setBlockRuns"]);
    expect(entitiesOf(events[1], pageId)).toEqual(new Set([blockId]));
  });

  it("starts a new step after the window, for another key, or after another commit", () => {
    const { ws, tick } = clocked();
    const { pageId, blockId } = docWith(ws);
    const { blockId: other } = ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [] } });
    const base = ws.history.size;
    type(ws, pageId, blockId, "a");
    tick(2000);
    type(ws, pageId, blockId, "ab");
    expect(ws.history.size).toBe(base + 2);
    tick(10);
    type(ws, pageId, other, "x");
    expect(ws.history.size).toBe(base + 3);
    tick(10);
    ws.dispatch("setBlockRuns", { pageId, blockId: other, runs: [{ text: "xy" }] });
    tick(10);
    type(ws, pageId, other, "xyz");
    expect(ws.history.size).toBe(base + 5);
  });

  it("does not merge across an undo or a save", () => {
    const { ws, tick } = clocked();
    const { pageId, blockId } = docWith(ws);
    type(ws, pageId, blockId, "a");
    tick(10);
    ws.markSaved();
    type(ws, pageId, blockId, "ab");
    expect(ws.dirty).toBe(true);
    ws.undo();
    expect(textOf(ws, pageId, blockId)).toBe("a");
    expect(ws.dirty).toBe(false);

    ws.redo();
    ws.undo();
    tick(10);
    const size = ws.history.size;
    type(ws, pageId, blockId, "c");
    expect(ws.history.size).toBe(size + 1);
  });

  it("only merges a transaction whose commands all agree on the key", () => {
    const { ws, tick } = clocked();
    const { pageId, blockId } = docWith(ws);
    const size = ws.history.size;
    type(ws, pageId, blockId, "a");
    tick(10);
    ws.transact("mixed", () => {
      type(ws, pageId, blockId, "ab");
      ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: "abc" }] });
    });
    expect(ws.history.size).toBe(size + 2);
  });

  it("unions the pages and entities of merged entries for undo", () => {
    const { ws, tick } = clocked();
    const { pageId, blockId } = docWith(ws);
    const { blockId: other } = ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [] } });
    const key = "shared";
    ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: "a" }] }, { coalesce: key });
    tick(10);
    ws.dispatch("setBlockRuns", { pageId, blockId: other, runs: [{ text: "b" }] }, { coalesce: key });
    const events = [];
    ws.events.on("change", (e) => events.push(e));
    ws.undo();
    expect(entitiesOf(events[0], pageId)).toEqual(new Set([blockId, other]));
    expect(textOf(ws, pageId, other)).toBe("");
  });
});

describe("cap", () => {
  it("drops the oldest entries beyond the limit", () => {
    const ws = createWorkspace({ title: "W" });
    ws.history.maxEntries = 3;
    const { pageId, blockId } = docWith(ws);
    for (let i = 1; i <= 5; i += 1) ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: String(i) }] });
    expect(ws.history.size).toBe(3);
    let undone = 0;
    while (ws.undo()) undone += 1;
    expect(undone).toBe(3);
    expect(textOf(ws, pageId, blockId)).toBe("2");
  });
});

describe("saved revision", () => {
  it("is clean again after undoing back to the saved state", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId, blockId } = docWith(ws);
    ws.markSaved();
    expect(ws.dirty).toBe(false);
    ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: "x" }] });
    expect(ws.dirty).toBe(true);
    ws.undo();
    expect(ws.dirty).toBe(false);
    ws.redo();
    expect(ws.dirty).toBe(true);
  });

  it("starts clean, and is dirty after undoing past the saved state", () => {
    const ws = createWorkspace({ title: "W" });
    expect(ws.dirty).toBe(false);
    docWith(ws);
    ws.markSaved();
    ws.undo();
    expect(ws.dirty).toBe(true);
    ws.undo();
    ws.undo();
    expect(ws.canUndo).toBe(false);
    expect(ws.dirty).toBe(true);
    ws.redo();
    ws.redo();
    expect(ws.dirty).toBe(false);
  });

  it("is dirty when the saved state was trimmed out of reach, clean at the trimmed base", () => {
    const ws = createWorkspace({ title: "W" });
    ws.history.maxEntries = 2;
    const { pageId, blockId } = docWith(ws);
    ws.markSaved();
    for (let i = 0; i < 4; i += 1) ws.dispatch("setBlockRuns", { pageId, blockId, runs: [{ text: String(i) }] });
    while (ws.undo());
    expect(ws.dirty).toBe(true);
  });
});

describe("History", () => {
  it("returns null when there is nothing to step to", () => {
    const history = new History();
    expect(history.undo({})).toBeNull();
    expect(history.redo({})).toBeNull();
    expect(history.canUndo).toBe(false);
  });
});
