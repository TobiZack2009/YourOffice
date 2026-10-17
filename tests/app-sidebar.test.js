import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { createSidebar, planDrop } from "../src/app/sidebar.js";

/** Workspace with a small tree: A( a1 ), B */
function tree() {
  const ws = Workspace.create({ title: "Tree" });
  ws.dispatch("createPage", { type: "document", title: "A" });
  ws.dispatch("createPage", { type: "sheet", title: "B" });
  const [a, b] = ws.getChildren(null);
  ws.dispatch("createPage", { type: "document", title: "a1", parentId: a });
  const a1 = ws.getChildren(a)[0];
  return { ws, a, b, a1 };
}

describe("planDrop", () => {
  it("nests a page onto another at the end", () => {
    const { ws, a, b } = tree();
    expect(planDrop(ws, b, { type: "onto", pageId: a })).toEqual({
      newParentId: a,
      index: 1
    });
  });

  it("places before a sibling accounting for the removal", () => {
    const { ws, a, b } = tree();
    // dragging A before B: remove A first, B is now at index 0
    expect(planDrop(ws, a, { type: "before", pageId: b })).toEqual({
      newParentId: null,
      index: 0
    });
  });

  it("places after a sibling", () => {
    const { ws, a, b } = tree();
    expect(planDrop(ws, a, { type: "after", pageId: b })).toEqual({
      newParentId: null,
      index: 1
    });
  });

  it("moves to the top level", () => {
    const { ws, a1 } = tree();
    expect(planDrop(ws, a1, { type: "root" })).toEqual({ newParentId: null, index: 2 });
  });

  it("forbids dropping a page onto itself or its descendant", () => {
    const { ws, a, a1 } = tree();
    expect(planDrop(ws, a, { type: "onto", pageId: a })).toBeNull();
    expect(planDrop(ws, a, { type: "onto", pageId: a1 })).toBeNull();
  });

  it("returns null for unknown pages", () => {
    const { ws, a } = tree();
    expect(planDrop(ws, "ghost", { type: "onto", pageId: a })).toBeNull();
    expect(planDrop(ws, a, { type: "onto", pageId: "ghost" })).toBeNull();
  });
});

/** @param {{ element: HTMLElement }} sidebar @param {string} selector */
function clickIn(sidebar, selector) {
  const target = sidebar.element.querySelector(selector);
  if (!target) throw new Error(`no element for ${selector}`);
  /** @type {HTMLElement} */ (target).click();
}

