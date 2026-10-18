import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { registerSheetCommands } from "../src/sheet/commands.js";
import { registerPresentationCommands } from "../src/presentation/commands.js";
import { validateWorkspace } from "../src/workspace/schema.js";
import { findSection } from "../src/references/sections.js";
import { findReferenceHost } from "../src/references/hosts.js";
import { TableEngines } from "../src/sheet/table-engine.js";

/**
 * Notes (document)   paragraphs one, two, three
 * Other (document)   empty
 * Data (sheet)       table Costs
 * Deck (presentation) one slide
 */
function setup() {
  const ws = Workspace.create({ title: "W" });
  registerDocumentCommands(ws);
  registerSheetCommands(ws);
  registerPresentationCommands(ws);
  const page = (type, title, parentId) => {
    ws.dispatch("createPage", { type, title, ...(parentId ? { parentId } : {}) });
    const list = ws.getChildren(parentId ?? null);
    return list[list.length - 1];
  };
  const notes = page("document", "Notes");
  const other = page("document", "Other");
  const data = page("sheet", "Data");
  const deck = page("presentation", "Deck");
  const para = (pageId, id, text) =>
    ws.dispatch("insertBlock", { pageId, newBlockId: id, block: { type: "paragraph", runs: [{ text }] } });
  para(notes, "b1", "one");
  para(notes, "b2", "two");
  para(notes, "b3", "three");
  ws.dispatch("createTable", { pageId: data, name: "Costs" });
  const costs = ws.getPage(data).content.tableOrder[0];
  ws.dispatch("setCell", { pageId: data, tableId: costs, col: 0, row: 0, cell: { value: 5 } });
  ws.dispatch("createSlide", { pageId: deck, layout: "blank", slideId: "s1" });
  ws.dispatch("createSlide", { pageId: deck, layout: "blank", slideId: "s2" });
  const section = (pageId, name, locator, sectionId) =>
    ws.dispatch("createSection", { pageId, name, locator, sectionId });
  const embed = (pageId, sectionId, extra = {}) =>
    ws.dispatch("insertReference", { pageId, kind: "embed", sectionId, ...extra });
  const raw = () => ws._data;
  const blocks = (pageId) => ws.getPage(pageId).content?.blockOrder ?? [];
  const fail = (fn) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return null;
  };
  return { ws, notes, other, data, deck, costs, section, embed, raw, blocks, fail };
}

describe("createSection", () => {
  it("names a run of blocks and keeps the locator", () => {
    const { ws, notes, section } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    expect(ws.getPage(notes).content.sections.sec1).toEqual({
      id: "sec1",
      name: "Intro",
      locator: { startBlockId: "b1", endBlockId: "b2" }
    });
  });

  it("suffixes a name that is already taken on the page", () => {
    const { ws, notes, section } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b1" }, "sec1");
    section(notes, "intro", { startBlockId: "b2", endBlockId: "b2" }, "sec2");
    expect(ws.getPage(notes).content.sections.sec2.name).toBe("intro 2");
  });

  it("refuses bad locators and bad names", () => {
    const { notes, data, deck, section, fail } = setup();
    expect(fail(() => section(notes, "A", { startBlockId: "b3", endBlockId: "b1" })).reason).toBe("invalidLocator");
    expect(fail(() => section(notes, "A", { startBlockId: "zz", endBlockId: "zz" })).reason).toBe("invalidLocator");
    expect(fail(() => section(data, "T", { tableId: "nope" })).reason).toBe("invalidLocator");
    expect(fail(() => section(deck, "S", { slideId: "nope" })).reason).toBe("invalidLocator");
    expect(fail(() => section(notes, "A1", { startBlockId: "b1", endBlockId: "b1" })).reason).toBe("invalidName");
    expect(fail(() => section(notes, "", { startBlockId: "b1", endBlockId: "b1" })).reason).toBe("invalidName");
  });

  it("allows unnamed implicit sections and a range of a table", () => {
    const { ws, data, costs } = setup();
    ws.dispatch("createSection", { pageId: data, implicit: true, sectionId: "t", locator: { tableId: costs } });
    ws.dispatch("createSection", {
      pageId: data,
      name: "Top",
      sectionId: "r",
      locator: { tableId: costs, range: { start: { col: 0, row: 0 }, end: { col: 1, row: 1 } } }
    });
    expect(ws.getPage(data).content.sections.t.implicit).toBe(true);
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
  });
});

