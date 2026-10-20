import { describe, expect, it, vi } from "vitest";
import { createWorkspace } from "../src/domain/index.js";
import { createQuickFind, findPages } from "../src/app/quick-find.js";

function tree() {
  const ws = createWorkspace({ title: "W" });
  ws.dispatch("createPage", { type: "document", title: "Meeting Notes" });
  ws.dispatch("createPage", { type: "sheet", title: "Budget" });
  const [notes] = ws.getChildren(null);
  ws.dispatch("createPage", { type: "document", title: "Budget Review", parentId: notes });
  ws.dispatch("createPage", { type: "presentation", title: "" });
  return ws;
}

describe("findPages", () => {
  it("lists every page in tree order for an empty query", () => {
    const ws = tree();
    expect(findPages(ws, "").map((r) => r.title)).toEqual(["Meeting Notes", "Budget Review", "Budget", "Untitled"]);
  });

  it("matches case-insensitively on every word", () => {
    const ws = tree();
    expect(findPages(ws, "BUDGET").map((r) => r.title)).toEqual(["Budget Review", "Budget"]);
    expect(findPages(ws, "budget review").map((r) => r.title)).toEqual(["Budget Review"]);
    expect(findPages(ws, "nothing")).toEqual([]);
  });

  it("matches the page type name", () => {
    const ws = tree();
    expect(findPages(ws, "sheet").map((r) => r.title)).toEqual(["Budget"]);
  });

  it("reports the ancestor path", () => {
    const ws = tree();
    expect(findPages(ws, "review")[0].path).toBe("Meeting Notes");
    expect(findPages(ws, "budget").find((r) => r.title === "Budget")?.path).toBe("");
  });
});

describe("createQuickFind", () => {
  function mount() {
    const ws = tree();
    const container = document.createElement("div");
    document.body.append(container);
    const onSelect = vi.fn();
    const quickFind = createQuickFind(ws, { container, onSelect });
    const input = () => /** @type {HTMLInputElement} */ (container.querySelector(".quick-find-input"));
    const type = (/** @type {string} */ text) => {
      input().value = text;
      input().dispatchEvent(new Event("input"));
    };
    const key = (/** @type {string} */ k) =>
      input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    return { ws, container, onSelect, quickFind, input, type, key };
  }

  it("opens an overlay listing every page", () => {
    const { quickFind, container } = mount();
    expect(quickFind.isOpen()).toBe(false);
    quickFind.open();
    expect(quickFind.isOpen()).toBe(true);
    expect(container.querySelectorAll(".quick-find-item")).toHaveLength(4);
    expect(container.querySelector(".quick-find-item.is-highlighted")).toBeTruthy();
  });

  it("filters as you type and shows an empty state", () => {
    const { quickFind, container, type } = mount();
    quickFind.open();
    type("review");
    expect(container.querySelectorAll(".quick-find-item")).toHaveLength(1);
    type("zzz");
    expect(container.querySelector(".quick-find-empty")?.textContent).toBe("No matching pages");
  });

  it("moves the highlight with the arrow keys, wrapping around", () => {
    const { quickFind, container, key } = mount();
    quickFind.open();
    const highlighted = () =>
      [...container.querySelectorAll(".quick-find-item")].findIndex((el) => el.classList.contains("is-highlighted"));
    expect(highlighted()).toBe(0);
    key("ArrowDown");
    expect(highlighted()).toBe(1);
    key("ArrowUp");
    key("ArrowUp");
    expect(highlighted()).toBe(3);
  });

  it("opens the highlighted page on Enter and closes", () => {
    const { quickFind, container, onSelect, key, type, ws } = mount();
    quickFind.open();
    type("budget");
    key("ArrowDown");
    key("Enter");
    const budget = ws.getPages().find((p) => p.title === "Budget");
    expect(onSelect).toHaveBeenCalledWith(budget?.id);
    expect(container.querySelector(".quick-find-backdrop")).toBeNull();
    expect(quickFind.isOpen()).toBe(false);
  });

  it("selects a page on click", () => {
    const { quickFind, container, onSelect } = mount();
    quickFind.open();
    /** @type {HTMLElement} */ (container.querySelectorAll(".quick-find-item")[1]).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(quickFind.isOpen()).toBe(false);
  });

  it("closes on Escape and on a backdrop press, without selecting", () => {
    const { quickFind, container, onSelect, key } = mount();
    quickFind.open();
    key("Escape");
    expect(quickFind.isOpen()).toBe(false);

    quickFind.open();
    /** @type {HTMLElement} */ (container.querySelector(".quick-find-backdrop")).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true })
    );
    expect(quickFind.isOpen()).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not stack a second overlay when opened twice", () => {
    const { quickFind, container } = mount();
    quickFind.open();
    quickFind.open();
    expect(container.querySelectorAll(".quick-find-backdrop")).toHaveLength(1);
  });
});
