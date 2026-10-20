import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { defaultTabId, getTabs, EMBED_REASON, THEME_REASON } from "../src/app/ribbon-tabs.js";
import { createRibbon } from "../src/app/ribbon.js";

const ids = (/** @type {any[]} */ list) => list.map((item) => item.id);

/** @param {string | null} type */
const allControls = (type) => getTabs(type).flatMap((tab) => tab.groups.flatMap((group) => group.controls));

describe("getTabs", () => {
  it("brackets every page type with File and View", () => {
    for (const type of ["document", "sheet", "presentation", null]) {
      const tabs = ids(getTabs(type));
      expect(tabs[0]).toBe("file");
      expect(tabs[tabs.length - 1]).toBe("view");
    }
  });

  it("gives documents Home and Insert, sheets Home and Insert, presentations the full set", () => {
    expect(ids(getTabs("document"))).toEqual(["file", "home", "insert", "view"]);
    expect(ids(getTabs("sheet"))).toEqual(["file", "home", "insert", "layout", "view"]);
    expect(ids(getTabs("presentation"))).toEqual([
      "file",
      "home",
      "insert",
      "design",
      "transitions",
      "animations",
      "slideshow",
      "view"
    ]);
  });

  it("only offers File and View when no page is open", () => {
    expect(ids(getTabs(null))).toEqual(["file", "view"]);
    expect(defaultTabId(null)).toBe("file");
  });

  it("defaults to Home for a page", () => {
    expect(defaultTabId("document")).toBe("home");
    expect(defaultTabId("sheet")).toBe("home");
  });

  it("gives every control a unique id within its tab, a label, and the right kind", () => {
    for (const type of ["document", "sheet", "presentation"]) {
      for (const tab of getTabs(type)) {
        const controls = tab.groups.flatMap((group) => group.controls);
        expect(new Set(ids(controls)).size).toBe(controls.length);
        for (const control of controls) {
          expect(control.label).toBeTruthy();
          expect(["button", "toggle", "select", "menu", "field", "color"]).toContain(control.kind);
        }
      }
    }
  });

  it("disables every presentation control without an editor, and keeps the deferred seams explained", () => {
    const ctx = /** @type {any} */ ({ workspace: { canUndo: false, canRedo: false } });
    for (const tab of getTabs("presentation")) {
      if (tab.id === "file") continue;
      for (const control of tab.groups.flatMap((group) => group.controls)) {
        if (control.id === "undo" || control.id === "redo") continue;
        if (tab.id === "view" && !["toggle-inspector", "toggle-snap", "toggle-grid"].includes(control.id)) continue;
        expect(control.enabled?.(ctx), control.id).toBe(false);
      }
    }
    const controls = allControls("presentation");
    expect(controls.find((control) => control.id === "theme")?.disabledReason).toBe(THEME_REASON);
    // Animations are real now: the old seam is gone.
    expect(ids(controls)).not.toContain("add-animation");
  });

  it("offers the presentation view toggles instead of canvas zoom", () => {
    const view = ids(allControls("presentation"));
    expect(view).toContain("toggle-inspector");
    expect(view).toContain("toggle-snap");
    expect(view).toContain("toggle-grid");
    expect(view).not.toContain("zoom");
    expect(ids(allControls("document"))).toContain("zoom");
  });

  it("offers Embed and Expression in the document Insert tab", () => {
    const controls = allControls("document");
    expect(ids(controls)).toContain("reference-embed");
    expect(ids(controls)).toContain("reference-expression");
  });

  it("keeps the sheet embed seam disabled with a reason", () => {
    const seam = allControls("sheet").find((control) => control.id === "embed-reference");
    expect(seam?.enabled?.(/** @type {any} */ ({}))).toBe(false);
    expect(seam?.disabledReason).toBe(EMBED_REASON);
  });

  it("offers merge and unmerge only for sheets", () => {
    const sheet = ids(allControls("sheet"));
    expect(sheet).toContain("merge");
    expect(sheet).toContain("unmerge");
    expect(ids(allControls("document"))).not.toContain("merge");
  });
});

