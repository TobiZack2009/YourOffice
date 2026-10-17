import { describe, expect, it } from "vitest";
import {
  parseInlineRuns,
  mergeRuns,
  runsEqual,
  runsToPlainText,
  normalizeText
} from "../src/app/inline.js";

/** @param {string} html */
function element(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

describe("normalizeText", () => {
  it("turns non-breaking spaces into ordinary spaces", () => {
    expect(normalizeText("a\u00a0b")).toBe("a b");
  });
});

describe("parseInlineRuns", () => {
  it("parses plain text", () => {
    expect(parseInlineRuns(element("hello"))).toEqual([{ text: "hello" }]);
  });

  it("parses mark elements", () => {
    expect(parseInlineRuns(element("<strong>b</strong><em>i</em><u>u</u><s>s</s><code>c</code>"))).toEqual([
      { text: "b", marks: { bold: true } },
      { text: "i", marks: { italic: true } },
      { text: "u", marks: { underline: true } },
      { text: "s", marks: { strike: true } },
      { text: "c", marks: { code: true } }
    ]);
  });

  it("parses nested marks and links", () => {
    expect(
      parseInlineRuns(element('<a href="https://x.test"><strong>site</strong></a>'))
    ).toEqual([{ text: "site", marks: { bold: true, link: "https://x.test" } }]);
  });

  it("converts line breaks to newline runs", () => {
    expect(parseInlineRuns(element("a<br>b"))).toEqual([{ text: "a\nb" }]);
  });

  it("normalises nbsp and merges adjacent identical runs", () => {
    // Adjacent text nodes with equal marks collapse into one run.
    const div = element("");
    div.appendChild(document.createTextNode("a\u00a0"));
    div.appendChild(document.createTextNode("b"));
    expect(parseInlineRuns(div)).toEqual([{ text: "a b" }]);
  });

  it("drops empty text", () => {
    expect(parseInlineRuns(element("<strong></strong>"))).toEqual([]);
  });
});

describe("mergeRuns", () => {
  it("concatenates adjacent equal-mark runs", () => {
    expect(mergeRuns([{ text: "a" }, { text: "b" }])).toEqual([{ text: "ab" }]);
    expect(
      mergeRuns([
        { text: "a", marks: { bold: true } },
        { text: "b", marks: { bold: true } },
        { text: "c", marks: { italic: true } }
      ])
    ).toEqual([{ text: "ab", marks: { bold: true } }, { text: "c", marks: { italic: true } }]);
  });

  it("ignores false flags in comparisons", () => {
    expect(
      mergeRuns([{ text: "a", marks: { bold: true } }, { text: "b", marks: { bold: true, italic: false } }])
    ).toEqual([{ text: "ab", marks: { bold: true } }]);
  });
});

describe("runsEqual", () => {
  it("compares text and marks", () => {
    expect(runsEqual([{ text: "a" }], [{ text: "a" }])).toBe(true);
    expect(runsEqual([{ text: "a" }], [{ text: "b" }])).toBe(false);
    expect(
      runsEqual([{ text: "a", marks: { bold: true } }], [{ text: "a", marks: { bold: false } }])
    ).toBe(false);
  });
});

describe("runsToPlainText", () => {
  it("joins run text", () => {
    expect(runsToPlainText([{ text: "a" }, { text: "b", marks: { bold: true } }])).toBe("ab");
  });
});
