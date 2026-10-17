import { describe, expect, it } from "vitest";
import {
  BLOCK_TYPES,
  createBlock,
  createDocumentContent,
  validateBlock,
  validateDocumentContent,
  validateRuns,
  ensureDocumentContent
} from "../src/document/model.js";
import { CommandError } from "../src/core/errors.js";

describe("createBlock", () => {
  it("creates blocks with stable ids and type defaults", () => {
    const paragraph = createBlock("paragraph");
    expect(paragraph.id).toMatch(/^block_/);
    expect(paragraph.runs).toEqual([]);

    const heading = createBlock("heading", { level: 2 });
    expect(heading.level).toBe(2);

    const code = createBlock("code");
    expect(code.text).toBe("");

    const image = createBlock("image", { assetId: "asset_1" });
    expect(image.width).toBeNull();
    expect(image.align).toBe("center");
  });

  it("rejects invalid blocks with CommandError", () => {
    expect(() => createBlock("nonsense")).toThrow(CommandError);
    expect(() => createBlock("heading", { level: 9 })).toThrow(/level/);
    expect(() => createBlock("image")).toThrow(/assetId/);
    expect(() => createBlock("pageLink")).toThrow(/pageId/);
  });

  it("creates a list with one empty item so there is somewhere to type", () => {
    const list = createBlock("list", { ordered: true });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].runs).toEqual([]);
    expect(validateBlock(list)).toEqual([]);
  });

  it("recognises the initial block set", () => {
    for (const type of ["paragraph", "heading", "list", "quote", "code", "divider", "image", "pageLink"]) {
      expect(BLOCK_TYPES).toContain(type);
    }
  });
});

describe("validateRuns", () => {
  it("accepts valid runs and marks", () => {
    expect(
      validateRuns([
        { text: "hi" },
        { text: "bold", marks: { bold: true, italic: false } },
        { text: "link", marks: { link: "https://example.com" } }
      ])
    ).toEqual([]);
  });

  it("rejects non-arrays, empty text, and bad marks", () => {
    expect(validateRuns("x")).toEqual(["runs must be an array"]);
    expect(validateRuns([{ text: "" }])).toContain("runs[0].text must not be empty");
    expect(validateRuns([{ text: "a", marks: { sparkly: true } }])).toContain(
      'runs[0].marks has unknown mark "sparkly"'
    );
    expect(validateRuns([{ text: "a", marks: { bold: "yes" } }])).toContain(
      "runs[0].marks.bold must be a boolean"
    );
    expect(validateRuns([{ text: "a", marks: { link: "" } }])).toContain(
      "runs[0].marks.link must be a non-empty string"
    );
  });
});

describe("validateBlock", () => {
  it("accepts each block type with valid fields", () => {
    const blocks = [
      createBlock("paragraph", { runs: [{ text: "hi" }] }),
      createBlock("heading", { level: 1, runs: [{ text: "Title" }] }),
      createBlock("list", {
        ordered: true,
        items: [{ id: "item_1", runs: [{ text: "one" }] }]
      }),
      createBlock("quote", { runs: [{ text: "q" }] }),
      createBlock("code", { language: "js", text: "1+1" }),
      createBlock("divider"),
      createBlock("image", { assetId: "asset_1", width: 320, align: "left" }),
      createBlock("pageLink", { pageId: "doc_1" }),
      createBlock("sectionRef", { sectionId: "section_1" }),
      createBlock("sheetEmbed", { pageId: "sheet_1", tableId: "table_1" }),
      createBlock("slideRef", { pageId: "pres_1", slideId: "slide_1" })
    ];
    for (const block of blocks) {
      expect(validateBlock(block), block.type).toEqual([]);
    }
  });

  it("rejects unknown types and bad reference targets", () => {
    expect(validateBlock({ id: "b", type: "video" })[0]).toContain("block.type");
    expect(validateBlock({ id: "b", type: "pageLink", pageId: "" })[0]).toContain("pageId");
    expect(validateBlock({ id: "b", type: "image", assetId: "a", align: "diagonal" })[0]).toContain(
      "align"
    );
    expect(validateBlock({ id: "b", type: "list", ordered: "yes", items: [] })[0]).toContain(
      "ordered"
    );
    expect(validateBlock({ id: "b", type: "list", ordered: true, items: "x" })[0]).toContain(
      "items"
    );
  });
});

describe("validateDocumentContent", () => {
  const validContent = () => {
    const a = createBlock("paragraph", { runs: [{ text: "a" }] });
    const b = createBlock("divider");
    return { blockOrder: [a.id, b.id], blocks: { [a.id]: a, [b.id]: b } };
  };

  it("accepts a consistent content object", () => {
    expect(validateDocumentContent(validContent())).toEqual([]);
    expect(validateDocumentContent(createDocumentContent())).toEqual([]);
  });

  it("flags order/registry mismatches", () => {
    const content = validContent();
    content.blockOrder = [content.blockOrder[0], "missing"];
    const errors = validateDocumentContent(content);
    expect(errors.some((e) => e.includes("missing"))).toBe(true);
    expect(errors.some((e) => e.includes("not reachable"))).toBe(true);
  });

  it("flags duplicates in blockOrder", () => {
    const content = validContent();
    content.blockOrder = [content.blockOrder[0], content.blockOrder[0]];
    expect(validateDocumentContent(content).some((e) => e.includes("more than once"))).toBe(true);
  });
});

describe("ensureDocumentContent", () => {
  it("initialises missing content", () => {
    const page = { id: "doc_1", type: "document", title: "", createdAt: "", modifiedAt: "" };
    const content = ensureDocumentContent(/** @type {never} */ (page));
    expect(content).toEqual(createDocumentContent());
    expect(page.content).toEqual(createDocumentContent());
  });

  it("returns existing content untouched", () => {
    const existing = { blockOrder: ["b1"], blocks: { b1: createBlock("divider") } };
    const page = {
      id: "doc_1",
      type: "document",
      title: "",
      createdAt: "",
      modifiedAt: "",
      content: existing
    };
    expect(ensureDocumentContent(/** @type {never} */ (page))).toBe(existing);
  });
});
