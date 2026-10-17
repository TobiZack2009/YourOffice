import { describe, expect, it } from "vitest";
import { renderDocument, renderBlock, renderRuns } from "../src/document/render.js";
import { createBlock, createDocumentContent } from "../src/document/model.js";

/** @param {HTMLElement} element @param {string} selector */
const q = (element, selector) => element.querySelector(selector);

describe("renderRuns", () => {
  it("renders plain text", () => {
    const fragment = renderRuns([{ text: "hello" }]);
    expect(fragment.textContent).toBe("hello");
  });

  it("nests marks predictably", () => {
    const span = document.createElement("div");
    span.appendChild(renderRuns([{ text: "x", marks: { bold: true, italic: true } }]));
    expect(q(span, "strong > em")?.textContent).toBe("x");
  });

  it("renders links and code marks", () => {
    const span = document.createElement("div");
    span.appendChild(
      renderRuns([{ text: "site", marks: { link: "https://example.com", code: true } }])
    );
    const anchor = q(span, "a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
    expect(q(span, "a > code")?.textContent).toBe("site");
  });
});

describe("renderBlock", () => {
  it("renders a paragraph with a block id", () => {
    const block = createBlock("paragraph", { runs: [{ text: "Hi" }] });
    const element = renderBlock(block);
    expect(element?.tagName).toBe("P");
    expect(element?.getAttribute("data-block-id")).toBe(block.id);
    expect(element?.textContent).toBe("Hi");
  });

  it("maps heading levels to h1–h3", () => {
    for (const level of [1, 2, 3]) {
      const element = renderBlock(createBlock("heading", { level, runs: [{ text: "T" }] }));
      expect(element?.tagName).toBe(`H${level}`);
    }
    // out-of-range levels are clamped rather than throwing
    expect(renderBlock({ id: "b", type: "heading", level: 9, runs: [] })?.tagName).toBe("H3");
  });

  it("renders ordered and unordered lists with item ids", () => {
    const block = createBlock("list", {
      ordered: true,
      items: [
        { id: "item_a", runs: [{ text: "one" }] },
        { id: "item_b", runs: [{ text: "two" }] }
      ]
    });
    const element = renderBlock(block);
    expect(element?.tagName).toBe("OL");
    const items = element?.querySelectorAll("li") ?? [];
    expect(items).toHaveLength(2);
    expect(items[0].getAttribute("data-item-id")).toBe("item_a");
    expect(items[1].textContent).toBe("two");
  });

  it("renders code with a language class and no markup injection", () => {
    const block = createBlock("code", { language: "js", text: "<script>alert(1)</script>" });
    const element = renderBlock(block);
    const code = q(/** @type {HTMLElement} */ (element), "code");
    expect(code?.className).toBe("language-js");
    expect(code?.querySelector("script")).toBeNull();
    expect(code?.textContent).toBe("<script>alert(1)</script>");
  });

  it("renders a divider", () => {
    expect(renderBlock(createBlock("divider"))?.tagName).toBe("HR");
  });

  it("renders images, using the asset resolver when present", () => {
    const block = createBlock("image", { assetId: "asset_1", width: 200, alt: "diagram" });
    const missing = renderBlock(block);
    expect(missing?.getAttribute("data-missing-asset")).toBe("asset_1");
    expect(missing?.textContent).toBe("diagram");

    const resolved = renderBlock(block, { resolveAssetUrl: (id) => `blob:${id}` });
    const img = q(/** @type {HTMLElement} */ (resolved), "img");
    expect(img?.getAttribute("src")).toBe("blob:asset_1");
    expect(img?.getAttribute("width")).toBe("200");
    expect(img?.getAttribute("alt")).toBe("diagram");
  });

  it("renders page links, resolving titles when possible", () => {
    const block = createBlock("pageLink", { pageId: "doc_1" });
    const plain = renderBlock(block);
    expect(plain?.textContent).toBe("doc_1");
    expect(plain?.getAttribute("href")).toBe("#doc_1");

    const titled = renderBlock(block, { resolvePageTitle: () => "Project Notes" });
    expect(titled?.textContent).toBe("Project Notes");
  });

  it("renders placeholders for reference blocks and skips unknown types", () => {
    expect(renderBlock(createBlock("sheetEmbed", { pageId: "sheet_1" }))?.className).toBe(
      "sheet-embed"
    );
    expect(renderBlock(createBlock("sectionRef", { sectionId: "s1" }))?.className).toBe(
      "section-ref"
    );
    expect(renderBlock(createBlock("slideRef", { pageId: "pres_1" }))?.className).toBe("slide-ref");
    expect(renderBlock({ id: "b", type: "video" })).toBeNull();
  });
});

describe("renderDocument", () => {
  it("renders blocks in order and skips dangling references", () => {
    const content = createDocumentContent();
    const a = createBlock("heading", { level: 1, runs: [{ text: "Title" }] });
    const b = createBlock("paragraph", { runs: [{ text: "Body" }] });
    content.blocks[a.id] = a;
    content.blocks[b.id] = b;
    content.blockOrder = [a.id, b.id];

    const article = renderDocument(content);
    expect(article.className).toBe("document");
    const children = [...article.children];
    expect(children.map((child) => child.tagName)).toEqual(["H1", "P"]);

    // A dangling order entry is skipped, not fatal.
    content.blockOrder.push("ghost");
    expect(renderDocument(content).children).toHaveLength(2);
  });
});