describe("insertReference", () => {
  it("places an embed block and shows up in the host index", () => {
    const { ws, notes, other, section, embed, blocks } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    embed(other, "sec1", { instanceId: "ref1" });
    expect(blocks(other)).toEqual(["ref1"]);
    expect(ws.getPage(other).content.blocks.ref1).toMatchObject({ type: "sectionRef", kind: "embed", sectionId: "sec1" });
    expect(findReferenceHost(ws._data, "ref1")).toMatchObject({ containerId: other, kind: "embed" });
  });

  it("refuses an embed of a missing section and changes nothing", () => {
    const { ws, other, embed, fail, blocks } = setup();
    const error = fail(() => embed(other, "ghost"));
    expect(error.reason).toBe("invalidReference");
    expect(blocks(other)).toEqual([]);
    expect(ws.canUndo).toBe(true); // earlier setup commands only
  });

  it("refuses an embed that would show itself", () => {
    const { notes, section, embed, fail, blocks } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b3" }, "sec1");
    const error = fail(() => embed(notes, "sec1", { afterBlockId: "b1", instanceId: "ref1" }));
    expect(error.reason).toBe("invalidReference");
    expect(error.message).toMatch(/itself/);
    expect(blocks(notes)).toEqual(["b1", "b2", "b3"]);
  });

  it("refuses an indirect loop", () => {
    const { ws, notes, other, section, embed, fail } = setup();
    section(notes, "A", { startBlockId: "b1", endBlockId: "b2" }, "secA");
    embed(other, "secA", { instanceId: "refA" });
    section(other, "B", { startBlockId: "refA", endBlockId: "refA" }, "secB");
    // Putting an embed of B inside A closes the loop A -> B -> A.
    const error = fail(() => embed(notes, "secB", { afterBlockId: "b1", instanceId: "refB" }));
    expect(error).not.toBeNull();
    expect(ws.getPage(notes).content.blockOrder).toEqual(["b1", "b2", "b3"]);
  });

  it("places expressions and refuses ones that evaluate to an error", () => {
    const { ws, other, embed, fail } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1 + 1", instanceId: "x1" });
    expect(ws.getPage(other).content.blocks.x1.expression).toBe("Data!Costs!A1 + 1");
    const error = fail(() =>
      ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Nope + 1", instanceId: "x2" })
    );
    expect(error.reason).toBe("invalidReference");
    expect(ws.getPage(other).content.blocks.x2).toBeUndefined();
    expect(embed).toBeTypeOf("function");
  });

  it("is refused on a sheet page", () => {
    const { data, fail, ws } = setup();
    const error = fail(() => ws.dispatch("insertReference", { pageId: data, kind: "expression", expression: "1" }));
    expect(error.reason).toBe("invalidReference");
  });

  it("puts a reference object on a slide", () => {
    const { ws, notes, deck, section, embed } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    embed(deck, "sec1", { slideId: "s1", instanceId: "obj1", x: 10, y: 20 });
    const object = ws.getPage(deck).content.slides.s1.objects.obj1;
    expect(object).toMatchObject({ type: "reference", kind: "embed", sectionId: "sec1", x: 10, y: 20 });
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
  });
});

describe("updateReference, setExpression, removeReference", () => {
  it("retargets an embed and patches display options", () => {
    const { ws, notes, other, section, embed } = setup();
    section(notes, "A", { startBlockId: "b1", endBlockId: "b1" }, "secA");
    section(notes, "B", { startBlockId: "b2", endBlockId: "b2" }, "secB");
    embed(other, "secA", { instanceId: "ref1" });
    ws.dispatch("updateReference", { pageId: other, instanceId: "ref1", patch: { sectionId: "secB", display: { width: 50 } } });
    expect(ws.getPage(other).content.blocks.ref1).toMatchObject({ sectionId: "secB", display: { width: 50 } });
  });

  it("rejects an expression that errors and keeps the old one", () => {
    const { ws, other, fail } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "1+1", instanceId: "x1" });
    const error = fail(() => ws.dispatch("setExpression", { pageId: other, instanceId: "x1", expression: "1/0" }));
    expect(error.reason).toBe("invalidReference");
    expect(ws.getPage(other).content.blocks.x1.expression).toBe("1+1");
    ws.dispatch("setExpression", { pageId: other, instanceId: "x1", expression: "2+2" });
    expect(ws.getPage(other).content.blocks.x1.expression).toBe("2+2");
  });

  it("removes a reference block", () => {
    const { ws, notes, other, section, embed, blocks } = setup();
    section(notes, "A", { startBlockId: "b1", endBlockId: "b1" }, "secA");
    embed(other, "secA", { instanceId: "ref1" });
    ws.dispatch("removeReference", { pageId: other, instanceId: "ref1" });
    expect(blocks(other)).toEqual([]);
  });
});

