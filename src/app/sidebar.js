/**
 * Page sidebar: the workspace hierarchy.
 *
 * Renders the nested page tree, lets the user create/rename/delete pages, and
 * supports drag-and-drop reordering and nesting. All mutations go through the
 * workspace command layer via the `actions` callbacks; the sidebar holds only
 * transient UI state (selection, inline-rename target, drag source).
 *
 * `planDrop` is pure so the drop rules (including cycle prevention) are testable
 * without simulating drag events.
 */

import { h, clear } from "./dom.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/schema.js").PageType} PageType */

const TYPE_GLYPH = { document: "¶", sheet: "▦", presentation: "▭" };
const TYPE_LABEL = { document: "Document", sheet: "Sheet", presentation: "Presentation" };

/**
 * @typedef {object} DropTarget
 * @property {"onto" | "before" | "after" | "root"} type
 * @property {string} [pageId]
 */

/**
 * Whether `ancestorId` is `pageId` itself or one of its ancestors.
 * @param {Workspace} workspace
 * @param {string} ancestorId
 * @param {string} pageId
 * @returns {boolean}
 */
function isSelfOrAncestor(workspace, ancestorId, pageId) {
  let cursor = pageId;
  let guard = 0;
  while (cursor && guard++ <= 1000) {
    if (cursor === ancestorId) return true;
    cursor = workspace.getParent(cursor) ?? "";
  }
  return false;
}

/**
 * Resolve a drop target into a concrete move, applying cycle prevention.
 * @param {Workspace} workspace
 * @param {string} dragId
 * @param {DropTarget} target
 * @returns {{ newParentId: string | null, index: number } | null} null when illegal.
 */
export function planDrop(workspace, dragId, target) {
  if (!workspace.getPage(dragId)) return null;

  if (target.type === "onto") {
    const parentId = target.pageId;
    if (!parentId || !workspace.getPage(parentId)) return null;
    if (isSelfOrAncestor(workspace, dragId, parentId)) return null;
    const list = workspace.getChildren(parentId).filter((id) => id !== dragId);
    return { newParentId: parentId, index: list.length };
  }

  if (target.type === "before" || target.type === "after") {
    const anchorId = target.pageId;
    if (!anchorId || !workspace.getPage(anchorId)) return null;
    const parentId = workspace.getParent(anchorId);
    const list = workspace.getChildren(parentId).filter((id) => id !== dragId);
    let index = list.indexOf(anchorId);
    if (index === -1) return null;
    if (target.type === "after") index += 1;
    return { newParentId: parentId, index };
  }

  if (target.type === "root") {
    const list = workspace.getChildren(null).filter((id) => id !== dragId);
    return { newParentId: null, index: list.length };
  }

  return null;
}

/**
 * @typedef {object} SidebarActions
 * @property {(pageId: string) => void} select
 * @property {(type: PageType) => void} create
 * @property {(pageId: string, title: string) => void} rename
 * @property {(pageId: string) => void} remove
 * @property {(pageId: string, move: { newParentId: string | null, index: number }) => void} move
 * @property {(title: string) => void} renameWorkspace
 */

/**
 * Create the sidebar component.
 * @param {Workspace} workspace
 * @param {SidebarActions} actions
 * @returns {{ element: HTMLElement, refresh: () => void, select: (pageId: string) => void, selection: () => string | null }}
 */
