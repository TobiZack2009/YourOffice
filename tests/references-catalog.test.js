import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { buildCatalog, ensureSection, filterCatalog, suggestNames } from "../src/references/catalog.js";
import { findSection } from "../src/references/sections.js";

function setup() {
  const ws = createWorkspace({ title: "W" });
  const page = (type, title) => {
    ws.dispatch("createPage", { type, title });
    const list = ws.getChildren(null);
    return list[list.length - 1];
  };
  const notes = page("document", "Notes");
  const data = page("sheet", "Data");
  const deck = page("presentation", "Deck");
  for (const [id, text] of [["b1", "one"], ["b2", "two"], ["b3", "three"]]) {
    ws.dispatch("insertBlock", { pageId: notes, newBlockId: id, block: { type: "paragraph", runs: [{ text }] } });
  }
  ws.dispatch("createTable", { pageId: data, name: "Costs" });
  const costs = ws.getPage(data).content.tableOrder[0];
  ws.dispatch("createSlide", { pageId: deck, layout: "blank", slideId: "s1" });
  return { ws, notes, data, deck, costs };
}

describe("buildCatalog", () => {
  it("lists pages in tree order with what each offers", () => {
    const { ws, notes, data, deck, costs } = setup();
    ws.dispatch("createSection", { pageId: notes, name: "Intro", locator: { startBlockId: "b1", endBlockId: "b2" } });
    const catalog = buildCatalog(ws.data);
    expect(catalog.map((p) => p.title)).toEqual(["Notes", "Data", "Deck"]);
    const docItems = catalog[0].items;
    expect(docItems[0]).toMatchObject({ kind: "section", label: "Intro", name: "Intro" });
    expect(docItems.filter((i) => i.kind === "block").map((i) => i.label)).toEqual(["one", "two", "three"]);
    expect(catalog[1].items[0]).toMatchObject({ kind: "table", label: "Costs", locator: { tableId: costs } });
    expect(catalog[2].items[0]).toMatchObject({ kind: "slide", label: "Slide 1", locator: { slideId: "s1" } });
    expect(catalog.map((p) => p.pageId)).toEqual([notes, data, deck]);
  });

  it("filters by page title or item label", () => {
    const { ws } = setup();
    const catalog = buildCatalog(ws.data);
    expect(filterCatalog(catalog, "").length).toBe(3);
    expect(filterCatalog(catalog, "cost").map((p) => p.title)).toEqual(["Data"]);
    expect(filterCatalog(catalog, "notes")[0].items.length).toBe(3);
    expect(filterCatalog(catalog, "zzz")).toEqual([]);
  });
});

describe("ensureSection", () => {
  it("creates implicit sections for tables and slides, named ones for blocks, and reuses them", () => {
    const { ws, notes, data, deck } = setup();
    const catalog = buildCatalog(ws.data);
    const table = catalog[1].items[0];
    const id = ensureSection(ws, table);
    expect(findSection(ws.data, id).section.implicit).toBe(true);
    expect(ensureSection(ws, buildCatalog(ws.data)[1].items[0])).toBe(id);
    const slide = catalog[2].items[0];
    expect(findSection(ws.data, ensureSection(ws, slide)).section.locator).toEqual({ slideId: "s1" });
    const block = catalog[0].items.find((i) => i.label === "two");
    const named = ensureSection(ws, block, "Middle");
    expect(findSection(ws.data, named).section.name).toBe("Middle");
    expect(ws.getPage(notes).content.sections[named].locator).toEqual({ startBlockId: "b2", endBlockId: "b2" });
    expect(ws.getPage(data).content.sections).toBeTruthy();
    expect(deck).toBeTruthy();
  });
});

describe("resizeSection", () => {
  it("grows a run and refuses a locator that is not a sibling run", () => {
    const { ws, notes } = setup();
    ws.dispatch("createSection", { pageId: notes, sectionId: "sec_r", name: "Run", locator: { startBlockId: "b1", endBlockId: "b1" } });
    ws.dispatch("resizeSection", { sectionId: "sec_r", startBlockId: "b1", endBlockId: "b3" });
    expect(ws.getPage(notes).content.sections.sec_r.locator).toEqual({ startBlockId: "b1", endBlockId: "b3" });
    expect(() => ws.dispatch("resizeSection", { sectionId: "sec_r", startBlockId: "b3", endBlockId: "b1" })).toThrow();
    expect(() => ws.dispatch("resizeSection", { sectionId: "nope", startBlockId: "b1", endBlockId: "b1" })).toThrow();
  });
});

describe("suggestNames", () => {
  it("offers names visible from a page, spelled to be written", () => {
    const { ws, notes } = setup();
    ws.dispatch("createSection", { pageId: notes, name: "My intro", locator: { startBlockId: "b1", endBlockId: "b1" } });
    const names = suggestNames(ws.data, notes, "my").map((n) => n.text);
    expect(names).toContain("'My intro'");
    expect(suggestNames(ws.data, notes, "zzz")).toEqual([]);
  });
});
