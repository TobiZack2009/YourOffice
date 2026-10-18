import { describe, expect, it } from "vitest";
import { fitOf, shapeOfSection, shapeOfValue, INLINE_WIDTH_SHARE } from "../src/references/fit.js";
import { ERR } from "../src/sheet/errors.js";
import { makeRange } from "../src/sheet/values.js";

describe("fitOf", () => {
  it("flows scalars, empty results and errors", () => {
    expect(fitOf({ kind: "scalar" })).toBe("inline");
    expect(fitOf({ kind: "empty" })).toBe("inline");
    expect(fitOf({ kind: "error" })).toBe("inline");
  });

  it("flows a single flowing block and breaks everything else", () => {
    expect(fitOf({ kind: "blocks", count: 1, flowing: true })).toBe("inline");
    expect(fitOf({ kind: "blocks", count: 1, flowing: false })).toBe("break");
    expect(fitOf({ kind: "blocks", count: 2, flowing: true })).toBe("break");
  });

  it("flows a table or slide only when at most half the container wide", () => {
    expect(INLINE_WIDTH_SHARE).toBe(0.5);
    expect(fitOf({ kind: "table" }, { displayWidth: 200, containerWidth: 400 })).toBe("inline");
    expect(fitOf({ kind: "slide" }, { displayWidth: 201, containerWidth: 400 })).toBe("break");
  });

  it("breaks when a width is unknown", () => {
    expect(fitOf({ kind: "table" })).toBe("break");
    expect(fitOf({ kind: "slide" }, { displayWidth: 100 })).toBe("break");
    expect(fitOf({ kind: "slide" }, { containerWidth: 100 })).toBe("break");
  });
});

describe("shapeOfSection / shapeOfValue", () => {
  const docFound = (blocks, ids) => ({
    section: { locator: { startBlockId: ids[0], endBlockId: ids[ids.length - 1] } },
    container: { content: { blockOrder: ids, blocks } }
  });

  it("reads the structure of a text section", () => {
    const paragraph = docFound({ a: { id: "a", type: "paragraph" } }, ["a"]);
    expect(shapeOfSection(paragraph)).toEqual({ kind: "blocks", count: 1, flowing: true });
    const list = docFound({ a: { id: "a", type: "list" } }, ["a"]);
    expect(shapeOfSection(list)).toEqual({ kind: "blocks", count: 1, flowing: false });
    const two = docFound({ a: { id: "a", type: "paragraph" }, b: { id: "b", type: "paragraph" } }, ["a", "b"]);
    expect(shapeOfSection(two).count).toBe(2);
  });

  it("classifies expression values", () => {
    expect(shapeOfValue({}, ERR.NAME).kind).toBe("error");
    expect(shapeOfValue({}, null).kind).toBe("empty");
    expect(shapeOfValue({}, "")).toEqual({ kind: "empty" });
    expect(shapeOfValue({}, 3).kind).toBe("scalar");
    expect(shapeOfValue({}, "text").kind).toBe("scalar");
    expect(shapeOfValue({}, makeRange([1, 2, 3, 4], 2, 2)).kind).toBe("table");
  });

  it("treats a handle to a missing section as an error", () => {
    expect(shapeOfValue({ pages: {}, pageOrder: { root: [] } }, { kind: "blocks", sectionId: "nope" }).kind).toBe("error");
  });
});
