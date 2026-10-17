/** Minimal placeholder shell: proves workspace + document + renderer wiring. */

import { Workspace } from "./workspace/store.js";
import { registerDocumentCommands } from "./document/commands.js";
import { renderDocument } from "./document/render.js";

const workspace = Workspace.create({ title: "My Workspace" });
registerDocumentCommands(workspace);

workspace.dispatch("createPage", { type: "document", title: "Welcome" });
const pageId = workspace.getChildren(null)[0];

workspace.dispatch("insertBlock", {
  pageId,
  block: { type: "heading", level: 1, runs: [{ text: "Welcome to YourOffice" }] }
});

const storedPage = workspace.getPage(pageId);
const headingId = /** @type {import("./document/model.js").DocumentContent} */ (
  storedPage?.content
)?.blockOrder[0];

workspace.dispatch("insertBlock", {
  pageId,
  afterBlockId: headingId,
  block: {
    type: "paragraph",
    runs: [
      { text: "Documents, " },
      { text: "spreadsheets", marks: { bold: true } },
      { text: " and presentations share one workspace." }
    ]
  }
});

const root = document.getElementById("app");
if (!root) throw new Error("missing #app element");

const page = workspace.getPage(pageId);
if (page?.content) {
  root.appendChild(
    renderDocument(/** @type {import("./document/model.js").DocumentContent} */ (page.content))
  );
}
