import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { exportPages } from "../src/export/index.js";
import { exportFixture } from "./export-fixture.js";

const run = (ws, request) => exportPages(ws, { format: "html", ...request }, { document });
const textOf = (result, path) => result.files.find((f) => f.path === path)?.text;
const parse = (html) => new DOMParser().parseFromString(html, "text/html");

describe("a page file", () => {
  const { ws, notes, other } = exportFixture();
  const result = run(ws, { pageIds: [notes] });
  const doc = parse(textOf(result, "Notes.html"));

  it("is a complete document with its own stylesheet and title", () => {
    expect(textOf(result, "Notes.html").startsWith("<!doctype html>")).toBe(true);
    expect(doc.title).toBe("Notes");
    expect(doc.querySelector("style").textContent).toContain(".slide{");
    expect(doc.querySelector("main h1.page-title").textContent).toBe("Notes");
  });

  it("puts headings below the page title", () => {
    expect(doc.querySelector("main h2").textContent).toBe("Intro");
  });

  it("writes marks and external links safely", () => {
    expect(doc.querySelector("p strong").textContent).toBe("world");
    const external = doc.querySelector('a[href^="https://"]');
    expect(external.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("points links between pages at the exported files", () => {
    const hrefs = [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.filter((h) => h === "Other.html")).toHaveLength(2);
    expect(hrefs.some((h) => h?.startsWith("#") && h.length > 1)).toBe(false);
    expect(textOf(result, "Other.html")).toContain("other text");
    expect(other).toBeTruthy();
  });

  it("removes the editor's attributes", () => {
    const html = textOf(result, "Notes.html");
    for (const attribute of ["data-block-id", "data-block-type", "data-item-id", "contenteditable", "data-ref"]) {
      expect(html).not.toContain(attribute);
    }
  });

  it("carries images as data addresses", () => {
    expect(doc.querySelector("img").getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("draws embedded tables, slides and expressions", () => {
    expect(doc.querySelector(".reference-table td.sheet-cell").textContent).toBe("5");
    expect(doc.querySelector(".reference-slide .slide-text").textContent).toBe("Welcome");
    expect(doc.querySelector(".reference-chip").textContent).toBe("6");
  });

  it("links back to the index", () => {
    expect(doc.querySelector(".export-nav a").getAttribute("href")).toBe("index.html");
  });
});

describe("unexported pages", () => {
  it("keeps the text of a link to a page that is left out", () => {
    const { ws, notes } = exportFixture();
    const result = run(ws, { pageIds: [notes], includeLinked: false, includeChildren: false });
    const doc = parse(textOf(result, "Notes.html"));
    expect([...doc.querySelectorAll("a")].map((a) => a.textContent)).toEqual([" site"]);
    expect(doc.querySelector("p").textContent).toContain("Other site");
    expect(result.files.map((f) => f.path)).toEqual(["Notes.html"]);
  });
});

describe("text is never markup", () => {
  it("escapes titles and content", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId } = ws.dispatch("createPage", { type: "document", title: "<img src=x onerror=alert(1)> & co" });
    ws.dispatch("insertBlock", { pageId, newBlockId: "p", block: { type: "paragraph", runs: [{ text: "<script>alert(1)</script>" }] } });
    const html = textOf(run(ws, {}), "img-src-x-onerror-alert-1-co.html") ?? run(ws, {}).files[0].text;
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; co");
  });
});

describe("sheets", () => {
  it("are plain tables of what the sheet shows, one per table", () => {
    const { ws, data } = exportFixture();
    const doc = parse(textOf(run(ws, { pageIds: [data] }), "Data.html"));
    expect(doc.querySelector(".export-sheet h2").textContent).toBe("Costs");
    const rows = [...doc.querySelectorAll(".export-table tr")].map((tr) => [...tr.children].map((td) => td.textContent));
    expect(rows).toEqual([["5", "10"], ["7", ""]]);
  });
});

describe("presentations", () => {
  it("put every slide on the page as an inline SVG in a scrolling container", () => {
    const { ws, deck } = exportFixture();
    const doc = parse(textOf(run(ws, { pageIds: [deck] }), "Deck.html"));
    const svgs = doc.querySelectorAll(".export-slides svg");
    expect(svgs).toHaveLength(2);
    expect(svgs[0].getAttribute("viewBox")).toBe("0 0 1280 720");
    expect(svgs[0].querySelector("foreignObject .slide-text").textContent).toBe("Welcome");
    expect(doc.querySelectorAll("figcaption")[0].textContent).toBe("Slide 1: Welcome");
  });

  it("get a file per slide, with previous / overview / next, when slides are sub-pages", () => {
    const { ws, deck } = exportFixture();
    const result = run(ws, { pageIds: [deck], slides: { mode: "subpages" } });
    expect(result.files.map((f) => f.path)).toEqual(["Deck.html", "Deck/slide-1.html", "Deck/slide-2.html", "index.html"]);
    const list = parse(textOf(result, "Deck.html"));
    expect([...list.querySelectorAll(".export-slide-list a")].map((a) => a.getAttribute("href"))).toEqual(["Deck/slide-1.html", "Deck/slide-2.html"]);
    expect(list.querySelector("svg")).toBeNull();
    const middle = parse(textOf(result, "Deck/slide-1.html"));
    expect([...middle.querySelectorAll(".export-nav a")].map((a) => a.getAttribute("href"))).toEqual(["../Deck.html", "slide-2.html"]);
    expect(middle.querySelector("svg")).not.toBeNull();
  });
});

describe("index and single file", () => {
  it("lists every page, nested", () => {
    const { ws } = exportFixture();
    const doc = parse(textOf(run(ws, {}), "index.html"));
    expect(doc.querySelector("h1").textContent).toBe("My Workspace");
    expect(doc.querySelector("li > ul > li > a").getAttribute("href")).toBe("Child.html");
    expect([...doc.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Notes", "Child", "Other", "Data", "Deck"]);
  });

  it("puts every page in one file under its own heading, with a contents list", () => {
    const { ws } = exportFixture();
    const result = run(ws, { layout: "single" });
    expect(result.files.map((f) => f.path)).toEqual(["export.html"]);
    const doc = parse(result.files[0].text);
    expect(doc.title).toBe("My Workspace");
    expect(doc.querySelectorAll("article.export-page")).toHaveLength(5);
    expect(doc.querySelector("#page-Child h2.page-title").textContent).toBe("Child");
    expect(doc.querySelector(".export-toc a").getAttribute("href")).toBe("#page-Notes");
    expect(doc.querySelector("#page-Notes a[href='#page-Other']")).not.toBeNull();
    expect(doc.body.hasAttribute("data-sections")).toBe(false);
  });

  it("can show one page at a time, chosen by the address", () => {
    const { ws } = exportFixture();
    const doc = parse(run(ws, { layout: "single", sectionStyle: "target" }).files[0].text);
    expect(doc.body.getAttribute("data-sections")).toBe("target");
    expect(doc.querySelector("style").textContent).toContain(".export-page:target");
  });

  it("does not add contents or the target style to a single page", () => {
    const { ws, other } = exportFixture();
    const doc = parse(run(ws, { pageIds: [other], layout: "single", sectionStyle: "target" }).files[0].text);
    expect(doc.querySelector(".export-toc")).toBeNull();
    expect(doc.body.hasAttribute("data-sections")).toBe(false);
  });
});

describe("needs a DOM", () => {
  it("says so when none is given", () => {
    const { ws } = exportFixture();
    expect(() => exportPages(ws, { format: "html" })).toThrow(/DOM/);
  });
});
