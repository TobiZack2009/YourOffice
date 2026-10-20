import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createObject } from "../src/presentation/model.js";
import { WHOLE_PAGE, entitiesOf, touchesPage } from "../src/workspace/changes.js";

/** Collect the change events a callback produces. */
function record(ws, fn) {
  const events = [];
  const off = ws.events.on("change", (event) => events.push(event));
  fn();
  off();
  return events;
}

describe("command results", () => {
  it("returns the ids of what creating commands made", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId } = ws.dispatch("createPage", { type: "document", title: "D" });
    expect(ws.data.pages[pageId].title).toBe("D");

    const { blockId } = ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [] } });
    expect(ws.data.pages[pageId].content.blocks[blockId]).toBeDefined();
    const { blockId: wanted } = ws.dispatch("insertBlock", { pageId, newBlockId: "b_fixed", block: { type: "paragraph", runs: [] } });
    expect(wanted).toBe("b_fixed");

    const { pageId: sheetId } = ws.dispatch("createPage", { type: "sheet" });
    const { tableId } = ws.dispatch("createTable", { pageId: sheetId });
    expect(ws.data.pages[sheetId].content.tables[tableId]).toBeDefined();

    const { pageId: deckId } = ws.dispatch("createPage", { type: "presentation" });
    const { slideId } = ws.dispatch("createSlide", { pageId: deckId, layout: "title" });
    expect(ws.data.pages[deckId].content.slides[slideId]).toBeDefined();
    const { slideId: copy } = ws.dispatch("duplicateSlide", { pageId: deckId, slideId });
    expect(ws.data.pages[deckId].content.slideOrder).toEqual([slideId, copy]);
    const { objectId } = ws.dispatch("insertObject", {
      pageId: deckId,
      slideId,
      object: createObject("shape", { shape: "rect", x: 0, y: 0, width: 10, height: 10 })
    });
    expect(ws.data.pages[deckId].content.slides[slideId].objects[objectId]).toBeDefined();
  });

  it("returns section and reference ids, and the result of a command inside a transaction", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId } = ws.dispatch("createPage", { type: "document" });
    const { blockId } = ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [{ text: "x" }] } });
    const { sectionId } = ws.dispatch("createSection", { pageId, name: "Part", locator: { startBlockId: blockId, endBlockId: blockId } });
    expect(ws.data.pages[pageId].content.sections[sectionId].name).toBe("Part");
    const made = ws.transact("both", () => {
      const ref = ws.dispatch("insertReference", { pageId, kind: "embed", sectionId, display: {} });
      return ref.instanceId;
    });
    expect(ws.data.pages[pageId].content.blocks[made].type).toBe("sectionRef");
  });
});