export function createSidebar(workspace, actions) {
  const element = h("aside", { class: "sidebar" });
  /** @type {{ selectedPageId: string | null, editingPageId: string | null, editingTitle: boolean, draggingPageId: string | null }} */
  const state = {
    selectedPageId: null,
    editingPageId: null,
    editingTitle: false,
    draggingPageId: null
  };

  /** @param {string} pageId */
  function select(pageId) {
    state.selectedPageId = pageId;
    actions.select(pageId);
    refresh();
  }

  /** @param {string} pageId */
  function startRename(pageId) {
    state.editingPageId = pageId;
    refresh();
    const input = /** @type {HTMLInputElement | null} */ (
      element.querySelector(`[data-rename-input="${pageId}"]`)
    );
    input?.focus();
    input?.select();
  }

  /** @param {string} pageId @param {string} value */
  function commitRename(pageId, value) {
    state.editingPageId = null;
    const title = value.trim();
    if (title && title !== workspace.getPage(pageId)?.title) actions.rename(pageId, title);
    refresh();
  }

  /**
   * @param {string} pageId
   * @param {number} depth
   * @returns {HTMLElement}
   */
  function renderRow(pageId, depth) {
    const page = workspace.getPage(pageId);
    if (!page) return h("div");

    const row = h("div", {
      class: `page-row${state.selectedPageId === pageId ? " is-selected" : ""}`,
      "data-page-id": pageId,
      draggable: "true",
      style: `--depth:${depth}`
    });

    const glyph = h("span", { class: `type-glyph type-${page.type}`, text: TYPE_GLYPH[page.type] ?? "•" });
    glyph.setAttribute("title", TYPE_LABEL[page.type] ?? page.type);
    row.append(glyph);

    if (state.editingPageId === pageId) {
      const input = h("input", {
        class: "rename-input",
        "data-rename-input": pageId,
        value: page.title,
        "aria-label": "Page title"
      });
      input.addEventListener("keydown", (event) => {
        const key = /** @type {KeyboardEvent} */ (event).key;
        if (key === "Enter") {
          event.preventDefault();
          commitRename(pageId, input.value);
        } else if (key === "Escape") {
          state.editingPageId = null;
          refresh();
        }
      });
      input.addEventListener("blur", () => commitRename(pageId, input.value));
      row.append(input);
    } else {
      const title = h("button", {
        class: "page-title",
        type: "button",
        text: page.title || "Untitled"
      });
      title.addEventListener("click", () => {
        if (state.selectedPageId !== pageId) select(pageId);
      });
      title.addEventListener("dblclick", () => startRename(pageId));
      row.append(title);
    }

    const remove = h("button", {
      class: "page-delete",
      type: "button",
      text: "×",
      "aria-label": `Delete ${page.title || "page"}`
    });
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      actions.remove(pageId);
    });
    row.append(remove);

    // Drag and drop wiring.
    row.addEventListener("dragstart", (event) => {
      state.draggingPageId = pageId;
      row.classList.add("is-dragging");
      /** @type {DragEvent} */ (event).dataTransfer?.setData("text/plain", pageId);
    });
    row.addEventListener("dragend", () => {
      state.draggingPageId = null;
      row.classList.remove("is-dragging");
      for (const el of element.querySelectorAll(".drop-onto, .drop-before, .drop-after")) {
        el.classList.remove("drop-onto", "drop-before", "drop-after");
      }
    });
    row.addEventListener("dragover", (event) => {
      if (!state.draggingPageId) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const offset = /** @type {DragEvent} */ (event).clientY - rect.top;
      for (const el of element.querySelectorAll(".drop-onto, .drop-before, .drop-after")) {
        el.classList.remove("drop-onto", "drop-before", "drop-after");
      }
      if (offset < rect.height * 0.3) row.classList.add("drop-before");
      else row.classList.add("drop-onto");
    });
    row.addEventListener("drop", (event) => {
      if (!state.draggingPageId) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = row.getBoundingClientRect();
      const offset = /** @type {DragEvent} */ (event).clientY - rect.top;
      const target = offset < rect.height * 0.3
        ? { type: "before", pageId }
        : { type: "onto", pageId };
      applyDrop(state.draggingPageId, /** @type {DropTarget} */ (target));
    });

    /** @type {HTMLElement[]} */
    const children = [];
    for (const childId of workspace.getChildren(pageId)) {
      children.push(renderRow(childId, depth + 1));
    }

    return h("div", { class: "page-node" }, [row, ...children]);
  }

  /**
   * @param {string} dragId
   * @param {DropTarget} target
   */
  function applyDrop(dragId, target) {
    const plan = planDrop(workspace, dragId, target);
    state.draggingPageId = null;
    if (plan) actions.move(dragId, plan);
  }

  function render() {
    clear(element);

    const titleText = h("span", { class: "workspace-title-text", text: workspace.title || "Untitled workspace" });
    const titleRow = h("div", { class: "workspace-title" }, [titleText]);
    titleText.addEventListener("dblclick", () => {
      state.editingTitle = true;
      render();
      const input = /** @type {HTMLInputElement | null} */ (element.querySelector(".workspace-title-input"));
      input?.focus();
      input?.select();
    });
    if (state.editingTitle) {
      clear(titleRow);
      const input = h("input", {
        class: "workspace-title-input",
        value: workspace.title,
        "aria-label": "Workspace title"
      });
      const commit = () => {
        state.editingTitle = false;
        const value = input.value.trim();
        if (value !== workspace.title) actions.renameWorkspace(value);
        render();
      };
      input.addEventListener("keydown", (event) => {
        const key = /** @type {KeyboardEvent} */ (event).key;
        if (key === "Enter") {
          event.preventDefault();
          commit();
        } else if (key === "Escape") {
          state.editingTitle = false;
          render();
        }
      });
      input.addEventListener("blur", commit);
      titleRow.append(input);
    }
    element.append(titleRow);

    const newButtons = h("div", { class: "new-page-buttons" });
    for (const type of /** @type {PageType[]} */ (["document", "sheet", "presentation"])) {
      const button = h("button", {
        class: "new-page",
        type: "button",
        title: `New ${TYPE_LABEL[type]}`,
        text: `${TYPE_GLYPH[type]}`
      });
      button.append(h("span", { class: "new-page-label", text: TYPE_LABEL[type] }));
      button.addEventListener("click", () => actions.create(type));
      newButtons.append(button);
    }
    element.append(newButtons);

    const tree = h("div", { class: "page-tree" });
    const rootChildren = workspace.getChildren(null);
    for (const pageId of rootChildren) {
      tree.append(renderRow(pageId, 0));
    }
    if (rootChildren.length === 0) {
      tree.append(h("p", { class: "empty-hint", text: "No pages yet — create one above." }));
    }
    element.append(tree);

    // Root drop zone: dropping here moves a page to the top level.
    const rootZone = h("div", { class: "root-drop-zone", text: "Drop here to place at top level" });
    rootZone.addEventListener("dragover", (event) => {
      if (!state.draggingPageId) return;
      event.preventDefault();
      rootZone.classList.add("is-active");
    });
    rootZone.addEventListener("dragleave", () => rootZone.classList.remove("is-active"));
    rootZone.addEventListener("drop", (event) => {
      if (!state.draggingPageId) return;
      event.preventDefault();
      rootZone.classList.remove("is-active");
      applyDrop(state.draggingPageId, { type: "root" });
    });
    element.append(rootZone);
  }

  function refresh() {
    render();
  }

  refresh();

  return {
    element,
    refresh,
    select,
    selection: () => state.selectedPageId
  };
}
