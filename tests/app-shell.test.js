import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/store.js";
import { registerDocumentCommands } from "../src/document/commands.js";
import { mountApp } from "../src/app/shell.js";

/** @param {{ seed?: boolean }} [opts] */
function setup(opts = {}) {
  const ws = Workspace.create({ title: "W" });
  registerDocumentCommands(ws);
  let docPageId = null;
  if (opts.seed !== false) {
    ws.dispatch("createPage", { type: "document", title: "Doc" });
    docPageId = ws.getChildren(null)[0];
    ws.dispatch("insertBlock", {
      pageId: docPageId,
      block: { type: "paragraph", runs: [{ text: "hello" }] }
    });
  }
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const app = mountApp(root, ws, { confirm: () => true });
  return { ws, root, app, docPageId };
}

/** @param {HTMLElement} root @param {string} selector */
function query(root, selector) {
  return /** @type {HTMLElement | null} */ (root.querySelector(selector));
}

describe("mountApp layout", () => {
  it("renders sidebar, title strip, ribbon and canvas", () => {
    const { root } = setup();
    expect(query(root, ".sidebar")).toBeTruthy();
    expect(query(root, ".title-strip")).toBeTruthy();
    expect(query(root, ".ribbon")).toBeTruthy();
    expect(query(root, ".canvas")).toBeTruthy();
    expect(root.querySelectorAll("[data-action=block-type]")).toHaveLength(3);
    expect(root.querySelectorAll("[data-action=mark]")).toHaveLength(5);
  });

  it("shows a breadcrumb of workspace, ancestors and page", () => {
    const { ws, root, docPageId } = setup();
    expect(query(root, ".breadcrumb")?.textContent).toBe("W/Doc");
    ws.dispatch("createPage", { type: "document", title: "Child", parentId: docPageId });
    const child = ws.getChildren(docPageId)[0];
    /** @type {HTMLElement} */ (root.querySelector(`[data-page-id="${child}"] .page-title`)).click();
    expect(query(root, ".breadcrumb")?.textContent).toBe("W/Doc/Child");
  });

  it("shows an empty state when there are no pages", () => {
    const { root } = setup({ seed: false });
    expect(query(root, ".canvas-empty")).toBeTruthy();
  });

  it("selects the first page on mount and renders its editor", () => {
    const { root, app, docPageId } = setup();
    expect(app.getSelection()).toBe(docPageId);
    expect(query(root, ".document-editor")).toBeTruthy();
    expect(query(root, ".page-title-input")?.value).toBe("Doc");
  });

  it("renders a sheet editor for sheet pages and a presentation editor for presentations", () => {
    const { ws, root } = setup();
    ws.dispatch("createPage", { type: "sheet", title: "Sheet" });
    const sheetId = ws.getChildren(null).slice(-1)[0];
    const sheetRow = /** @type {HTMLElement} */ (
      root.querySelector(`.page-row[data-page-id="${sheetId}"] .page-title`)
    );
    sheetRow.click();
    expect(query(root, ".sheet-editor")).toBeTruthy();
    expect(query(root, ".document-editor")).toBeNull();

    ws.dispatch("createPage", { type: "presentation", title: "Deck" });
    const deckId = ws.getChildren(null).slice(-1)[0];
    /** @type {HTMLElement} */ (
      root.querySelector(`.page-row[data-page-id="${deckId}"] .page-title`)
    ).click();
    expect(query(root, ".presentation-editor")).toBeTruthy();
    expect(query(root, ".sheet-editor")).toBeNull();
  });
});

