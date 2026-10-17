/** Minimal placeholder shell. The real application UI arrives in later phases. */

import { Workspace } from "./workspace/store.js";

const workspace = Workspace.create({ title: "My Workspace" });
workspace.dispatch("createPage", { type: "document", title: "Untitled" });

const root = document.getElementById("app");
if (!root) throw new Error("missing #app element");
root.textContent = `${workspace.title} — ${workspace.getPages().length} page(s)`;
