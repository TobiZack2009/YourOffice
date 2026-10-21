/**
 * The welcome workspace a first visit (or a failed restore) opens: a document, a budget sheet
 * and a short deck. Everything is built from the ids the commands return.
 */

import { createWorkspace } from "../domain/index.js";
import { pageContent } from "../workspace/selectors.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */

/**
 * @param {{ title?: string }} [options]
 * @returns {Workspace} A fully installed workspace with its history cleared of "unsaved" state.
 */
export function createDemoWorkspace(options = {}) {
  const workspace = createWorkspace({ title: options.title ?? "My Workspace" });
  seedDemo(workspace);
  workspace.markSaved();
  return workspace;
}

/**
 * An empty workspace with one blank document, for "New workspace".
 * @param {string} title
 * @returns {Workspace}
 */
export function createBlankWorkspace(title) {
  const workspace = createWorkspace({ title });
  workspace.dispatch("createPage", { type: "document", title: "Untitled" });
  workspace.markSaved();
  return workspace;
}

/** @param {Workspace} workspace */
export function seedDemo(workspace) {
  workspace.transact("seed welcome document", () => {
    const { pageId } = workspace.dispatch("createPage", { type: "document", title: "Welcome" });
    workspace.dispatch("insertBlock", {
      pageId,
      block: { type: "heading", level: 1, runs: [{ text: "Welcome to YourOffice" }] }
    });
    workspace.dispatch("insertBlock", {
      pageId,
      block: {
        type: "paragraph",
        runs: [
          { text: "Documents, " },
          { text: "spreadsheets", marks: { bold: true } },
          { text: " and presentations share one workspace, one hierarchy and one history." }
        ]
      }
    });
    workspace.dispatch("insertBlock", {
      pageId,
      block: {
        type: "list",
        ordered: false,
        items: [
          { id: "item-intro-1", runs: [{ text: "Select a block and use the toolbar to restyle it." }] },
          { id: "item-intro-2", runs: [{ text: "Drag pages in the sidebar to nest them." }] }
        ]
      }
    });
  });

  workspace.transact("seed budget sheet", () => {
    const { pageId: sheetId } = workspace.dispatch("createPage", { type: "sheet", title: "Budget" });
    const { tableId } = workspace.dispatch("createTable", {
      pageId: sheetId,
      name: "Q1 Budget",
      rows: 8,
      columns: 4,
      x: 32,
      y: 32
    });
    const cells = [
      [0, 0, "Item"],
      [1, 0, "Cost"],
      [2, 0, "Units"],
      [3, 0, "Total"],
      [0, 1, "Paper"],
      [1, 1, 12],
      [2, 1, 5],
      [3, 1, "=B2*C2"],
      [0, 2, "Ink"],
      [1, 2, 30],
      [2, 2, 2],
      [3, 2, "=B3*C3"],
      [2, 4, "Grand total"],
      [3, 4, "=SUM(D2:D3)"]
    ];
    for (const [col, row, value] of cells) {
      workspace.dispatch("setCell", {
        pageId: sheetId,
        tableId,
        col: Number(col),
        row: Number(row),
        cell: typeof value === "number" ? { value } : { value: String(value) }
      });
    }
  });

  workspace.transact("seed demo deck", () => {
    const { pageId: deckId } = workspace.dispatch("createPage", { type: "presentation", title: "Kickoff deck" });
    const { slideId: first } = workspace.dispatch("createSlide", { pageId: deckId, layout: "title" });
    const { slideId: second } = workspace.dispatch("createSlide", { pageId: deckId, layout: "titleContent" });
    const content = /** @type {any} */ (pageContent(workspace, deckId));
    const [titleId, subtitleId] = content.slides[first].objectOrder;
    workspace.dispatch("setObjectRuns", { pageId: deckId, slideId: first, objectId: titleId, runs: [{ text: "YourOffice" }] });
    workspace.dispatch("setObjectRuns", {
      pageId: deckId,
      slideId: first,
      objectId: subtitleId,
      runs: [{ text: "Documents, sheets and slides in one workspace" }]
    });
    const [heading, body] = content.slides[second].objectOrder;
    workspace.dispatch("setObjectRuns", { pageId: deckId, slideId: second, objectId: heading, runs: [{ text: "Why local-first" }] });
    workspace.dispatch("setObjectRuns", {
      pageId: deckId,
      slideId: second,
      objectId: body,
      runs: [{ text: "Your data stays on your machine" }]
    });
  });
}