describe("contextual ribbon", () => {
  /** @param {HTMLElement} root @param {string} id */
  function openPage(root, id) {
    /** @type {HTMLElement} */ (root.querySelector(`.page-row[data-page-id="${id}"] .page-title`)).click();
  }

  const tabLabels = (/** @type {HTMLElement} */ root) =>
    [...root.querySelectorAll(".ribbon-tab")].map((tab) => tab.textContent);

  it("switches tabs and accent with the page type", () => {
    const { ws, root } = setup();
    expect(query(root, ".app")?.getAttribute("data-page-type")).toBe("document");
    expect(tabLabels(root)).toEqual(["File", "Home", "Insert", "View"]);

    ws.dispatch("createPage", { type: "sheet", title: "S" });
    openPage(root, ws.getChildren(null).slice(-1)[0]);
    expect(query(root, ".app")?.getAttribute("data-page-type")).toBe("sheet");
    expect(query(root, '[data-action="merge"]')).toBeTruthy();
    expect(query(root, '[data-action="block-type"]')).toBeNull();
  });

  it("shows the presentation tab set", () => {
    const { ws, root } = setup();
    ws.dispatch("createPage", { type: "presentation", title: "Deck" });
    openPage(root, ws.getChildren(null).slice(-1)[0]);
    expect(tabLabels(root)).toEqual(
      ["File", "Home", "Insert", "Design", "Transitions", "Animations", "Slide Show", "View"]
    );
    expect(query(root, '[data-action="new-slide"]')).toBeTruthy();
    query(root, '.ribbon-tab[data-tab="animations"]')?.click();
    const appear = /** @type {HTMLButtonElement} */ (query(root, '[data-action="animation-appear"]'));
    expect(appear.disabled).toBe(true);
    expect(appear.title).toContain("Select an object");
  });

  it("offers Embed and Expression on the document Insert tab", () => {
    const { root } = setup();
    query(root, '.ribbon-tab[data-tab="insert"]')?.click();
    expect(query(root, '[data-action="reference-embed"]')).toBeTruthy();
    expect(query(root, '[data-action="reference-expression"]')).toBeTruthy();
  });

  it("hides the sidebar and sets zoom from the View tab", () => {
    const { root } = setup();
    query(root, '.ribbon-tab[data-tab="view"]')?.click();
    query(root, '[data-action="toggle-sidebar"]')?.click();
    expect(query(root, ".app")?.classList.contains("sidebar-collapsed")).toBe(true);

    const zoom = /** @type {HTMLSelectElement} */ (query(root, 'select[data-action="zoom"]'));
    zoom.value = "125";
    zoom.dispatchEvent(new Event("change"));
    expect(query(root, ".canvas")?.style.getPropertyValue("--zoom")).toBe("1.25");
  });

  it("marks the workspace saved from the File tab", () => {
    const { ws, root } = setup();
    expect(ws.dirty).toBe(true);
    query(root, '.ribbon-tab[data-tab="file"]')?.click();
    query(root, '[data-action="save"]')?.click();
    expect(ws.dirty).toBe(false);
    expect(query(root, ".dirty-dot")?.classList.contains("is-dirty")).toBe(false);
  });

  it("exports the workspace as JSON from the File tab", () => {
    const download = vi.fn();
    const ws = Workspace.create({ title: "My Space" });
    registerDocumentCommands(ws);
    const root = document.createElement("div");
    document.body.append(root);
    mountApp(root, ws, { download });
    query(root, '.ribbon-tab[data-tab="file"]')?.click();
    query(root, '[data-action="export-json"]')?.click();
    expect(download).toHaveBeenCalledTimes(1);
    const [filename, text] = download.mock.calls[0];
    expect(filename).toBe("my-space.yourOffice.json");
    expect(JSON.parse(text).metadata.title).toBe("My Space");
  });

  it("renames the workspace from the File tab", () => {
    const { ws, root } = setup();
    query(root, '.ribbon-tab[data-tab="file"]')?.click();
    query(root, '[data-action="rename-workspace"]')?.click();
    const input = /** @type {HTMLInputElement} */ (query(root, '[data-role="workspace-name-input"]'));
    input.value = "Renamed WS";
    query(root, ".popover-apply")?.click();
    expect(ws.title).toBe("Renamed WS");
    expect(query(root, ".breadcrumb")?.textContent).toContain("Renamed WS");
  });
});

