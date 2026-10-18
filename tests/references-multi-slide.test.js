import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { createObject } from "../src/presentation/model.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { registerPresentationCommands } from "../src/presentation/commands.js";
import { validateWorkspace } from "../src/workspace/schema.js";
import {
  findSection,
  findSectionByLocator,
  locatorSlideIds,
  sectionPlainText,
  sectionSlideIds,
  slideLocator
} from "../src/references/sections.js";
import { shapeOfSection, fitOf } from "../src/references/fit.js";
import { buildCatalog, ensureSection } from "../src/references/catalog.js";
import { copySectionContent } from "../src/references/detached.js";
import { renderSectionById } from "../src/app/reference-render.js";

/** Deck: s1 s2 s3 s4 (each with a text box naming it). Notes: an empty document. */
function setup() {
  const ws = Workspace.create({ title: "W" });
  registerDocumentCommands(ws);
  registerPresentationCommands(ws);
  ws.dispatch("createPage", { type: "presentation", title: "Deck" });
  ws.dispatch("createPage", { type: "document", title: "Notes" });
  const [deck, notes] = ws.getChildren(null);
  for (const id of ["s1", "s2", "s3", "s4"]) {
    ws.dispatch("createSlide", { pageId: deck, layout: "blank", slideId: id });
    ws.dispatch("insertObject", {
      pageId: deck,
      slideId: id,
      object: createObject("text", { x: 0, y: 0, width: 200, height: 50, text: { runs: [{ text: `Text of ${id}` }] } })
    });
  }
  const raw = () => ws._data;
  const section = (name, ids, sectionId) =>
    ws.dispatch("createSection", { pageId: deck, name, locator: slideLocator(ids), sectionId });
  const embed = (sectionId, instanceId = "ref1") =>
    ws.dispatch("insertReference", { pageId: notes, kind: "embed", sectionId, instanceId });
  const fail = (fn) => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return null;
  };
  return { ws, deck, notes, raw, section, embed, fail, page: () => ws.getPage(deck) };
}

