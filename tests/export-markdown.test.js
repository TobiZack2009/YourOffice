import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { exportPages } from "../src/export/index.js";
import { exportFixture } from "./export-fixture.js";

const fileText = (result, path) => result.files.find((f) => f.path === path)?.text;

/** A one-page workspace whose document holds the given blocks; returns that page's Markdown. */
function render(blocks, request = {}) {
  const ws = createWorkspace({ title: "W" });
  const { pageId } = ws.dispatch("createPage", { type: "document", title: "Page" });
  blocks.forEach((block, i) => ws.dispatch("insertBlock", { pageId, newBlockId: `b${i}`, block }));
  const result = exportPages(ws, { format: "markdown", ...request }, { document });
  return fileText(result, "Page.md");
}
const para = (...runs) => ({ type: "paragraph", runs: runs.map((r) => (typeof r === "string" ? { text: r } : r)) });
const body = (md) => md.replace(/^# Page\n\n/, "").trimEnd();

describe("inline text", () => {
  it("writes marks, keeping spaces outside them", () => {
    const md = render([para("a ", { text: "bold ", marks: { bold: true } }, { text: "it", marks: { italic: true } }, { text: " gone", marks: { strike: true } })]);
    expect(body(md)).toBe("a **bold** *it* ~~gone~~");
  });

  it("nests marks and merges neighbours with the same marks", () => {
    const md = render([para({ text: "a", marks: { bold: true, italic: true } }, { text: "b", marks: { bold: true, italic: true } })]);
    expect(body(md)).toBe("***ab***");
  });

  it("writes code spans around backticks", () => {
    const md = render([para({ text: "a`b", marks: { code: true } })]);
    expect(body(md)).toBe("``a`b``");
  });

  it("escapes characters that would turn into formatting", () => {
    const md = render([para("*stars* and _under_ [x] <tag> back\\slash")]);
    expect(body(md)).toBe("\\*stars\\* and \\_under\\_ \\[x\\] \\<tag\\> back\\\\slash");
  });

  it("escapes line starts that would turn into blocks", () => {
    expect(body(render([para("# not a heading")]))).toBe("\\# not a heading");
    expect(body(render([para("1. not a list")]))).toBe("1\\. not a list");
    expect(body(render([para("- not a bullet")]))).toBe("\\- not a bullet");
  });

  it("turns line breaks into hard breaks", () => {
    expect(body(render([para("one\ntwo")]))).toBe("one  \ntwo");
  });

  it("writes links, encoding what would end the address", () => {
    const md = render([para({ text: "go", marks: { link: "https://example.com/a b(c)" } })]);
    expect(body(md)).toBe("[go](https://example.com/a%20b%28c%29)");
  });

  it("leaves out empty paragraphs", () => {
    expect(body(render([{ type: "paragraph", runs: [] }, para("x")]))).toBe("x");
  });
});

describe("blocks", () => {
  it("shifts headings below the page title", () => {
    const md = render([
      { type: "heading", level: 1, runs: [{ text: "One" }] },
      { type: "heading", level: 3, runs: [{ text: "Three" }] }
    ]);
    expect(body(md)).toBe("## One\n\n#### Three");
  });

  it("writes quotes, rules and fenced code (longer fence when the code holds one)", () => {
    const md = render([
      { type: "quote", runs: [{ text: "line" }] },
      { type: "divider" },
      { type: "code", language: "py", text: "x = '''\n```" }
    ]);
    expect(body(md)).toBe("> line\n\n---\n\n````py\nx = '''\n```\n````");
  });

  it("writes ordered and nested lists", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId } = ws.dispatch("createPage", { type: "document", title: "Page" });
    ws.dispatch("insertBlock", {
      pageId,
      newBlockId: "l",
      block: { type: "list", ordered: true, items: [{ id: "i1", runs: [{ text: "a" }] }, { id: "i2", runs: [{ text: "b" }] }] }
    });
    ws.dispatch("insertBlock", {
      pageId,
      newBlockId: "inner",
      block: { type: "list", ordered: false, items: [{ id: "j1", runs: [{ text: "x" }] }] },
      parent: { blockId: "l", itemId: "i1" }
    });
    const md = fileText(exportPages(ws, { format: "markdown" }), "Page.md");
    expect(body(md)).toBe("1. a\n   - x\n2. b");
  });

  it("writes images by reference, once per asset", () => {
    const { ws, notes, assetId } = exportFixture();
    ws.dispatch("insertBlock", { pageId: notes, newBlockId: "again", block: { type: "image", assetId, alt: "Again [x]" } });
    const md = fileText(exportPages(ws, { format: "markdown", pageIds: [notes], includeChildren: false, includeLinked: false }), "Notes.md");
    expect(md).toContain("![A dot][image-1]");
    expect(md).toContain("![Again \\[x\\]][image-1]");
    expect(md.match(/^\[image-1\]: data:image\/png;base64,iVBORw0KGgo=$/gm)).toHaveLength(1);
    expect(md).not.toContain("image-2");
  });

  it("names a missing image instead of failing", () => {
    const ws = createWorkspace({ title: "W" });
    const { pageId } = ws.dispatch("createPage", { type: "document", title: "Page" });
    ws.dispatch("insertBlock", { pageId, newBlockId: "i", block: { type: "image", assetId: "asset_gone", alt: "Lost" } });
    const result = exportPages(ws, { format: "markdown" });
    expect(fileText(result, "Page.md")).toContain("*Lost*");
    expect(result.warnings[0]).toMatch(/missing/i);
  });
});

