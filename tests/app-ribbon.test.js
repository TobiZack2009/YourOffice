import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { defaultTabId, getTabs, EMBED_REASON, PRESENTATION_REASON } from "../src/app/ribbon-tabs.js";
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
    expect(ids(getTabs("sheet"))).toEqual(["file", "home", "insert", "view"]);
    expect(ids(getTabs("presentation"))).toEqual([
      "file",
      "home",
      "insert",
      "design",
      "transitions",
      "animations",
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
          expect(["button", "toggle", "select", "menu", "field"]).toContain(control.kind);
        }
      }
    }
  });

  it("disables every presentation control except on View, with the reason", () => {
    for (const tab of getTabs("presentation")) {
      if (tab.id === "file" || tab.id === "view") continue;
      for (const control of tab.groups.flatMap((group) => group.controls)) {
        expect(control.enabled?.(/** @type {any} */ ({}))).toBe(false);
        expect(control.disabledReason).toBe(PRESENTATION_REASON);
      }
    }
  });

  it("keeps embed seams disabled in the document Insert tab", () => {
    const embeds = allControls("document").filter((control) => control.id.startsWith("embed-"));
    expect(ids(embeds)).toEqual(["embed-sheet", "embed-slide"]);
    for (const control of embeds) {
      expect(control.enabled?.(/** @type {any} */ ({}))).toBe(false);
      expect(control.disabledReason).toBe(EMBED_REASON);
    }
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

  it("reflects the active block type and runs actions", () => {
    const { ribbon, ctx, docEditor } = setup();
    ctx.docEditor = docEditor;
    ribbon.setPage("document");
    const h2 = /** @type {HTMLButtonElement} */ (
      ribbon.element.querySelector('[data-action="block-type"][data-type="heading"][data-level="2"]')
    );
    const h1 = /** @type {HTMLButtonElement} */ (
      ribbon.element.querySelector('[data-action="block-type"][data-type="heading"][data-level="1"]')
    );
    expect(h2.classList.contains("is-active")).toBe(true);
    expect(h2.getAttribute("aria-pressed")).toBe("true");
    expect(h1.classList.contains("is-active")).toBe(false);

    h1.click();
    expect(docEditor.setActiveType).toHaveBeenCalledWith({ type: "heading", level: 1 });
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
    const control = /** @type {HTMLButtonElement} */ (ribbon.element.querySelector(".ribbon-panel .ribbon-button"));
    expect(control.disabled).toBe(true);
    expect(control.title).toBe(PRESENTATION_REASON);
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

  it("opens a menu popover for menu controls and closes it on tab change", () => {
    const { ribbon, ctx, docEditor } = setup();
    ctx.docEditor = docEditor;
    ribbon.setPage("document");
    ribbon.selectTab("insert");
    /** @type {HTMLElement} */ (ribbon.element.querySelector('[data-action="insert-page-link-menu"]')).click();
    expect(ribbon.element.querySelector(".popover .menu")).toBeTruthy();
    ribbon.selectTab("home");
    expect(ribbon.element.querySelector(".popover")).toBeNull();
  });
});
