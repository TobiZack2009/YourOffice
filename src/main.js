/**
 * Vite entry: build a workspace, seed a small welcome document, mount the shell.
 */

import "./app/styles.css";
import { Workspace } from "./workspace/store.js";
import { registerDocumentCommands } from "./document/commands.js";
import { mountApp } from "./app/shell.js";

const workspace = Workspace.create({ title: "My Workspace" });
registerDocumentCommands(workspace);

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

const root = document.getElementById("app");
if (!root) throw new Error("missing #app element");

mountApp(root, workspace);