describe("createRibbon", () => {
  function setup() {
    const workspace = Workspace.create({ title: "W" });
    const docEditor = { activeInfo: vi.fn(() => ({ type: "heading", level: 2 })), setActiveType: vi.fn(), toggleMark: vi.fn() };
    const sheetEditor = {
      canMerge: vi.fn(() => false),
      canUnmerge: vi.fn(() => false),
      mergeSelection: vi.fn(),
      canPaste: vi.fn(() => false),
      paste: vi.fn(),
      copy: vi.fn(),
      cut: vi.fn(),
      fillDown: vi.fn(),
      fillRight: vi.fn(),
      fillSelection: vi.fn(),
      getSelection: vi.fn(() => null),
      getRange: vi.fn(() => null),
      selectedRowHeight: vi.fn(() => null),
      selectedColumnWidth: vi.fn(() => null),
      selectedTableName: vi.fn(() => null)
    };
    const ctx = { workspace, page: undefined, docEditor: /** @type {any} */ (null), sheetEditor: /** @type {any} */ (null), shell: /** @type {any} */ ({}) };
    const ribbon = createRibbon(() => ctx);
    document.body.append(ribbon.element);
    return { ribbon, ctx, docEditor, sheetEditor };
  }

  it("renders only File and View with no page", () => {
    const { ribbon } = setup();
    const tabs = [...ribbon.element.querySelectorAll(".ribbon-tab")].map((tab) => tab.getAttribute("data-tab"));
    expect(tabs).toEqual(["file", "view"]);
    expect(ribbon.element.getAttribute("data-page-type")).toBe("none");
  });

  it("renders the tab set of the page type and starts on Home", () => {
    const { ribbon } = setup();
    ribbon.setPage("document");
    expect(ribbon.getActiveTab()).toBe("home");
    expect(ribbon.element.querySelector(".ribbon-tab.is-active")?.getAttribute("data-tab")).toBe("home");
    expect(ribbon.element.querySelector('[data-group="styles"]')).toBeTruthy();
    expect(ribbon.element.querySelector(".ribbon-group-label")?.textContent).toBeTruthy();
  });

  it("remembers the active tab per page type", () => {
    const { ribbon } = setup();
    ribbon.setPage("document");
    ribbon.selectTab("insert");
    ribbon.setPage("sheet");
    expect(ribbon.getActiveTab()).toBe("home");
    ribbon.setPage("document");
    expect(ribbon.getActiveTab()).toBe("insert");
  });

  it("disables editor controls when no editor is open and enables them with one", () => {
    const { ribbon, ctx, docEditor } = setup();
    ribbon.setPage("document");
    const bold = /** @type {HTMLButtonElement} */ (ribbon.element.querySelector('[data-action="mark"][data-mark="bold"]'));
    expect(bold.disabled).toBe(true);

    ctx.docEditor = docEditor;
    ribbon.update();
    expect(bold.disabled).toBe(false);
  });

  it("keeps the size fields off Home and applies them when the value is committed", () => {
    const { ribbon, ctx, sheetEditor } = setup();
    const setSelectedRowHeight = vi.fn();
    ctx.sheetEditor = /** @type {any} */ ({
      ...sheetEditor,
      getSelection: vi.fn(() => ({ tableId: "t", col: 0, row: 0 })),
      setSelectedRowHeight
    });
    ribbon.setPage("sheet");
    expect(ribbon.element.querySelector('[data-control="row-height"]')).toBeNull();

    ribbon.selectTab("layout");
    expect(ribbon.element.querySelector(".ribbon-apply")).toBeNull();
    const field = /** @type {HTMLInputElement} */ (ribbon.element.querySelector('[data-action="row-height"]'));
    expect(field.disabled).toBe(false);
    field.value = "44";
    field.dispatchEvent(new Event("change"));
    expect(setSelectedRowHeight).toHaveBeenCalledWith(44);

    field.value = "50";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(setSelectedRowHeight).toHaveBeenLastCalledWith(50);
  });

  it("reflects the active block type in the style select and runs actions", () => {
    const { ribbon, ctx, docEditor } = setup();
    ctx.docEditor = docEditor;
    ribbon.setPage("document");
    const style = /** @type {HTMLSelectElement} */ (ribbon.element.querySelector('[data-action="block-style"]'));
    expect(style.value).toBe("heading-2");

    style.value = "heading-1";
    style.dispatchEvent(new Event("change"));
    expect(docEditor.setActiveType).toHaveBeenCalledWith({ type: "heading", level: 1 });

    style.value = "paragraph";
    style.dispatchEvent(new Event("change"));
    expect(docEditor.setActiveType).toHaveBeenCalledWith({ type: "paragraph" });

    const quote = /** @type {HTMLButtonElement} */ (ribbon.element.querySelector('[data-action="block-type"][data-type="quote"]'));
    quote.click();
    expect(docEditor.setActiveType).toHaveBeenCalledWith({ type: "quote", level: undefined });
  });

  it("keeps editor focus: pressing a ribbon button cancels mousedown", () => {
    const { ribbon, ctx, docEditor } = setup();
    ctx.docEditor = docEditor;
    ribbon.setPage("document");
    const bold = /** @type {HTMLElement} */ (ribbon.element.querySelector('[data-action="mark"][data-mark="bold"]'));
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    bold.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("explains disabled controls through the tooltip and does not run them", () => {
    const { ribbon } = setup();
    ribbon.setPage("presentation");
    ribbon.selectTab("animations");
    const control = /** @type {HTMLButtonElement} */ (ribbon.element.querySelector(".ribbon-panel .ribbon-button"));
    expect(control.disabled).toBe(true);
    expect(control.title).toBe("Select an object to animate");
  });

  it("enables Merge from the editor's state", () => {
    const { ribbon, ctx, sheetEditor } = setup();
    ctx.sheetEditor = /** @type {any} */ (sheetEditor);
    ribbon.setPage("sheet");
    const merge = /** @type {HTMLButtonElement} */ (ribbon.element.querySelector('[data-action="merge"]'));
    expect(merge.disabled).toBe(true);

    sheetEditor.canMerge.mockReturnValue(true);
    ribbon.update();
    expect(merge.disabled).toBe(false);
    merge.click();
    expect(sheetEditor.mergeSelection).toHaveBeenCalled();
  });

  it("wires the sheet clipboard controls to the editor", () => {
    const { ribbon, ctx, sheetEditor } = setup();
    ctx.sheetEditor = /** @type {any} */ (sheetEditor);
    sheetEditor.getSelection.mockReturnValue(/** @type {any} */ ({ tableId: "t", col: 0, row: 0 }));
    ribbon.setPage("sheet");
    const button = (/** @type {string} */ action) =>
      /** @type {HTMLButtonElement} */ (ribbon.element.querySelector(`[data-action="${action}"]`));

    expect(button("paste").disabled).toBe(true);
    sheetEditor.canPaste.mockReturnValue(true);
    ribbon.update();
    expect(button("paste").disabled).toBe(false);

    for (const [action, method] of [
      ["paste", "paste"],
      ["copy", "copy"],
      ["cut", "cut"]
    ]) {
      button(action).click();
      expect(sheetEditor[method]).toHaveBeenCalled();
    }
  });

  it("leaves fill and row/column structure to the sheet's handle and context menu", () => {
    const { ribbon } = setup();
    ribbon.setPage("sheet");
    for (const tab of ["home", "insert"]) {
      ribbon.selectTab(tab);
      for (const action of ["fill-down", "fill-right", "fill-selection", "add-row", "delete-row", "add-column", "delete-column"]) {
        expect(ribbon.element.querySelector(`[data-action="${action}"]`)).toBeNull();
      }
    }
  });

  it("offers one Link control on the document Insert tab for both pages and addresses", () => {
    const { ribbon } = setup();
    ribbon.setPage("document");
    ribbon.selectTab("insert");
    expect(ribbon.element.querySelectorAll('[data-action="link"]')).toHaveLength(1);
    expect(ribbon.element.querySelector('[data-action="insert-page-link-menu"]')).toBeNull();
  });

  it("opens a menu popover for menu controls and closes it on tab change", () => {
    const { ribbon, ctx, docEditor } = setup();
    ctx.docEditor = docEditor;
    ribbon.setPage("document");
    ribbon.selectTab("insert");
    /** @type {HTMLElement} */ (ribbon.element.querySelector('[data-action="insert-heading-menu"]')).click();
    expect(ribbon.element.querySelector(".popover .menu")).toBeTruthy();
    ribbon.selectTab("home");
    expect(ribbon.element.querySelector(".popover")).toBeNull();
  });
});
