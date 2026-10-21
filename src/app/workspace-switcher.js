/**
 * The body of the File > Workspaces popover: the stored workspaces (open one, delete one) and a
 * field to start a new one. It only reads and calls the shell's workspace methods.
 */

import { h } from "./dom.js";
import { icon } from "./icons.js";

/** @typedef {import("./ribbon-shared.js").ShellApi} ShellApi */
/** @typedef {import("./ribbon-shared.js").WorkspaceEntry} WorkspaceEntry */

/**
 * @param {number} savedAt
 * @returns {string}
 */
function savedLabel(savedAt) {
  return savedAt ? new Date(savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

/**
 * @param {ShellApi} shell
 * @param {() => void} close
 * @returns {HTMLElement}
 */
export function workspaceSwitcher(shell, close) {
  const list = h("div", { class: "workspace-list", role: "list" });
  const input = h("input", {
    class: "popover-input",
    type: "text",
    placeholder: "New workspace name",
    "aria-label": "New workspace name",
    "data-role": "new-workspace-name"
  });
  const create = h("button", { class: "popover-apply", type: "button", "data-action": "create-workspace", text: "Create" });
  create.addEventListener("click", () => {
    close();
    shell.createWorkspace(input.value.trim());
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      create.click();
    } else if (event.key === "Escape") {
      close();
    }
  });

  /** @param {WorkspaceEntry} entry */
  function row(entry) {
    const open = h(
      "button",
      {
        class: "workspace-open",
        type: "button",
        "data-action": "open-workspace",
        "data-workspace-id": entry.id,
        disabled: entry.active || entry.recovery
      },
      [
        h("span", { class: "workspace-name", text: entry.recovery ? `${entry.title} (recovery copy)` : entry.title }),
        h("span", { class: "workspace-meta", text: entry.active ? "Open now" : savedLabel(entry.savedAt) })
      ]
    );
    open.addEventListener("click", () => {
      close();
      shell.openWorkspace(entry.id);
    });
    const remove = h(
      "button",
      {
        class: "workspace-delete",
        type: "button",
        "data-action": "delete-workspace",
        title: `Delete ${entry.title}`,
        "aria-label": `Delete ${entry.title}`,
        disabled: entry.active
      },
      [icon("trash", { size: 14 })]
    );
    remove.addEventListener("click", () => {
      void shell.deleteWorkspace(entry).then((deleted) => {
        if (deleted) rowElement.remove();
      });
    });
    const rowElement = h("div", { class: "workspace-row", role: "listitem" }, [open, remove]);
    return rowElement;
  }

  void shell.listWorkspaces().then(
    (entries) => {
      list.replaceChildren(...entries.map(row));
    },
    () => list.replaceChildren(h("div", { class: "workspace-meta", text: "Stored workspaces could not be read." }))
  );

  return h("div", { class: "popover-body workspace-switcher" }, [
    list,
    h("div", { class: "popover-row" }, [input, create])
  ]);
}