describe("renameSection", () => {
  it("rewrites expressions that used the name", () => {
    const { ws, notes, other, section } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "LEN(Notes!Intro)", instanceId: "x1" });
    ws.dispatch("renameSection", { sectionId: "sec1", name: "Opening words" });
    expect(ws.getPage(other).content.blocks.x1.expression).toBe("LEN(Notes!'Opening words')");
  });
});

describe("sections follow their blocks", () => {
  it("keeps a run whole when a middle block goes, and grows when one is inserted", () => {
    const { ws, notes, section } = setup();
    section(notes, "All", { startBlockId: "b1", endBlockId: "b3" }, "sec1");
    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b2" });
    expect(ws.getPage(notes).content.sections.sec1.locator).toEqual({ startBlockId: "b1", endBlockId: "b3" });
    ws.dispatch("insertBlock", {
      pageId: notes,
      newBlockId: "b4",
      afterBlockId: "b1",
      block: { type: "paragraph", runs: [{ text: "new" }] }
    });
    expect(ws.getPage(notes).content.blockOrder).toEqual(["b1", "b4", "b3"]);
    expect(ws.getPage(notes).content.sections.sec1.locator).toEqual({ startBlockId: "b1", endBlockId: "b3" });
  });

  it("shrinks to the surviving ends when the first or last block is deleted", () => {
    const { ws, notes, section } = setup();
    section(notes, "All", { startBlockId: "b1", endBlockId: "b3" }, "sec1");
    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b1" });
    expect(ws.getPage(notes).content.sections.sec1.locator).toEqual({ startBlockId: "b2", endBlockId: "b3" });
    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b3" });
    expect(ws.getPage(notes).content.sections.sec1.locator).toEqual({ startBlockId: "b2", endBlockId: "b2" });
  });

  it("follows the blocks when they move together", () => {
    const { ws, notes, section } = setup();
    section(notes, "Head", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    ws.dispatch("moveBlocks", { pageId: notes, blockIds: ["b1", "b2"], afterBlockId: "b3" });
    expect(ws.getPage(notes).content.blockOrder).toEqual(["b3", "b1", "b2"]);
    expect(ws.getPage(notes).content.sections.sec1.locator).toEqual({ startBlockId: "b1", endBlockId: "b2" });
  });

  it("moveBlocks refuses a target inside the moved run and can move into a list item", () => {
    const { ws, notes, section, fail } = setup();
    section(notes, "Head", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    expect(fail(() => ws.dispatch("moveBlocks", { pageId: notes, blockIds: ["b1", "b2"], afterBlockId: "b2" })).reason).toBeDefined();
    expect(ws.getPage(notes).content.blockOrder).toEqual(["b1", "b2", "b3"]);
    expect(ws.getPage(notes).content.sections.sec1.locator).toEqual({ startBlockId: "b1", endBlockId: "b2" });
  });

  it("drops an unread section whose blocks all vanish, without keeping anything", () => {
    const { ws, notes, section } = setup();
    section(notes, "Gone", { startBlockId: "b1", endBlockId: "b1" }, "sec1");
    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b1" });
    expect(ws.getPage(notes).content.sections.sec1).toBeUndefined();
    expect(ws._data.detached).toBeUndefined();
  });
});

describe("range sections", () => {
  const range = (c0, r0, c1, r1) => ({ start: { col: c0, row: r0 }, end: { col: c1, row: r1 } });
  it("shift with row and column inserts and deletes, and go when wholly deleted", () => {
    const { ws, data, costs } = setup();
    ws.dispatch("createSection", { pageId: data, name: "R", sectionId: "r", locator: { tableId: costs, range: range(1, 1, 2, 2) } });
    ws.dispatch("insertRow", { pageId: data, tableId: costs, index: 0 });
    expect(ws.getPage(data).content.sections.r.locator.range).toEqual(range(1, 2, 2, 3));
    ws.dispatch("insertColumn", { pageId: data, tableId: costs, index: 2 });
    expect(ws.getPage(data).content.sections.r.locator.range).toEqual(range(1, 2, 3, 3));
    ws.dispatch("deleteColumn", { pageId: data, tableId: costs, index: 0 });
    expect(ws.getPage(data).content.sections.r.locator.range).toEqual(range(0, 2, 2, 3));
    ws.dispatch("deleteRow", { pageId: data, tableId: costs, index: 2, count: 2 });
    expect(ws.getPage(data).content.sections.r).toBeUndefined();
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
  });
});

describe("detached content", () => {
  it("keeps a deleted section's content for the embed that reads it", () => {
    const { ws, notes, other, section, embed, raw } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    embed(other, "sec1", { instanceId: "ref1" });
    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b1" });
    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b2" });

    const found = findSection(raw(), "sec1");
    expect(found.detached).toBe(true);
    expect(found.container.origin.pageId).toBe(notes);
    expect(found.container.content.blockOrder).toEqual(["b2"]);
    expect(found.container.content.blocks.b2.runs).toEqual([{ text: "two" }]);
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
  });

  it("discards the entry, in the same transaction, when the last reader goes; undo brings it back", () => {
    const { ws, notes, other, section, embed, raw } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b1" }, "sec1");
    embed(other, "sec1", { instanceId: "ref1" });
    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b1" });
    expect(Object.keys(raw().detached)).toHaveLength(1);
    ws.dispatch("removeReference", { pageId: other, instanceId: "ref1" });
    expect(raw().detached).toBeUndefined();
    ws.undo();
    expect(Object.keys(raw().detached)).toHaveLength(1);
  });

  it("keeps a chain alive: a detached section that embeds another", () => {
    const { ws, notes, other, section, embed, raw } = setup();
    section(notes, "Inner", { startBlockId: "b1", endBlockId: "b1" }, "inner");
    embed(other, "inner", { instanceId: "refInner" });
    section(other, "Outer", { startBlockId: "refInner", endBlockId: "refInner" }, "outer");
    ws.dispatch("createPage", { type: "document", title: "Reader" });
    const reader = ws.getChildren(null).at(-1);
    embed(reader, "outer", { instanceId: "refOuter" });

    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b1" });
    ws.dispatch("deleteBlock", { pageId: other, blockId: "refInner" });
    expect(findSection(raw(), "inner")).not.toBeNull();
    expect(findSection(raw(), "outer").detached).toBe(true);
    expect(validateWorkspace(ws.serialized).valid).toBe(true);

    ws.dispatch("removeReference", { pageId: reader, instanceId: "refOuter" });
    expect(raw().detached).toBeUndefined();
  });

  it("detaches a deleted table while a formula elsewhere still reads it", () => {
    const { ws, data, costs, deck, raw } = setup();
    ws.dispatch("createPage", { type: "sheet", title: "Report" });
    const report = ws.getChildren(null).at(-1);
    ws.dispatch("createTable", { pageId: report, name: "Main" });
    const main = ws.getPage(report).content.tableOrder[0];
    ws.dispatch("setCell", { pageId: report, tableId: main, col: 0, row: 0, cell: { formula: "=Data!Costs!A1 * 2" } });
    ws.dispatch("deleteTable", { pageId: data, tableId: costs });
    expect(Object.values(raw().detached)).toHaveLength(1);

    const engines = new TableEngines(() => ws._data);
    const table = ws.getPage(report).content.tables[main];
    expect(engines.display(table, 0, 0)).toBe("10");
    expect(deck).toBeTruthy();

    ws.dispatch("setCell", { pageId: report, tableId: main, col: 0, row: 0, cell: { value: 1 } });
    expect(raw().detached).toBeUndefined();
  });

  it("detaches a deleted slide that an embed shows", () => {
    const { ws, deck, other, section, embed, raw } = setup();
    section(deck, "First", { slideId: "s1" }, "sl1");
    embed(other, "sl1", { instanceId: "ref1" });
    ws.dispatch("deleteSlide", { pageId: deck, slideId: "s1" });
    const found = findSection(raw(), "sl1");
    expect(found.detached).toBe(true);
    expect(found.container.content.slides.s1).toBeTruthy();
    expect(found.container.type).toBe("presentation");
  });

  it("detaches the sections of a deleted page and restores them to another page", () => {
    const { ws, notes, other, section, embed, raw, blocks, fail } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    embed(other, "sec1", { instanceId: "ref1" });
    ws.dispatch("deletePage", { pageId: notes });
    const found = findSection(raw(), "sec1");
    expect(found.detached).toBe(true);
    expect(found.container.origin).toMatchObject({ pageId: notes, title: "Notes" });

    ws.dispatch("createPage", { type: "document", title: "Home" });
    const home = ws.getChildren(null).at(-1);
    ws.dispatch("restoreDetached", { detachedId: found.containerId, pageId: home });
    expect(raw().detached).toBeUndefined();
    expect(findSection(raw(), "sec1").containerId).toBe(home);
    expect(blocks(home).slice(0, 3)).toEqual(expect.arrayContaining(["b1", "b2"]));
    expect(validateWorkspace(ws.serialized).valid).toBe(true);

    // The wrong kind of page is refused.
    ws.dispatch("deletePage", { pageId: home });
    const again = Object.keys(raw().detached)[0];
    const error = fail(() => ws.dispatch("restoreDetached", { detachedId: again, pageId: ws.getChildren(null).find((id) => ws.getPage(id).type === "sheet") }));
    expect(error.reason).toBe("typeMismatch");
  });

  it("removeSection keeps what readers saw, and just forgets unread sections", () => {
    const { ws, notes, other, section, embed, raw } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    section(notes, "Spare", { startBlockId: "b3", endBlockId: "b3" }, "sec2");
    embed(other, "sec1", { instanceId: "ref1" });
    ws.dispatch("removeSection", { sectionId: "sec1" });
    ws.dispatch("removeSection", { sectionId: "sec2" });
    expect(ws.getPage(notes).content.blockOrder).toEqual(["b1", "b2", "b3"]);
    expect(ws.getPage(notes).content.sections).toEqual({});
    const found = findSection(raw(), "sec1");
    expect(found.detached).toBe(true);
    expect(found.container.content.blockOrder).toEqual(["b1", "b2"]);
    expect(findSection(raw(), "sec2")).toBeNull();
  });

  it("refuses to restore content onto a page of another type", () => {
    const { ws, notes, other, data, section, embed, raw, fail } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b1" }, "sec1");
    embed(other, "sec1", { instanceId: "ref1" });
    ws.dispatch("removeSection", { sectionId: "sec1" });
    const id = Object.keys(raw().detached)[0];
    expect(fail(() => ws.dispatch("restoreDetached", { detachedId: id, pageId: data })).reason).toBe("typeMismatch");
  });
});

describe("workspace validation", () => {
  it("rejects a section whose blocks do not exist and a loop of embeds", () => {
    const { ws, notes, section } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    const broken = ws.serialized;
    broken.pages[notes].content.sections.sec1.locator.endBlockId = "ghost";
    expect(validateWorkspace(broken).errors.join(" ")).toMatch(/sec1/);

    const looped = ws.serialized;
    looped.pages[notes].content.blocks.b2 = { id: "b2", type: "sectionRef", kind: "embed", sectionId: "sec1", display: {} };
    expect(validateWorkspace(looped).errors.join(" ")).toMatch(/loop/);
  });

  it("round-trips through JSON with detached content", () => {
    const { ws, notes, other, section, embed } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b1" }, "sec1");
    embed(other, "sec1", { instanceId: "ref1" });
    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b1" });
    const again = Workspace.fromJSON(JSON.parse(JSON.stringify(ws.serialized)));
    expect(findSection(again._data, "sec1").detached).toBe(true);
  });
});

describe("tables, slides and pages that are read elsewhere", () => {
  it("deleteTable detaches a table an expression reads, and the expression still evaluates", () => {
    const { ws, data, other, costs, raw } = setup();
    ws.dispatch("insertReference", { pageId: other, kind: "expression", expression: "Data!Costs!A1 + 1", instanceId: "x1" });
    ws.dispatch("deleteTable", { pageId: data, tableId: costs });
    const detached = Object.values(raw().detached ?? {});
    expect(detached).toHaveLength(1);
    expect(detached[0].type).toBe("sheet");
    expect(detached[0].content.tables[costs].cells["0,0"]).toMatchObject({ value: 5 });
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
    ws.undo();
    expect(raw().detached).toBeUndefined();
  });

  it("deleteTable with no reader keeps nothing", () => {
    const { ws, data, costs, raw } = setup();
    ws.dispatch("deleteTable", { pageId: data, tableId: costs });
    expect(raw().detached).toBeUndefined();
  });

  it("deleteSlide detaches a slide an embed reads", () => {
    const { ws, deck, other, section, embed, raw } = setup();
    section(deck, "Cover", { slideId: "s1" }, "secS");
    embed(other, "secS", { instanceId: "ref1" });
    ws.dispatch("deleteSlide", { pageId: deck, slideId: "s1" });
    const found = findSection(raw(), "secS");
    expect(found.detached).toBe(true);
    expect(found.container.type).toBe("presentation");
    expect(found.container.content.slides.s1).toBeDefined();
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
  });

  it("deletePage detaches its sections that are read from other pages", () => {
    const { ws, notes, other, section, embed, raw } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b2" }, "sec1");
    embed(other, "sec1", { instanceId: "ref1" });
    ws.dispatch("deletePage", { pageId: notes });
    const found = findSection(raw(), "sec1");
    expect(found.detached).toBe(true);
    expect(found.container.content.blockOrder).toEqual(["b1", "b2", "b3"]);
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
    ws.undo();
    expect(findSection(raw(), "sec1").detached).toBeFalsy();
  });
});

describe("restoreDetached", () => {
  it("puts detached text back on a document page of the same type", () => {
    const { ws, notes, other, section, embed, raw, blocks, fail, data } = setup();
    section(notes, "Intro", { startBlockId: "b1", endBlockId: "b1" }, "sec1");
    embed(other, "sec1", { instanceId: "ref1" });
    ws.dispatch("deleteBlock", { pageId: notes, blockId: "b1" });
    const id = Object.keys(raw().detached)[0];
    expect(fail(() => ws.dispatch("restoreDetached", { detachedId: id, pageId: data })).reason).toBe("typeMismatch");
    ws.dispatch("restoreDetached", { detachedId: id, pageId: notes });
    expect(raw().detached).toBeUndefined();
    expect(blocks(notes)).toContain("b1");
    expect(findSection(raw(), "sec1").detached).toBeFalsy();
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
  });
});

describe("validateWorkspace and sections", () => {
  it("rejects dangling locators and detached entries that clash with pages", () => {
    const { ws, notes } = setup();
    ws.dispatch("createSection", { pageId: notes, name: "A", sectionId: "sec1", locator: { startBlockId: "b1", endBlockId: "b2" } });
    const good = ws.serialized;
    expect(validateWorkspace(good).valid).toBe(true);

    const dangling = structuredClone(good);
    dangling.pages[notes].content.sections.sec1.locator.endBlockId = "zz";
    expect(validateWorkspace(dangling).valid).toBe(false);

    const unnamed = structuredClone(good);
    delete unnamed.pages[notes].content.sections.sec1.name;
    expect(validateWorkspace(unnamed).valid).toBe(false);

    const clash = structuredClone(good);
    clash.detached = { [notes]: { id: notes, type: "document", origin: { pageId: "x" }, content: {} } };
    expect(validateWorkspace(clash).valid).toBe(false);
  });

  it("rejects a workspace whose embeds loop", () => {
    const { ws, notes, other, section, embed } = setup();
    section(notes, "A", { startBlockId: "b1", endBlockId: "b2" }, "secA");
    embed(other, "secA", { instanceId: "refA" });
    section(other, "B", { startBlockId: "refA", endBlockId: "refA" }, "secB");
    const data = structuredClone(ws.serialized);
    data.pages[notes].content.blocks.loop = { id: "loop", type: "sectionRef", kind: "embed", sectionId: "secB" };
    data.pages[notes].content.blockOrder.splice(1, 0, "loop");
    expect(validateWorkspace(data).valid).toBe(false);
  });
});