describe("ribbon actions", () => {
  it("converts the active block to a heading", () => {
    const { root, app, ws, docPageId } = setup();
    app.getEditor()?.focusBlock(ws.getPage(docPageId).content.blockOrder[0], "end");
    const style = /** @type {HTMLSelectElement} */ (query(root, '[data-action="block-style"]'));
    style.value = "heading-2";
    style.dispatchEvent(new Event("change"));
    expect(root.querySelector(".document-editor h2")?.textContent).toBe("hello");
    style.value = "paragraph";
    style.dispatchEvent(new Event("change"));
    expect(root.querySelector(".document-editor h2")).toBeNull();
    expect(root.querySelector(".document-editor p")?.textContent).toBe("hello");
  });

  it("toggles bold over a selection and marks the model dirty", () => {
    const { root, app, ws, docPageId } = setup();
    const editor = app.getEditor();
    const blockId = ws.getPage(docPageId).content.blockOrder[0];
    editor?.focusBlock(blockId, "start");
    const el = /** @type {HTMLElement} */ (root.querySelector("[contenteditable=true]"));
    const range = document.createRange();
    range.selectNodeContents(el);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    query(root, '[data-action="mark"][data-mark="bold"]')?.click();
    expect(ws.getPage(docPageId).content.blocks[blockId].runs).toEqual([
      { text: "hello", marks: { bold: true } }
    ]);
    expect(query(root, ".dirty-dot")?.classList.contains("is-dirty")).toBe(true);
  });

  it("inserts a divider from the insert menu", () => {
    const { root, app, ws, docPageId } = setup();
    configEditor(app, root, ws, docPageId);
    query(root, '.ribbon-tab[data-tab="insert"]')?.click();
    query(root, '[data-action="insert-item"][data-insert="divider"]')?.click();
    const order = ws.getPage(docPageId).content.blockOrder;
    expect(order).toHaveLength(2);
    expect(ws.getPage(docPageId).content.blocks[order[1]].type).toBe("divider");
  });

  it("inserts a chosen heading level from the insert menu", () => {
    const { root, app, ws, docPageId } = setup();
    configEditor(app, root, ws, docPageId);
    query(root, '.ribbon-tab[data-tab="insert"]')?.click();
    query(root, '[data-action="insert-heading-menu"]')?.click();
    const item = Array.from(root.ownerDocument.querySelectorAll('[data-action="insert-item"][data-insert="heading"]')).find(
      (el) => el.getAttribute("data-level") === "3"
    );
    /** @type {HTMLElement} */ (item).click();
    const { blockOrder, blocks } = ws.getPage(docPageId).content;
    expect(blocks[blockOrder[1]]).toMatchObject({ type: "heading", level: 3 });
  });

  it("applies a link from the popover", () => {
    const { root, app, ws, docPageId } = setup();
    const editor = app.getEditor();
    const blockId = ws.getPage(docPageId).content.blockOrder[0];
    editor?.focusBlock(blockId, "start");
    const el = /** @type {HTMLElement} */ (root.querySelector("[contenteditable=true]"));
    const range = document.createRange();
    range.selectNodeContents(el);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    query(root, '[data-action="link"]')?.click();
    const input = /** @type {HTMLInputElement} */ (query(root, '[data-role="link-input"]'));
    input.value = "https://example.test";
    query(root, ".popover-apply")?.click();
    expect(ws.getPage(docPageId).content.blocks[blockId].runs).toEqual([
      { text: "hello", marks: { link: "https://example.test" } }
    ]);
  });

  it("enables undo and redo according to history", () => {
    const { root, app, ws, docPageId } = setup();
    configEditor(app, root, ws, docPageId);
    expect(query(root, '[data-action="undo"]')?.hasAttribute("disabled")).toBe(false);
    query(root, '[data-action="block-type"][data-type="quote"]')?.click();
    const undo = query(root, '[data-action="undo"]');
    expect(undo?.hasAttribute("disabled")).toBe(false);
    undo?.click();
    expect(query(root, ".document-editor blockquote")).toBeNull();
    expect(query(root, '[data-action="redo"]')?.hasAttribute("disabled")).toBe(false);
  });
});

/** Focus the editor's first block so toolbar actions have a target. */
function configEditor(app, root, ws, pageId) {
  app.getEditor()?.focusBlock(ws.getPage(pageId).content.blockOrder[0], "end");
}

/** @param {HTMLElement} root @param {string} type */
function createViaPicker(root, type) {
  /** @type {HTMLElement} */ (root.querySelector('[data-action="new-page"]')).click();
  /** @type {HTMLElement} */ (root.querySelector(`.new-page[data-type="${type}"]`)).click();
}

/** @param {HTMLElement} root @param {string} pageId */
function deleteViaMenu(root, pageId) {
  /** @type {HTMLElement} */ (root.querySelector(`[data-page-id="${pageId}"] [data-action="page-menu"]`)).click();
  /** @type {HTMLElement} */ (root.querySelector('.menu-item[data-action="delete"]')).click();
}

