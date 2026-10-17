import { afterEach, describe, expect, it } from "vitest";
import { markStateIn, setLinkIn, toggleMarkIn } from "../src/app/marks.js";

function host(html) {
  const el = document.createElement("div");
  el.setAttribute("contenteditable", "true");
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

function select(el, start, end) {
  const text = el.firstChild;
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("marks", () => {
  it("does nothing without a selection inside the host", () => {
    const el = host("hello");
    document.getSelection().removeAllRanges();
    expect(toggleMarkIn(el, "bold")).toBe(false);
    expect(markStateIn(el, "bold")).toBe(false);
  });

  it("does nothing for a collapsed caret", () => {
    const el = host("hello");
    select(el, 2, 2);
    expect(toggleMarkIn(el, "bold")).toBe(false);
  });

  it("wraps the selection and reports the state", () => {
    const el = host("hello world");
    select(el, 0, 5);
    expect(toggleMarkIn(el, "bold")).toBe(true);
    expect(el.querySelector("strong, b")?.textContent).toBe("hello");
    expect(markStateIn(el, "bold")).toBe(true);
    expect(markStateIn(el, "italic")).toBe(false);
  });

  it("unwraps when the selection is already inside the mark", () => {
    const el = host("hello world");
    select(el, 0, 5);
    toggleMarkIn(el, "italic");
    expect(toggleMarkIn(el, "italic")).toBe(true);
    expect(el.querySelector("em, i")).toBeNull();
    expect(el.textContent).toBe("hello world");
  });

  it("links and unlinks the selection", () => {
    const el = host("hello world");
    select(el, 6, 11);
    expect(setLinkIn(el, "https://example.com")).toBe(true);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(setLinkIn(el, "https://other.test")).toBe(true);
    expect(el.querySelector("a")?.getAttribute("href")).toBe("https://other.test");
    expect(setLinkIn(el, "")).toBe(true);
    expect(el.querySelector("a")).toBeNull();
  });

  it("refuses to link a collapsed caret outside a link", () => {
    const el = host("hello");
    select(el, 1, 1);
    expect(setLinkIn(el, "https://example.com")).toBe(false);
  });
});
