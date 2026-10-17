/**
 * Vite entry: build a workspace, seed a small welcome document, mount the shell.
 */

import "./app/styles.css";
import { Workspace } from "./workspace/store.js";
import { registerDocumentCommands } from "./document/commands.js";
import { registerSheetCommands } from "./sheet/commands.js";
import { registerPresentationCommands } from "./presentation/commands.js";
import { createId } from "./core/ids.js";
/** @typedef {import("./workspace/store.js").Workspace} Workspace */
import { mountApp } from "./app/shell.js";

const workspace = Workspace.create({ title: "My Workspace" });
registerDocumentCommands(workspace);
registerSheetCommands(workspace);
registerPresentationCommands(workspace);

workspace.transact("seed welcome document", () => {
  workspace.dispatch("createPage", { type: "document", title: "Welcome" });
  const pageId = workspace.getChildren(null)[0];
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

workspace.markSaved();

workspace.transact("seed budget sheet", () => {
  workspace.dispatch("createPage", { type: "sheet", title: "Budget" });
  const sheetId = workspace.getChildren(null)[1];
  workspace.dispatch("createTable", {
    pageId: sheetId,
    name: "Q1 Budget",
    rows: 8,
    columns: 4,
    x: 32,
    y: 32
  });
  const tableId = /** @type {any} */ (workspace.getPage(sheetId)?.content).tableOrder[0];
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

workspace.markSaved();

workspace.transact("seed demo deck", () => {
  workspace.dispatch("createPage", { type: "presentation", title: "Kickoff deck" });
  const deckId = workspace.getChildren(null)[2];
  const first = createId("slide");
  workspace.dispatch("createSlide", { pageId: deckId, slideId: first, layout: "title" });
  const second = createId("slide");
  workspace.dispatch("createSlide", { pageId: deckId, slideId: second, layout: "titleContent" });
  const content = /** @type {any} */ (workspace.getPage(deckId)?.content);
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

workspace.markSaved();

const root = document.getElementById("app");
if (!root) throw new Error("missing #app element");

/** @type {ReturnType<typeof mountApp> | null} */
let app = null;

/** @param {Workspace} current */
function mount(current) {
  app?.destroy();
  app = mountApp(/** @type {HTMLElement} */ (root), current, { onImport: mount });
}

mount(workspace);