describe("sidebar integration", () => {
  it("creates a document page with a starter paragraph and selects it", () => {
    const { ws, root, app } = setup();
    createViaPicker(root, "document");

    const pages = ws.getChildren(null);
    expect(pages).toHaveLength(2);
    const created = pages[1];
    expect(ws.getPage(created)?.type).toBe("document");
    expect(ws.getPage(created)?.content.blockOrder).toHaveLength(1);
    expect(app.getSelection()).toBe(created);
    expect(query(root, ".document-editor")).toBeTruthy();
  });

  it("creates sheet pages with a starter table and selects them", () => {
    const { ws, root, app } = setup();
    createViaPicker(root, "sheet");
    const created = ws.getChildren(null).slice(-1)[0];
    expect(ws.getPage(created)?.type).toBe("sheet");
    expect(app.getSelection()).toBe(created);
    expect(app.getSheetEditor()).toBeTruthy();
    expect(query(root, ".sheet-grid")).toBeTruthy();
    const content = /** @type {any} */ (ws.getPage(created)?.content);
    expect(content.tableOrder).toHaveLength(1);
    expect(content.tables[content.tableOrder[0]].rowCount).toBe(12);
  });

  it("deletes a page after confirmation and reselects", () => {
    const { ws, root, app, docPageId } = setup();
    createViaPicker(root, "document");
    const created = ws.getChildren(null).slice(-1)[0];

    deleteViaMenu(root, created);
    expect(ws.getPage(created)).toBeUndefined();
    expect(app.getSelection()).toBe(docPageId);
  });

  it("creates a child page under a parent from the row +", () => {
    const { ws, root, app, docPageId } = setup();
    /** @type {HTMLElement} */ (root.querySelector(`[data-page-id="${docPageId}"] [data-action="add-child"]`)).click();
    /** @type {HTMLElement} */ (root.querySelector('.new-page[data-type="sheet"]')).click();
    const child = ws.getChildren(docPageId)[0];
    expect(ws.getPage(child)?.type).toBe("sheet");
    expect(ws.getChildren(null)).toEqual([docPageId]);
    expect(app.getSelection()).toBe(child);
  });

  it("favorites a page through the row menu and lists it", () => {
    const { ws, root, docPageId } = setup();
    /** @type {HTMLElement} */ (root.querySelector(`[data-page-id="${docPageId}"] [data-action="page-menu"]`)).click();
    /** @type {HTMLElement} */ (root.querySelector('.menu-item[data-action="favorite"]')).click();
    expect(ws.getFavorites()).toEqual([docPageId]);
    expect(root.querySelector(`[data-favorite-id="${docPageId}"]`)).toBeTruthy();
  });

  it("opens quick find with Cmd+K and opens the chosen page", () => {
    const { ws, root, app, docPageId } = setup();
    ws.dispatch("createPage", { type: "sheet", title: "Budget" });
    const sheetId = ws.getChildren(null).slice(-1)[0];
    expect(app.getSelection()).toBe(docPageId);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    const input = /** @type {HTMLInputElement} */ (query(root, ".quick-find-input"));
    expect(input).toBeTruthy();
    input.value = "budg";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(query(root, ".quick-find-backdrop")).toBeNull();
    expect(app.getSelection()).toBe(sheetId);
    expect(query(root, ".sheet-editor")).toBeTruthy();
  });

  it("renames a page and updates the header", () => {
    const { ws, root, docPageId } = setup();
    const title = root.querySelector(`.page-row[data-page-id="${docPageId}"] .page-title`);
    title?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = /** @type {HTMLInputElement} */ (
      root.querySelector(`[data-rename-input="${docPageId}"]`)
    );
    input.value = "Renamed";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(ws.getPage(docPageId)?.title).toBe("Renamed");
    expect(query(root, ".page-title-input")?.value).toBe("Renamed");
  });

  it("renames the page from the header input", () => {
    const { ws, root, docPageId } = setup();
    const headerTitle = /** @type {HTMLInputElement} */ (query(root, ".page-title-input"));
    headerTitle.value = "From header";
    headerTitle.dispatchEvent(new Event("blur"));
    expect(ws.getPage(docPageId)?.title).toBe("From header");
  });
});