describe("createSidebar", () => {
  function mount() {
    const { ws, a, b, a1 } = tree();
    const actions = {
      select: vi.fn(),
      create: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      move: vi.fn(),
      renameWorkspace: vi.fn(),
      favorite: vi.fn(),
      openQuickFind: vi.fn()
    };
    const sidebar = createSidebar(ws, actions);
    document.body.append(sidebar.element);
    return { ws, sidebar, actions, a, b, a1 };
  }

  it("renders a row per page with type glyphs", () => {
    const { sidebar } = mount();
    const rows = sidebar.element.querySelectorAll(".page-row");
    expect(rows).toHaveLength(3);
    expect(sidebar.element.querySelector(".type-glyph.type-document svg")?.getAttribute("data-icon")).toBe(
      "page-document"
    );
    expect(sidebar.element.querySelector(".type-glyph.type-sheet svg")?.getAttribute("data-icon")).toBe(
      "page-sheet"
    );
  });

  it("selects a page on click", () => {
    const { sidebar, actions, b } = mount();
    const row = sidebar.element.querySelector(`[data-page-id="${b}"] .page-title`);
    /** @type {HTMLButtonElement} */ (row).click();
    expect(actions.select).toHaveBeenCalledWith(b);
    expect(sidebar.selection()).toBe(b);
    expect(sidebar.element.querySelector(`[data-page-id="${b}"]`)?.classList.contains("is-selected")).toBe(true);
  });

  it("renames a page with a double-click and Enter", () => {
    const { sidebar, actions, a } = mount();
    const title = sidebar.element.querySelector(`[data-page-id="${a}"] .page-title`);
    title?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

    const input = /** @type {HTMLInputElement} */ (
      sidebar.element.querySelector(`[data-rename-input="${a}"]`)
    );
    expect(input).toBeTruthy();
    input.value = "Renamed";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(actions.rename).toHaveBeenCalledWith(a, "Renamed");
  });

  it("cancels a rename on Escape", () => {
    const { sidebar, actions, a } = mount();
    sidebar.element
      .querySelector(`[data-page-id="${a}"] .page-title`)
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = /** @type {HTMLInputElement} */ (
      sidebar.element.querySelector(`[data-rename-input="${a}"]`)
    );
    input.value = "Nope";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(actions.rename).not.toHaveBeenCalled();
    expect(sidebar.element.querySelector(`[data-rename-input="${a}"]`)).toBeNull();
  });

  it("requests deletion from the row \"...\" menu", () => {
    const { sidebar, actions, b } = mount();
    clickIn(sidebar, `[data-page-id="${b}"] [data-action="page-menu"]`);
    clickIn(sidebar, '.menu-item[data-action="delete"]');
    expect(actions.remove).toHaveBeenCalledWith(b);
  });

  it("creates top-level pages of each type from the header type picker", () => {
    const { sidebar, actions } = mount();
    for (const type of ["document", "sheet", "presentation"]) {
      clickIn(sidebar, '[data-action="new-page"]');
      clickIn(sidebar, `.new-page[data-type="${type}"]`);
    }
    expect(actions.create.mock.calls.map((call) => call[0])).toEqual(["document", "sheet", "presentation"]);
    expect(actions.create.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it("creates a child page from the row \"+\"", () => {
    const { sidebar, actions, b } = mount();
    clickIn(sidebar, `[data-page-id="${b}"] [data-action="add-child"]`);
    clickIn(sidebar, '.new-page[data-type="document"]');
    expect(actions.create).toHaveBeenCalledWith("document", b);
  });

  it("collapses and expands children with the caret", () => {
    const { sidebar, a, a1 } = mount();
    expect(sidebar.element.querySelector(`[data-page-id="${a1}"]`)).toBeTruthy();
    clickIn(sidebar, `[data-page-id="${a}"] [data-action="toggle-children"]`);
    expect(sidebar.element.querySelector(`[data-page-id="${a1}"]`)).toBeNull();
    clickIn(sidebar, `[data-page-id="${a}"] [data-action="toggle-children"]`);
    expect(sidebar.element.querySelector(`[data-page-id="${a1}"]`)).toBeTruthy();
  });

  it("lists favorites and toggles them from the menu", () => {
    const { ws, sidebar, actions, a } = mount();
    expect(sidebar.element.querySelector(".sidebar-favorites")).toBeNull();

    clickIn(sidebar, `[data-page-id="${a}"] [data-action="page-menu"]`);
    clickIn(sidebar, '.menu-item[data-action="favorite"]');
    expect(actions.favorite).toHaveBeenCalledWith(a, true);

    ws.dispatch("setFavorite", { pageId: a, favorite: true });
    sidebar.refresh();
    expect(sidebar.element.querySelector(`[data-favorite-id="${a}"] .favorite-title`)?.textContent).toBe("A");

    clickIn(sidebar, `[data-favorite-id="${a}"] [data-action="unfavorite"]`);
    expect(actions.favorite).toHaveBeenLastCalledWith(a, false);
  });

  it("opens quick find from the search field", () => {
    const { sidebar, actions } = mount();
    clickIn(sidebar, '[data-action="quick-find"]');
    expect(actions.openQuickFind).toHaveBeenCalled();
  });

  it("renames the workspace from the title", () => {
    const { sidebar, actions } = mount();
    const title = sidebar.element.querySelector(".workspace-title-text");
    title?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = /** @type {HTMLInputElement} */ (
      sidebar.element.querySelector(".workspace-title-input")
    );
    input.value = "New Name";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(actions.renameWorkspace).toHaveBeenCalledWith("New Name");
  });
});
