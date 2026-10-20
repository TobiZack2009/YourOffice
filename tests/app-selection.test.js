import { describe, expect, it } from "vitest";
import {
  clampDocumentSelection,
  clampPresentationSelection,
  readDocumentSelection,
  readPresentationSelection,
  readSheetSelection
} from "../src/app/selection.js";

describe("readDocumentSelection", () => {
  it("accepts text and unit selections and copies them", () => {
    const text = { type: "text", anchor: { blockId: "b", offset: 1 }, focus: { blockId: "b", itemId: "i", offset: 3 } };
    const read = readDocumentSelection(text);
    expect(read).toEqual(text);
    expect(read).not.toBe(text);
    expect(readDocumentSelection({ type: "units", anchor: "a", focus: "b" })).toEqual({ type: "units", anchor: "a", focus: "b" });
  });

  it("rejects malformed values", () => {
    expect(readDocumentSelection(null)).toBeNull();
    expect(readDocumentSelection({ type: "text", anchor: { blockId: "", offset: 0 }, focus: { blockId: "b", offset: 0 } })).toBeNull();
    expect(readDocumentSelection({ type: "text", anchor: { blockId: "b", offset: -1 }, focus: { blockId: "b", offset: 0 } })).toBeNull();
    expect(readDocumentSelection({ type: "units", anchor: 1, focus: "b" })).toBeNull();
    expect(readDocumentSelection({ type: "other" })).toBeNull();
  });
});

describe("clampDocumentSelection", () => {
  const probe = { lengthOf: (id) => (id === "b" ? 5 : null), hasUnit: (key) => key === "a" || key === "b" };

  it("pulls offsets back inside the text and drops missing blocks", () => {
    const sel = { type: "text", anchor: { blockId: "b", offset: 2 }, focus: { blockId: "b", offset: 99 } };
    expect(clampDocumentSelection(sel, probe)).toEqual({ type: "text", anchor: { blockId: "b", offset: 2 }, focus: { blockId: "b", offset: 5 } });
    expect(clampDocumentSelection({ ...sel, focus: { blockId: "gone", offset: 0 } }, probe)).toBeNull();
  });

  it("keeps unit selections only while both ends exist", () => {
    expect(clampDocumentSelection({ type: "units", anchor: "a", focus: "b" }, probe)).not.toBeNull();
    expect(clampDocumentSelection({ type: "units", anchor: "a", focus: "z" }, probe)).toBeNull();
  });
});

describe("readSheetSelection", () => {
  it("reads positions and keeps only well-formed extra rectangles", () => {
    const read = readSheetSelection({
      tableId: "t",
      anchor: { col: 0, row: 1 },
      focus: { col: 2, row: 3 },
      others: [{ start: { col: 0, row: 0 }, end: { col: 1, row: 1 } }, { start: 1, end: 2 }]
    });
    expect(read?.others).toHaveLength(1);
    expect(readSheetSelection({ tableId: "t", anchor: { col: -1, row: 0 }, focus: { col: 0, row: 0 } })).toBeNull();
    expect(readSheetSelection({ anchor: { col: 0, row: 0 }, focus: { col: 0, row: 0 } })).toBeNull();
  });
});

describe("presentation selections", () => {
  it("reads and clamps to the slide and objects that still exist", () => {
    expect(readPresentationSelection({ slideId: "s", objectIds: ["a", "b"] })).toEqual({ slideId: "s", objectIds: ["a", "b"] });
    expect(readPresentationSelection({ slideId: 3, objectIds: [] })).toBeNull();
    expect(readPresentationSelection({ slideId: "s", objectIds: [1] })).toBeNull();
    const content = { slides: { s: { objects: { a: {} } } } };
    expect(clampPresentationSelection({ slideId: "s", objectIds: ["a", "b"] }, content)).toEqual({ slideId: "s", objectIds: ["a"] });
    expect(clampPresentationSelection({ slideId: "gone", objectIds: [] }, content)).toBeNull();
    expect(clampPresentationSelection({ slideId: null, objectIds: [] }, content)).toBeNull();
  });
});
