import { describe, expect, it } from "vitest";
import {
  FRAGMENT_MIME,
  fragmentText,
  inlineRunsOf,
  planFragment,
  readFragment,
  sliceRuns,
  sliceUnits,
  textToFragment
} from "../src/app/block-fragment.js";

const content = {
  blocks: {
    a: { id: "a", type: "paragraph", runs: [{ text: "Hello " }, { text: "world", marks: { bold: true } }] },
    b: { id: "b", type: "heading", level: 2, runs: [{ text: "Title" }] },
    l: {
      id: "l",
      type: "list",
      ordered: false,
      items: [
        { id: "i1", runs: [{ text: "one" }], children: ["k"] },
        { id: "i2", runs: [{ text: "two" }] }
      ]
    },
    k: { id: "k", type: "paragraph", runs: [{ text: "kid" }] },
    c: { id: "c", type: "code", text: "const x = 1;" }
  }
};

describe("block fragments", () => {
  it("slices runs by text offsets and keeps marks", () => {
    expect(sliceRuns(content.blocks.a.runs, 3, 8)).toEqual([{ text: "lo " }, { text: "wo", marks: { bold: true } }]);
  });

  it("cuts whole and partial units without touching the source", () => {
    const fragment = sliceUnits(content, [
      { blockId: "a", itemId: null, start: 6, end: null },
      { blockId: "b", itemId: null, start: 0, end: 3 }
    ]);
    expect(fragment.blocks.map((b) => b.id)).toEqual(["a", "b"]);
    expect(fragment.blocks[1].runs).toEqual([{ text: "Tit" }]);
    expect(content.blocks.b.runs).toEqual([{ text: "Title" }]);
  });

  it("slices the text of a code block", () => {
    const fragment = sliceUnits(content, [{ blockId: "c", itemId: null, start: 6, end: 7 }]);
    expect(fragment.blocks[0].text).toBe("x");
  });

  it("keeps only the selected list items and the children selected with them", () => {
    const fragment = sliceUnits(content, [
      { blockId: "l", itemId: "i1", start: 0, end: null },
      { blockId: "k", itemId: null, start: 0, end: null }
    ]);
    expect(fragment.blocks).toHaveLength(1);
    expect(fragment.blocks[0].items.map((i) => i.id)).toEqual(["i1"]);
    expect(fragment.blocks[0].items[0].children).toEqual(["k"]);
    expect(Object.keys(fragment.descendants)).toEqual(["k"]);

    const partial = sliceUnits(content, [{ blockId: "l", itemId: "i2", start: 1, end: 3 }]);
    expect(partial.blocks[0].items).toEqual([{ id: "i2", runs: [{ text: "wo" }] }]);
  });

  it("round trips through JSON and rejects anything else", () => {
    const fragment = sliceUnits(content, [{ blockId: "a", itemId: null, start: 0, end: null }]);
    expect(readFragment(JSON.stringify(fragment))).toEqual(fragment);
    expect(readFragment("")).toBeNull();
    expect(readFragment("not json")).toBeNull();
    expect(readFragment(JSON.stringify({ version: 2, blocks: [] }))).toBeNull();
    expect(readFragment(JSON.stringify({ version: 1, blocks: [{ type: "evil" }] }))).toBeNull();
    expect(FRAGMENT_MIME).toContain("youroffice");
  });

  it("plans fresh ids, parents before children", () => {
    const fragment = sliceUnits(content, [
      { blockId: "l", itemId: "i1", start: 0, end: null },
      { blockId: "k", itemId: null, start: 0, end: null }
    ]);
    const plan = planFragment(fragment);
    expect(plan).toHaveLength(2);
    expect(plan[0].blockId).not.toBe("l");
    expect(plan[0].spec.id).toBeUndefined();
    expect(plan[0].spec.items[0].id).not.toBe("i1");
    expect(plan[0].spec.items[0].children).toBeUndefined();
    expect(plan[1].parent).toEqual({ blockId: plan[0].blockId, itemId: plan[0].spec.items[0].id });
    expect(plan[1].blockId).not.toBe("k");
  });

  it("reduces single text blocks to inline runs", () => {
    expect(inlineRunsOf(sliceUnits(content, [{ blockId: "a", itemId: null, start: 0, end: 5 }]))).toEqual([{ text: "Hello" }]);
    expect(inlineRunsOf(sliceUnits(content, [{ blockId: "l", itemId: "i2", start: 0, end: null }]))).toEqual([{ text: "two" }]);
    expect(inlineRunsOf(sliceUnits(content, [{ blockId: "c", itemId: null, start: 0, end: null }]))).toEqual([{ text: "const x = 1;" }]);
    expect(
      inlineRunsOf(
        sliceUnits(content, [
          { blockId: "a", itemId: null, start: 0, end: null },
          { blockId: "b", itemId: null, start: 0, end: null }
        ])
      )
    ).toBeNull();
  });

  it("writes plain text for several blocks and lists", () => {
    const fragment = sliceUnits(content, [
      { blockId: "a", itemId: null, start: 0, end: null },
      { blockId: "l", itemId: "i1", start: 0, end: null },
      { blockId: "l", itemId: "i2", start: 0, end: null }
    ]);
    expect(fragmentText(fragment)).toBe("Hello world\n\n- one\n- two");
  });

  it("turns plain text into one paragraph per non-empty line", () => {
    const fragment = textToFragment("one\r\n\r\ntwo\nthree");
    expect(fragment.blocks.map((b) => b.runs[0].text)).toEqual(["one", "two", "three"]);
    expect(textToFragment("").blocks).toHaveLength(0);
  });
});