describe("embedded content", () => {
  const { ws, notes } = exportFixture();
  const result = exportPages(ws, { format: "markdown", pageIds: [notes], includeChildren: false, includeLinked: false }, { document });
  const md = fileText(result, "Notes.md");

  it("writes an embedded table as a table", () => {
    expect(md).toContain("| 5 | 10 |\n| --- | --- |\n| 7 |  |");
  });

  it("writes an embedded slide as an image", () => {
    expect(md).toContain("![Slide 1: Welcome][slide-1]");
    expect(md).toMatch(/^\[slide-1\]: data:image\/svg\+xml;base64,/m);
  });

  it("writes an expression as its result", () => {
    expect(md).toContain("\n6\n");
  });

  it("lists slides by name when there is no DOM to draw them", () => {
    const plain = exportPages(ws, { format: "markdown", pageIds: [notes], includeChildren: false, includeLinked: false });
    expect(fileText(plain, "Notes.md")).toContain("*Slide 1: Welcome*");
    expect(plain.warnings.join(" ")).toMatch(/slides/i);
  });
});

describe("links between pages", () => {
  it("points at the exported file", () => {
    const { ws, notes } = exportFixture();
    const md = fileText(exportPages(ws, { format: "markdown", pageIds: [notes] }), "Notes.md");
    expect(md).toContain("and [Other](Other.md)");
    expect(md).toContain("\n[Other](Other.md)\n");
  });

  it("is relative to the file that holds the link", () => {
    const { ws, child, other } = exportFixture();
    ws.dispatch("insertBlock", { pageId: child, newBlockId: "back", block: { type: "pageLink", pageId: other } });
    const result = exportPages(ws, { format: "markdown", pageIds: [child, other], subfolders: true });
    expect(result.files.map((f) => f.path)).toContain("Child.md");
    expect(fileText(result, "Child.md")).toContain("[Other](Other.md)");
    const nested = exportPages(ws, { format: "markdown", pageIds: [ws.getChildren(null)[0]], subfolders: true });
    expect(fileText(nested, "Notes/Child.md")).toContain("[Other](../Other.md)");
  });

  it("leaves the text but drops the link when the page is not exported", () => {
    const { ws, notes } = exportFixture();
    const md = fileText(exportPages(ws, { format: "markdown", pageIds: [notes], includeLinked: false }), "Notes.md");
    expect(md).toContain("and Other [site]");
    expect(md).not.toContain("](Other.md)");
  });
});

describe("sheets and presentations", () => {
  it("writes a heading and a table per table, escaping pipes", () => {
    const { ws, data, costs } = exportFixture();
    ws.dispatch("setCell", { pageId: data, tableId: costs, col: 2, row: 0, cell: { value: "a|b" } });
    const md = fileText(exportPages(ws, { format: "markdown", pageIds: [data] }), "Data.md");
    expect(md).toBe("# Data\n\n## Costs\n\n| 5 | 10 | a\\|b |\n| --- | --- | --- |\n| 7 |  |  |\n");
  });

  it("puts every slide on the page as an image", () => {
    const { ws, deck } = exportFixture();
    const md = fileText(exportPages(ws, { format: "markdown", pageIds: [deck] }, { document }), "Deck.md");
    expect(md).toMatch(/^# Deck\n\n!\[Slide 1: Welcome\]\[slide-1\]\n\n!\[Slide 2\]\[slide-2\]\n\n\[slide-1\]: data:image\/svg\+xml;base64,/);
  });

  it("writes a file per slide, linked in order, when slides are sub-pages", () => {
    const { ws, deck } = exportFixture();
    const result = exportPages(ws, { format: "markdown", pageIds: [deck], slides: { mode: "subpages" } }, { document });
    expect(result.files.map((f) => f.path)).toEqual(["Deck.md", "Deck/slide-1.md", "Deck/slide-2.md", "index.md"]);
    expect(fileText(result, "Deck.md")).toContain("- [Slide 1: Welcome](Deck/slide-1.md)\n- [Slide 2](Deck/slide-2.md)");
    const second = fileText(result, "Deck/slide-2.md");
    expect(second).toContain("# Deck: slide 2 of 2");
    expect(second).toContain("[Previous](slide-1.md) | [Overview](../Deck.md)");
    expect(second).not.toContain("Next");
  });
});

describe("layouts", () => {
  it("writes an index of every page, nested as in the sidebar", () => {
    const { ws } = exportFixture();
    const index = fileText(exportPages(ws, { format: "markdown" }), "index.md");
    expect(index).toBe(
      "# My Workspace\n\n- [Notes](Notes.md)\n  - [Child](Child.md)\n- [Other](Other.md)\n- [Data](Data.md)\n- [Deck](Deck.md)\n"
    );
  });

  it("writes one file with anchors and a contents list in the single layout", () => {
    const { ws, notes } = exportFixture();
    const result = exportPages(ws, { format: "markdown", pageIds: [notes], layout: "single" }, { document });
    expect(result.files.map((f) => f.path)).toEqual(["export.md"]);
    const md = result.files[0].text;
    expect(md.startsWith("- [Notes](#page-Notes)\n  - [Child](#page-Child)\n- [Other](#page-Other)\n")).toBe(true);
    expect(md).toContain('<a id="page-Notes"></a>\n\n# Notes');
    expect(md).toContain('<a id="page-Child"></a>\n\n## Child');
    expect(md).toContain("and [Other](#page-Other)");
    expect(md.match(/^\[image-1\]:/gm)).toHaveLength(1);
  });

  it("names the file after the page when it is the only one", () => {
    const { ws, other } = exportFixture();
    const result = exportPages(ws, { format: "markdown", pageIds: [other], layout: "single" });
    expect(result.files.map((f) => f.path)).toEqual(["Other.md"]);
    expect(result.files[0].text).toBe("# Other\n\nother text\n");
  });
});