describe("slide locators", () => {
  it("is a plain slideId for one slide and carries the whole set for several", () => {
    expect(slideLocator(["a"])).toEqual({ slideId: "a" });
    expect(slideLocator(["a", "b", "a"])).toEqual({ slideId: "a", slideIds: ["a", "b"] });
    expect(locatorSlideIds({ slideId: "a" })).toEqual(["a"]);
    expect(locatorSlideIds({ slideId: "a", slideIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(locatorSlideIds({ startBlockId: "x" })).toEqual([]);
  });

  it("lists the slides in presentation order whatever order the set was written in", () => {
    const { page, section } = setup();
    section("Odd", ["s2", "s4"], "sec");
    const content = page().content;
    expect(sectionSlideIds(content, { slideId: "s4", slideIds: ["s4", "s2"] })).toEqual(["s2", "s4"]);
    expect(sectionSlideIds(content, content.sections.sec.locator)).toEqual(["s2", "s4"]);
  });

  it("accepts any set, not only neighbours", () => {
    const { section, fail, page } = setup();
    expect(fail(() => section("Gap", ["s1", "s3"], "gap"))).toBeNull();
    expect(page().content.sections.gap.locator.slideIds).toEqual(["s1", "s3"]);
  });

  it("rejects a set with a missing slide, a mismatched first id or duplicates", () => {
    const { ws, deck, fail } = setup();
    const make = (locator) => () => ws.dispatch("createSection", { pageId: deck, name: "X", locator });
    expect(fail(make({ slideId: "s1", slideIds: ["s1", "nope"] })).reason).toBe("invalidLocator");
    expect(fail(make({ slideId: "s2", slideIds: ["s1", "s2"] })).reason).toBe("invalidLocator");
    expect(fail(make({ slideId: "s1", slideIds: ["s1", "s1"] })).reason).toBe("invalidLocator");
    expect(fail(make({ slideId: "s1", slideIds: [] })).reason).toBe("invalidLocator");
  });

  it("finds a section by its slide set", () => {
    const { page, section } = setup();
    section("Pair", ["s1", "s2"], "pair");
    expect(findSectionByLocator(page(), slideLocator(["s1", "s2"])).id).toBe("pair");
    expect(findSectionByLocator(page(), { slideId: "s1" })).toBeFalsy();
  });

  it("reads as the text of all its slides", () => {
    const { raw, section } = setup();
    section("Pair", ["s1", "s2"], "pair");
    const text = sectionPlainText(raw(), "pair");
    expect(text).toContain("Text of s1");
    expect(text).toContain("Text of s2");
    expect(text).not.toContain("Text of s3");
  });
});

describe("deleting slides under a multi-slide section", () => {
  it("shrinks the section to the surviving slides", () => {
    const { ws, deck, page, section } = setup();
    section("Trio", ["s1", "s2", "s3"], "trio");
    ws.dispatch("deleteSlide", { pageId: deck, slideId: "s2" });
    expect(page().content.sections.trio.locator).toEqual({ slideId: "s1", slideIds: ["s1", "s3"] });
    ws.dispatch("deleteSlide", { pageId: deck, slideId: "s1" });
    expect(page().content.sections.trio.locator).toEqual({ slideId: "s3" });
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
  });

  it("detaches every slide when all of them go in one command, if something reads the section", () => {
    const { ws, deck, raw, section, embed } = setup();
    section("Pair", ["s2", "s3"], "pair");
    embed("pair");
    ws.dispatch("deleteSlide", { pageId: deck, slideIds: ["s2", "s3"] });
    const found = findSection(raw(), "pair");
    expect(found.detached).toBe(true);
    expect(found.container.type).toBe("presentation");
    expect(found.container.content.slideOrder).toEqual(["s2", "s3"]);
    expect(Object.keys(found.container.content.slides).sort()).toEqual(["s2", "s3"]);
    expect(found.container.content.sections.pair.locator).toEqual({ slideId: "s2", slideIds: ["s2", "s3"] });
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
    ws.undo();
    expect(raw().detached).toBeUndefined();
    expect(findSection(raw(), "pair").detached).toBeFalsy();
  });

  it("drops the section when nothing reads it", () => {
    const { ws, deck, raw, page, section } = setup();
    section("Pair", ["s2", "s3"], "pair");
    ws.dispatch("deleteSlide", { pageId: deck, slideIds: ["s2", "s3"] });
    expect(page().content.sections?.pair).toBeUndefined();
    expect(raw().detached).toBeUndefined();
  });

  it("gives sections sharing a vanished slide one detached entry", () => {
    const { ws, deck, raw, section, embed } = setup();
    section("A", ["s1", "s2"], "a");
    section("B", ["s2", "s3"], "b");
    embed("a", "ref1");
    embed("b", "ref2");
    ws.dispatch("deleteSlide", { pageId: deck, slideIds: ["s1", "s2", "s3"] });
    const a = findSection(raw(), "a");
    const b = findSection(raw(), "b");
    expect(a.detached && b.detached).toBe(true);
    expect(a.containerId).toBe(b.containerId);
    expect(validateWorkspace(ws.serialized).valid).toBe(true);
  });

  it("refuses to delete every slide", () => {
    const { ws, deck, fail } = setup();
    expect(fail(() => ws.dispatch("deleteSlide", { pageId: deck, slideIds: ["s1", "s2", "s3", "s4"] })).reason).toBe("lastSlide");
  });

  it("still deletes a single slide by slideId", () => {
    const { ws, deck, page } = setup();
    ws.dispatch("deleteSlide", { pageId: deck, slideId: "s4" });
    expect(page().content.slideOrder).toEqual(["s1", "s2", "s3"]);
  });
});

describe("copying a multi-slide section", () => {
  it("keeps the slides in order under the same section id", () => {
    const { raw, deck, section } = setup();
    section("Pair", ["s1", "s3"], "pair");
    const found = findSection(raw(), "pair");
    const content = copySectionContent(raw().pages[deck], found.section);
    expect(content.slideOrder).toEqual(["s1", "s3"]);
    expect(Object.keys(content.slides)).toEqual(["s1", "s3"]);
    expect(content.sections.pair.locator).toEqual({ slideId: "s1", slideIds: ["s1", "s3"] });
  });
});

describe("fit", () => {
  it("counts the slides and always breaks the line for several", () => {
    const { raw, section } = setup();
    section("One", ["s1"], "one");
    section("Pair", ["s1", "s2"], "pair");
    const single = shapeOfSection(findSection(raw(), "one"));
    const pair = shapeOfSection(findSection(raw(), "pair"));
    expect(single).toEqual({ kind: "slide", count: 1 });
    expect(pair).toEqual({ kind: "slide", count: 2 });
    const narrow = { displayWidth: 100, containerWidth: 1000 };
    expect(fitOf(single, narrow)).toBe("inline");
    expect(fitOf(pair, narrow)).toBe("break");
  });
});

describe("catalog", () => {
  it("lists single slides as slides and named multi-slide sections as sections", () => {
    const { ws, section } = setup();
    section("Pair", ["s1", "s2"], "pair");
    const deck = buildCatalog(ws.data).find((page) => page.title === "Deck");
    expect(deck.items.filter((item) => item.kind === "slide")).toHaveLength(4);
    const named = deck.items.find((item) => item.kind === "section");
    expect(named).toMatchObject({ label: "Pair", name: "Pair", sectionId: "pair" });
    expect(deck.items.find((item) => item.label === "Slide 1")?.sectionId).toBeUndefined();
  });

  it("makes an implicit section for a plain slide, apart from the multi one", () => {
    const { ws, section } = setup();
    section("Pair", ["s1", "s2"], "pair");
    const deck = buildCatalog(ws.data).find((page) => page.title === "Deck");
    const slide = deck.items.find((item) => item.kind === "slide" && item.label === "Slide 1");
    const id = ensureSection(ws, slide);
    expect(id).not.toBe("pair");
    expect(findSection(ws._data, id).section.locator).toEqual({ slideId: "s1" });
  });
});

describe("rendering", () => {
  const ctx = (ws) => ({ data: ws._data });

  it("stacks every slide of the section in presentation order", () => {
    const { ws, section } = setup();
    section("Pair", ["s1", "s3"], "pair");
    const el = renderSectionById(ctx(ws), "pair");
    expect(el.className).toBe("reference-slides");
    expect([...el.querySelectorAll(".reference-slide")].map((node) => node.dataset.slideId)).toEqual(["s1", "s3"]);
  });

  it("draws a lone slide without the wrapper", () => {
    const { ws, section } = setup();
    section("One", ["s2"], "one");
    const el = renderSectionById(ctx(ws), "one");
    expect(el.className).toBe("reference-slide");
    expect(el.dataset.slideId).toBe("s2");
  });

  it("keeps drawing the surviving slides after one is deleted", () => {
    const { ws, deck, section } = setup();
    section("Trio", ["s1", "s2", "s3"], "trio");
    ws.dispatch("deleteSlide", { pageId: deck, slideId: "s2" });
    const el = renderSectionById(ctx(ws), "trio");
    expect([...el.querySelectorAll(".reference-slide")].map((node) => node.dataset.slideId)).toEqual(["s1", "s3"]);
  });

  it("draws detached slides after the originals are gone", () => {
    const { ws, deck, section, embed } = setup();
    section("Pair", ["s2", "s3"], "pair");
    embed("pair");
    ws.dispatch("deleteSlide", { pageId: deck, slideIds: ["s2", "s3"] });
    const el = renderSectionById(ctx(ws), "pair");
    expect(el.querySelectorAll(".reference-slide")).toHaveLength(2);
  });
});

describe("embedding", () => {
  it("embeds a multi-slide section like any other", () => {
    const { ws, notes, section, embed, fail } = setup();
    section("Pair", ["s1", "s2"], "pair");
    expect(fail(() => embed("pair"))).toBeNull();
    expect(ws.getPage(notes).content.blockOrder).toHaveLength(1);
  });
});