describe("change sets", () => {
  function docWith(ws) {
    const { pageId } = ws.dispatch("createPage", { type: "document" });
    const { blockId: a } = ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [] } });
    const { blockId: b } = ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [] } });
    return { pageId, a, b };
  }

  it("names the block a typing commit changed", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId, a } = docWith(ws);
    const [event] = record(ws, () => ws.dispatch("setBlockRuns", { pageId, blockId: a, runs: [{ text: "hi" }] }));
    expect(event.kind).toBe("commit");
    expect(event.pages).toEqual([pageId]);
    expect(entitiesOf(event, pageId)).toEqual(new Set([a]));
    expect(event.registry).toBe(false);
    expect(touchesPage(event, pageId)).toBe(true);
    expect(touchesPage(event, "other")).toBe(false);
  });

  it("treats a structural command as the whole page", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId, a } = docWith(ws);
    const [event] = record(ws, () => ws.dispatch("deleteBlock", { pageId, blockId: a }));
    expect(event.entities.get(pageId).has(WHOLE_PAGE)).toBe(true);
    expect(entitiesOf(event, pageId)).toBeNull();
  });

  it("lets a whole-page touch win over precise ones in the same transaction", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId, a, b } = docWith(ws);
    const [event] = record(ws, () =>
      ws.transact("mixed", () => {
        ws.dispatch("setBlockRuns", { pageId, blockId: a, runs: [{ text: "1" }] });
        ws.dispatch("deleteBlock", { pageId, blockId: b });
      })
    );
    expect(entitiesOf(event, pageId)).toBeNull();
  });

  it("names tables for sheet edits and slides plus objects for slide edits", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId: sheet } = ws.dispatch("createPage", { type: "sheet" });
    const { tableId } = ws.dispatch("createTable", { pageId: sheet });
    const [cell] = record(ws, () =>
      ws.dispatch("setCell", { pageId: sheet, tableId, col: 0, row: 0, cell: { value: 1 } })
    );
    expect(entitiesOf(cell, sheet)).toEqual(new Set([tableId]));

    const { pageId: deck } = ws.dispatch("createPage", { type: "presentation" });
    const { slideId } = ws.dispatch("createSlide", { pageId: deck, layout: "title" });
    const objectId = ws.data.pages[deck].content.slides[slideId].objectOrder[0];
    const [move] = record(ws, () =>
      ws.dispatch("updateObject", { pageId: deck, slideId, objectId, patch: { x: 5 } })
    );
    expect(entitiesOf(move, deck)).toEqual(new Set([slideId, objectId]));
    const [bg] = record(ws, () => ws.dispatch("setSlideBackground", { pageId: deck, slideId, color: "#ff0000" }));
    expect(entitiesOf(bg, deck)).toEqual(new Set([slideId]));
  });

  it("flags registry changes", () => {
    const ws = createWorkspace({ title: "W" });
    const events = record(ws, () => {
      const { pageId } = ws.dispatch("createPage", { type: "document" });
      ws.dispatch("renamePage", { pageId, title: "New" });
      ws.dispatch("setFavorite", { pageId, favorite: true });
      ws.dispatch("renameWorkspace", { title: "T" });
      ws.dispatch("insertBlock", { pageId, block: { type: "paragraph", runs: [] } });
      ws.dispatch("movePage", { pageId, newParentId: null, index: 0 });
      ws.dispatch("deletePage", { pageId });
    });
    expect(events.map((e) => e.registry)).toEqual([true, true, true, true, false, true, true]);
    expect(events[2].pages).toEqual([]);
  });

  it("carries the dispatching origin, from the first command that names one", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId, a } = docWith(ws);
    const [own] = record(ws, () => ws.dispatch("setBlockRuns", { pageId, blockId: a, runs: [] }, { origin: "editor_1" }));
    expect(own.origin).toBe("editor_1");
    const [anon] = record(ws, () => ws.dispatch("setBlockRuns", { pageId, blockId: a, runs: [] }));
    expect(anon.origin).toBeUndefined();
    const [grouped] = record(ws, () =>
      ws.transact("g", () => {
        ws.dispatch("setBlockRuns", { pageId, blockId: a, runs: [] });
        ws.dispatch("setBlockRuns", { pageId, blockId: a, runs: [] }, { origin: "late" });
      })
    );
    expect(grouped.origin).toBe("late");
  });

  it("gives undo and redo the same pages and entities as the commit, with registry true", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId, a } = docWith(ws);
    ws.dispatch("setBlockRuns", { pageId, blockId: a, runs: [{ text: "z" }] });
    const [undo] = record(ws, () => ws.undo());
    expect(undo.kind).toBe("undo");
    expect(undo.pages).toEqual([pageId]);
    expect(entitiesOf(undo, pageId)).toEqual(new Set([a]));
    expect(undo.registry).toBe(true);
    expect(undo.commands).toEqual(["setBlockRuns"]);
    const [redo] = record(ws, () => ws.redo());
    expect(redo.kind).toBe("redo");
    expect(entitiesOf(redo, pageId)).toEqual(new Set([a]));
  });

  it("does not leak a rolled-back transaction into the next event", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId, a } = docWith(ws);
    expect(() =>
      ws.transact("fails", () => {
        ws.dispatch("setBlockRuns", { pageId, blockId: a, runs: [{ text: "x" }] });
        ws.dispatch("deleteBlock", { pageId, blockId: "missing" });
      })
    ).toThrow();
    const [event] = record(ws, () => ws.dispatch("setBlockRuns", { pageId, blockId: a, runs: [{ text: "y" }] }));
    expect(entitiesOf(event, pageId)).toEqual(new Set([a]));
  });
});
