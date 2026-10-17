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
  it("renders sidebar, toolbar and canvas", () => {
    const { root } = setup();
    expect(query(root, ".sidebar")).toBeTruthy();
    expect(query(root, ".toolbar")).toBeTruthy();
    expect(query(root, ".canvas")).toBeTruthy();
    expect(root.querySelectorAll("[data-action=block-type]")).toHaveLength(8);
    expect(root.querySelectorAll("[data-action=mark]")).toHaveLength(5);
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

  it("renders a stub for non-document pages", () => {
    const { ws, root } = setup();
    ws.dispatch("createPage", { type: "sheet", title: "Sheet" });
    const sheetId = ws.getChildren(null).slice(-1)[0];
    query(root, ".sidebar");
    const button = /** @type {HTMLElement} */ (
      root.querySelector(`.page-row[data-page-id="${sheetId}"] .page-title`)
    );
    button.click();
    expect(query(root, ".stub")?.textContent).toContain("Spreadsheet");
    expect(query(root, ".document-editor")).toBeNull();
  });
});

describe("toolbar actions", () => {
  it("converts the active block to a heading", () => {
    const { root, app, ws, docPageId } = setup();
    app.getEditor()?.focusBlock(ws.getPage(docPageId).content.blockOrder[0], "end");
    query(root, '[data-action="block-type"][data-type="heading"][data-level="1"]')?.click();
    expect(root.querySelector(".document-editor h1")?.textContent).toBe("hello");
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
    query(root, '[data-action="insert"]')?.click();
    query(root, '[data-action="insert-item"][data-insert="divider"]')?.click();
    const order = ws.getPage(docPageId).content.blockOrder;
    expect(order).toHaveLength(2);
    expect(ws.getPage(docPageId).content.blocks[order[1]].type).toBe("divider");
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

describe("sidebar integration", () => {
  it("creates a document page with a starter paragraph and selects it", () => {
    const { ws, root, app } = setup();
    const buttons = root.querySelectorAll(".new-page");
    /** @type {HTMLElement} */ (buttons[0]).click();

    const pages = ws.getChildren(null);
    expect(pages).toHaveLength(2);
    const created = pages[1];
    expect(ws.getPage(created)?.type).toBe("document");
    expect(ws.getPage(created)?.content.blockOrder).toHaveLength(1);
    expect(app.getSelection()).toBe(created);
    expect(query(root, ".document-editor")).toBeTruthy();
  });

  it("creates sheet pages that show the stub", () => {
    const { ws, root, app } = setup();
    /** @type {HTMLElement} */ (root.querySelectorAll(".new-page")[1]).click();
    const created = ws.getChildren(null).slice(-1)[0];
    expect(ws.getPage(created)?.type).toBe("sheet");
    expect(app.getSelection()).toBe(created);
    expect(query(root, ".stub")).toBeTruthy();
  });

  it("deletes a page after confirmation and reselects", () => {
    const { ws, root, app, docPageId } = setup();
    /** @type {HTMLElement} */ (root.querySelectorAll(".new-page")[0]).click();
    const created = ws.getChildren(null).slice(-1)[0];

    const remove = /** @type {HTMLElement} */ (
      root.querySelector(`.page-row[data-page-id="${created}"] .page-delete`)
    );
    remove.click();
    expect(ws.getPage(created)).toBeUndefined();
    expect(app.getSelection()).toBe(docPageId);
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
    /** @type {HTMLElement} */ (root.querySelector(".page-delete")).click();
    expect(confirm).toHaveBeenCalled();
    expect(ws.getPage(pageId)).toBeTruthy();
  });
});
