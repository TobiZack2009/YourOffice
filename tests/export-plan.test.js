import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { linkedPageIds, normalizeRequest, pageOfLink, planExport } from "../src/export/plan.js";
import { exportFixture } from "./export-fixture.js";

const paths = (plan) => plan.pages.map((p) => p.path);
const ids = (plan) => plan.pages.map((p) => p.id);

describe("normalizeRequest", () => {
  it("fills in defaults", () => {
    expect(normalizeRequest({ format: "html" })).toEqual({
      format: "html",
      pageIds: [],
      includeChildren: true,
      includeLinked: true,
      layout: "files",
      subfolders: false,
      sectionStyle: "headings",
      slides: { mode: "gallery", format: "svg" }
    });
  });

  it("falls back to HTML and forbids a single CSV file", () => {
    expect(normalizeRequest({ format: "pdf" }).format).toBe("html");
    expect(normalizeRequest({ format: "csv", layout: "single" }).layout).toBe("files");
  });

  it("drops duplicate page ids", () => {
    expect(normalizeRequest({ format: "html", pageIds: ["a", "a", "b"] }).pageIds).toEqual(["a", "b"]);
  });
});

describe("links", () => {
  it("names a page only through #<pageId>", () => {
    const { ws, other } = exportFixture();
    expect(pageOfLink(ws.data, `#${other}`)).toBe(other);
    expect(pageOfLink(ws.data, "#nope")).toBeNull();
    expect(pageOfLink(ws.data, "https://example.com")).toBeNull();
  });

  it("finds page-link blocks and linked text", () => {
    const { ws, notes, other } = exportFixture();
    expect(linkedPageIds(ws.data, notes)).toEqual([other]);
    expect(linkedPageIds(ws.data, other)).toEqual([]);
  });
});

describe("planExport", () => {
  it("includes every page, in sidebar order, when none are named", () => {
    const { ws, notes, child, other, data, deck } = exportFixture();
    const plan = planExport(ws, { format: "html" });
    expect(ids(plan)).toEqual([notes, child, other, data, deck]);
    expect(plan.pages.map((p) => p.depth)).toEqual([0, 1, 0, 0, 0]);
    expect(paths(plan)).toEqual(["Notes.html", "Child.html", "Other.html", "Data.html", "Deck.html"]);
    expect(plan.indexPath).toBe("index.html");
  });

  it("adds children and linked pages, and says why", () => {
    const { ws, notes, child, other } = exportFixture();
    const plan = planExport(ws, { format: "markdown", pageIds: [notes] });
    expect(ids(plan)).toEqual([notes, child, other]);
    expect(plan.byId.get(notes).origin).toBe("selected");
    expect(plan.byId.get(child).origin).toBe("child");
    expect(plan.byId.get(other).origin).toBe("linked");
  });

  it("leaves out children and linked pages when asked", () => {
    const { ws, notes } = exportFixture();
    const plan = planExport(ws, { format: "html", pageIds: [notes], includeChildren: false, includeLinked: false });
    expect(ids(plan)).toEqual([notes]);
    expect(plan.indexPath).toBeNull();
    expect(plan.singlePath).toBe("Notes.html");
  });

  it("follows links transitively", () => {
    const ws = createWorkspace({ title: "W" });
    const page = (title) => ws.dispatch("createPage", { type: "document", title }).pageId;
    const a = page("A");
    const b = page("B");
    const c = page("C");
    ws.dispatch("insertBlock", { pageId: a, newBlockId: "x", block: { type: "pageLink", pageId: b } });
    ws.dispatch("insertBlock", { pageId: b, newBlockId: "y", block: { type: "pageLink", pageId: c } });
    ws.dispatch("insertBlock", { pageId: c, newBlockId: "z", block: { type: "pageLink", pageId: a } });
    expect(ids(planExport(ws, { format: "html", pageIds: [a] }))).toEqual([a, b, c]);
  });

  it("gives case-insensitively unique file names", () => {
    const ws = createWorkspace({ title: "W" });
    for (const title of ["Notes", "notes", "NOTES", "Index"]) ws.dispatch("createPage", { type: "document", title });
    const plan = planExport(ws, { format: "markdown" });
    expect(paths(plan)).toEqual(["Notes.md", "notes-2.md", "NOTES-3.md", "Index-2.md"]);
    expect(new Set(paths(plan).map((p) => p.toLowerCase())).size).toBe(4);
  });

  it("mirrors the page tree as folders when asked", () => {
    const { ws, notes } = exportFixture();
    const plan = planExport(ws, { format: "html", pageIds: [notes], subfolders: true });
    expect(paths(plan)).toEqual(["Notes.html", "Notes/Child.html", "Other.html"]);
  });

  it("does not use folders in the single layout", () => {
    const { ws } = exportFixture();
    const plan = planExport(ws, { format: "html", layout: "single", subfolders: true });
    expect(paths(plan).every((p) => !p.includes("/"))).toBe(true);
    expect(plan.indexPath).toBeNull();
    expect(plan.singlePath).toBe("export.html");
    expect(plan.pages[0].anchor).toBe("page-Notes");
  });

  it("exports only sheets as CSV and says what it left out", () => {
    const { ws, data } = exportFixture();
    const plan = planExport(ws, { format: "csv" });
    expect(ids(plan)).toEqual([data]);
    expect(plan.skipped).toHaveLength(4);
    expect(plan.skipped[0].reason).toMatch(/sheets/i);
    expect(plan.indexPath).toBeNull();
  });

  it("plans a file per slide for sub-page presentations", () => {
    const { ws, deck } = exportFixture();
    const plan = planExport(ws, { format: "html", pageIds: [deck], slides: { mode: "subpages" } });
    expect(plan.pages[0].slidePaths).toEqual(["Deck/slide-1.html", "Deck/slide-2.html"]);
    expect(plan.indexPath).toBe("index.html");
    expect(planExport(ws, { format: "html", pageIds: [deck], slides: { mode: "subpages" }, layout: "single" }).pages[0].slidePaths).toEqual([]);
  });

  it("ignores page ids that do not exist", () => {
    const { ws, other } = exportFixture();
    expect(ids(planExport(ws, { format: "html", pageIds: ["nope", other], includeLinked: false }))).toEqual([other]);
  });
});