describe("lifecycle", () => {
  it("stops responding after destroy", () => {
    const { root, app, ws, docPageId } = setup();
    app.destroy();
    ws.dispatch("renamePage", { pageId: docPageId, title: "Later" });
    expect(root.querySelector(".document-editor")).toBeNull();
    expect(root.childNodes).toHaveLength(0);
  });

  it("uses the confirm option to guard deletion", () => {
    const ws = Workspace.create({ title: "W" });
    registerDocumentCommands(ws);
    ws.dispatch("createPage", { type: "document", title: "Doc" });
    const pageId = ws.getChildren(null)[0];
    const confirm = vi.fn(() => false);
    const root = document.createElement("div");
    document.body.append(root);
    mountApp(root, ws, { confirm });
    deleteViaMenu(root, pageId);
    expect(confirm).toHaveBeenCalled();
    expect(ws.getPage(pageId)).toBeTruthy();
  });
});

describe("indent / outdent buttons", () => {
  it("nest and lift a list item through the ribbon", () => {
    const { root, app, ws, docPageId } = setup();
    ws.dispatch("insertBlock", {
      pageId: docPageId,
      block: {
        type: "list",
        items: [
          { id: "item-a", runs: [{ text: "a" }] },
          { id: "item-b", runs: [{ text: "b" }] }
        ]
      }
    });
    const listId = ws.getPage(docPageId).content.blockOrder[1];
    const second = /** @type {HTMLElement} */ (root.querySelectorAll(".block-item[contenteditable=true]")[1]);
    second.focus();
    second.dispatchEvent(new Event("focusin", { bubbles: true }));
    query(root, '[data-action="indent"]')?.click();
    expect(ws.getPage(docPageId).content.blocks[listId].items).toHaveLength(1);
    expect(root.querySelector(".item-children .block-item")?.textContent).toBe("b");
    query(root, '[data-action="outdent"]')?.click();
    expect(ws.getPage(docPageId).content.blocks[listId].items).toHaveLength(2);
    expect(app.getEditor()?.activeInfo().itemId).toBeTruthy();
  });

  it("are disabled when there is nothing to nest under, and outdent leaves a top-level list", () => {
    const { root, ws, docPageId } = setup();
    ws.dispatch("insertBlock", {
      pageId: docPageId,
      block: { type: "list", items: [{ id: "item-a", runs: [{ text: "a" }] }, { id: "item-b", runs: [{ text: "b" }] }] }
    });
    const items = root.querySelectorAll(".block-item[contenteditable=true]");
    const focus = (el) => {
      el.focus();
      el.dispatchEvent(new Event("focusin", { bubbles: true }));
    };
    focus(items[0]);
    expect(/** @type {HTMLButtonElement} */ (query(root, '[data-action="indent"]')).disabled).toBe(true);
    focus(items[1]);
    expect(/** @type {HTMLButtonElement} */ (query(root, '[data-action="indent"]')).disabled).toBe(false);

    query(root, '[data-action="outdent"]')?.click();
    const { blockOrder, blocks } = ws.getPage(docPageId).content;
    expect(blocks[blockOrder[2]]).toMatchObject({ type: "paragraph", runs: [{ text: "b" }] });
  });
});

describe("presentation pages", () => {
  /** Create a presentation through the sidebar picker and return its page id. */
  function openDeck() {
    const ctx = setup();
    createViaPicker(ctx.root, "presentation");
    const pageId = ctx.ws.getChildren(null).slice(-1)[0];
    return { ...ctx, pageId, content: () => ctx.ws.getPage(pageId).content };
  }

  it("seeds a new presentation with a Title slide and opens the editor on it", () => {
    const { root, content, app } = openDeck();
    expect(query(root, ".presentation-editor")).toBeTruthy();
    expect(content().slideOrder).toHaveLength(1);
    expect(content().slides[content().slideOrder[0]].layout).toBe("title");
    expect(app.getPresentationEditor()?.getSlideId()).toBe(content().slideOrder[0]);
  });

  it("drives the editor from the Home ribbon", () => {
    const { root, content } = openDeck();
    query(root, '[data-action="duplicate-slide"]')?.click();
    expect(content().slideOrder).toHaveLength(2);
    query(root, '[data-action="new-slide"]')?.click();
    query(root, '[data-action="new-slide-layout"][data-layout="blank"]')?.click();
    expect(content().slideOrder).toHaveLength(3);
    query(root, '[data-action="delete-slide"]')?.click();
    expect(content().slideOrder).toHaveLength(2);
  });

  it("arms a shape from Insert and draws it", () => {
    const { root, app, content } = openDeck();
    query(root, '.ribbon-tab[data-tab="insert"]')?.click();
    query(root, '[data-action="insert-shape"]')?.click();
    query(root, '[data-action="insert-shape-item"][data-shape="ellipse"]')?.click();
    expect(app.getPresentationEditor()?.getTool()).toMatchObject({ type: "shape", shape: "ellipse" });
    const stage = /** @type {HTMLElement} */ (query(root, ".stage"));
    const fire = (type, target, x, y) =>
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    fire("mousedown", stage, 40, 500);
    fire("mousemove", document, 240, 600);
    fire("mouseup", document, 240, 600);
    const slide = content().slides[content().slideOrder[0]];
    expect(slide.objects[slide.objectOrder.at(-1)]).toMatchObject({ type: "shape", shape: "ellipse" });
  });

  it("asks scale or keep from the Design tab", () => {
    const { root, content } = openDeck();
    query(root, '.ribbon-tab[data-tab="design"]')?.click();
    query(root, '[data-action="slide-size"]')?.click();
    query(root, '[data-action="slide-size-preset"][data-preset="4:3"]')?.click();
    /** @type {HTMLElement | null} */ (document.querySelector('[data-action="size-keep"]'))?.click();
    expect(content().size).toEqual({ width: 1024, height: 768 });
  });

  it("sets the slide transition from the Transitions tab", () => {
    const { root, content } = openDeck();
    query(root, '.ribbon-tab[data-tab="transitions"]')?.click();
    const style = /** @type {HTMLSelectElement} */ (query(root, '[data-action="transition-style"]'));
    style.value = "fade";
    style.dispatchEvent(new Event("change", { bubbles: true }));
    expect(content().slides[content().slideOrder[0]].transition.style).toBe("fade");
  });

  it("shows the animation timeline only while the Animations tab is open", () => {
    const { root } = openDeck();
    const editor = () => query(root, ".presentation-editor");
    expect(editor()?.classList.contains("show-timeline")).toBe(false);
    query(root, '.ribbon-tab[data-tab="animations"]')?.click();
    expect(editor()?.classList.contains("show-timeline")).toBe(true);
    expect(query(root, '[data-role="animation-timeline"]')).toBeTruthy();
    query(root, '.ribbon-tab[data-tab="home"]')?.click();
    expect(editor()?.classList.contains("show-timeline")).toBe(false);
  });

  it("adds, retimes, reorders and removes animations from the Animations tab", () => {
    const { root, app, content } = openDeck();
    const slide = () => content().slides[content().slideOrder[0]];
    query(root, '.ribbon-tab[data-tab="animations"]')?.click();
    const editor = app.getPresentationEditor();
    editor?.selectAll();
    query(root, '[data-action="animation-fade-in"]')?.click();
    const count = slide().animationOrder.length;
    expect(count).toBeGreaterThan(0);
    expect(query(root, '[data-role="timeline-count"]')?.textContent).toBe(String(count));
    expect(slide().animations[slide().animationOrder[0]]).toMatchObject({ effect: "fade-in", trigger: "click" });

    // Slide in from the menu picks a direction.
    editor?.selectAll();
    query(root, '[data-action="animation-slide-in"]')?.click();
    /** @type {HTMLElement | null} */ (document.querySelector('[data-action="animation-slide-in-item"][data-direction="right"]'))?.click();
    expect(Object.values(slide().animations).some((a) => a.effect === "slide-in" && a.direction === "right")).toBe(true);

    // The newest animation is selected, so Timing edits it.
    const selectedId = editor?.getSelectedAnimation()?.id;
    const delay = /** @type {HTMLInputElement} */ (query(root, '[data-action="animation-delay"]'));
    expect(delay.disabled).toBe(false);
    delay.value = "250";
    delay.dispatchEvent(new Event("change", { bubbles: true }));
    expect(slide().animations[selectedId].delay).toBe(250);

    const trigger = /** @type {HTMLSelectElement} */ (query(root, '[data-action="animation-trigger"]'));
    trigger.value = "after";
    trigger.dispatchEvent(new Event("change", { bubbles: true }));
    expect(slide().animations[selectedId].trigger).toBe("after");

    const before = slide().animationOrder.indexOf(selectedId);
    query(root, '[data-action="animation-earlier"]')?.click();
    expect(slide().animationOrder.indexOf(selectedId)).toBe(before - 1);

    query(root, '[data-action="animation-remove"]')?.click();
    expect(slide().animations[selectedId]).toBeUndefined();
  });

  it("edits the selected animation's effect, distance and choice from the Animations tab", () => {
    const { root, app, content } = openDeck();
    const slide = () => content().slides[content().slideOrder[0]];
    query(root, '.ribbon-tab[data-tab="animations"]')?.click();
    const editor = app.getPresentationEditor();
    const first = slide().objectOrder[0];
    editor?.selectObjects([first]);

    const gallery = (name) => /** @type {HTMLButtonElement} */ (query(root, `[data-action="animation-${name}"]`));
    gallery("appear").click();
    expect(gallery("appear").classList.contains("is-active")).toBe(true);
    expect(slide().animationOrder).toHaveLength(1);

    // The gallery now edits the animation rather than adding a second one.
    gallery("fade-in").click();
    expect(slide().animationOrder).toHaveLength(1);
    expect(Object.values(slide().animations)[0].effect).toBe("fade-in");
    expect(gallery("fade-in").classList.contains("is-active")).toBe(true);
    expect(gallery("appear").classList.contains("is-active")).toBe(false);

    // Add animation always adds, keeping the existing one.
    query(root, '[data-action="animation-add"]')?.click();
    /** @type {HTMLElement | null} */ (document.querySelector('[data-action="animation-add-item"][data-effect="motion"]'))?.click();
    expect(slide().animationOrder).toHaveLength(2);
    const motionId = slide().animationOrder[1];
    expect(slide().animations[motionId].effect).toBe("motion");

    // Motion distance fields move the end point.
    const moveX = /** @type {HTMLInputElement} */ (query(root, '[data-action="animation-move-x"]'));
    expect(moveX.disabled).toBe(false);
    moveX.value = "300";
    moveX.dispatchEvent(new Event("change", { bubbles: true }));
    expect(slide().animations[motionId].path.to.x - slide().animations[motionId].path.from.x).toBe(300);
    const moveY = /** @type {HTMLInputElement} */ (query(root, '[data-action="animation-move-y"]'));
    moveY.value = "-40";
    moveY.dispatchEvent(new Event("change", { bubbles: true }));
    expect(slide().animations[motionId].path.to.y).toBe(-40);

    // The picker chooses which animation the ribbon edits.
    query(root, '[data-action="animation-pick"]')?.click();
    const picks = [...document.querySelectorAll('[data-action="animation-pick-item"]')];
    expect(picks).toHaveLength(2);
    /** @type {HTMLElement} */ (picks[0]).click();
    expect(editor?.getSelectedAnimation()?.id).toBe(slide().animationOrder[0]);
    expect(/** @type {HTMLInputElement} */ (query(root, '[data-action="animation-move-x"]')).disabled).toBe(true);
  });

  it("keeps the timeline open across undo while the Animations tab is active", () => {
    const { root, app } = openDeck();
    query(root, '.ribbon-tab[data-tab="animations"]')?.click();
    app.getPresentationEditor()?.newSlide("blank");
    query(root, '[data-action="undo"]')?.click();
    expect(query(root, ".presentation-editor")?.classList.contains("show-timeline")).toBe(true);
  });

  it("toggles the inspector from the View tab, and keeps the current slide across undo", () => {
    const { root, app, content, ws } = openDeck();
    query(root, '.ribbon-tab[data-tab="view"]')?.click();
    query(root, '[data-action="toggle-inspector"]')?.click();
    expect(query(root, ".presentation-editor")?.classList.contains("hide-inspector")).toBe(true);

    app.getPresentationEditor()?.newSlide("blank");
    const second = content().slideOrder[1];
    ws.undo();
    ws.redo();
    expect(content().slideOrder[1]).toBe(second);
    expect(app.getPresentationEditor()?.getSlideId()).toBe(second);
    // The view state outlives the remount.
    expect(query(root, ".presentation-editor")?.classList.contains("hide-inspector")).toBe(true);
  });
});
