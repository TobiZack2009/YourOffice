/**
 * Page sidebar: the workspace hierarchy.
 *
 * Renders the nested page tree, lets the user create/rename/delete/favorite pages,
 * and supports drag-and-drop reordering and nesting. All mutations go through the
 * workspace command layer via the `actions` callbacks; the sidebar holds only
 * transient UI state (selection, inline-rename target, drag source, which parents
 * are collapsed).
 *
 * `planDrop` is pure so the drop rules (including cycle prevention) are testable
 * without simulating drag events.
 */

import { reconcileChildren } from "../core/reconcile.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { buildMenu, createPopoverHost } from "./popover.js";
import { pageExists, pageInfo, pageTitle } from "../workspace/selectors.js";
import { createSession } from "./session.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/schema.js").PageType} PageType */

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
  if (!pageExists(workspace, dragId)) return null;

  if (target.type === "onto") {
    const parentId = target.pageId;
    if (!parentId || !pageExists(workspace, parentId)) return null;
    if (isSelfOrAncestor(workspace, dragId, parentId)) return null;
    const list = workspace.getChildren(parentId).filter((id) => id !== dragId);
    return { newParentId: parentId, index: list.length };
  }

  if (target.type === "before" || target.type === "after") {
    const anchorId = target.pageId;
    if (!anchorId || !pageExists(workspace, anchorId)) return null;
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
 * @property {(type: PageType, parentId?: string) => void} create Creates a top-level page, or a child of `parentId`.
 * @property {(pageId: string, title: string) => void} rename
 * @property {(pageId: string) => void} remove
 * @property {(pageId: string, move: { newParentId: string | null, index: number }) => void} move
 * @property {(title: string) => void} renameWorkspace
 * @property {(pageId: string, favorite: boolean) => void} [favorite]
 * @property {() => void} [openQuickFind]
 */

const PAGE_TYPES = /** @type {PageType[]} */ (["document", "sheet", "presentation"]);

/**
 * Create the sidebar component.
 * @param {Workspace} workspace
 * @param {SidebarActions} actions
 * @param {{ session?: import("./session.js").Session }} [options] The open page and the folded
 *   branches live in the session (a private one when none is given).
 * @returns {{ element: HTMLElement, refresh: () => void, select: (pageId: string) => void, selection: () => string | null }}
 */
export function createSidebar(workspace, actions, options = {}) {
  const session = options.session ?? createSession();
  const element = h("aside", { class: "sidebar" });
  // Re-rendered on every refresh; popovers live beside it so a refresh never orphans one.
  const content = h("div", { class: "sidebar-content" });
  element.append(content);
  const popovers = createPopoverHost(element);
  /** @type {Map<string, { signature: string, node: HTMLElement, row: HTMLElement | null }>} Page nodes by page id. */
  const rowNodes = new Map();
  /** @type {Map<string, { signature: string, row: HTMLElement }>} Favorite rows by page id. */
  const favoriteRows = new Map();
  /** @type {Set<string>} Page ids drawn by the current pass. */
  let seenRows = new Set();
  /** @type {Set<string>} */
  let seenFavorites = new Set();

  /** @type {{ editingPageId: string | null, editingTitle: boolean, draggingPageId: string | null }} */
  const state = {
    editingPageId: null,
    editingTitle: false,
    draggingPageId: null
  };
  const selectedPageId = () => session.get().selectedPageId;
  const isCollapsed = (/** @type {string} */ pageId) => session.get().sidebarCollapsed.includes(pageId);
  /** @param {string} pageId @param {boolean} collapsed */
  function setCollapsed(pageId, collapsed) {
    if (isCollapsed(pageId) === collapsed) return;
    const rest = session.get().sidebarCollapsed.filter((id) => id !== pageId);
    session.set({ sidebarCollapsed: collapsed ? [...rest, pageId] : rest });
  }

  /** Expand every ancestor of a page so its row is visible. */
  function reveal(pageId) {
    let parent = workspace.getParent(pageId);
    while (parent) {
      setCollapsed(parent, false);
      parent = workspace.getParent(parent);
    }
  }

  /** @param {string} pageId */
  function select(pageId) {
    session.set({ selectedPageId: pageId });
    reveal(pageId);
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
    if (title && title !== pageTitle(workspace, pageId)) actions.rename(pageId, title);
    refresh();
  }

  /**
   * The "New page" type picker: header "+" (top level) and row "+" (child page).
   * @param {HTMLElement} anchor
   * @param {string} [parentId]
   */
  function openTypePicker(anchor, parentId) {
    const close = () => popovers.close();
    const body = buildMenu(
      [
        { heading: parentId ? "New subpage" : "New page" },
        ...PAGE_TYPES.map((type) => ({
          label: TYPE_LABEL[type],
          icon: `page-${type}`,
          className: "new-page",
          attrs: { "data-type": type },
          action: () => (parentId ? actions.create(type, parentId) : actions.create(type))
        }))
      ],
      close,
      (name) => icon(name, { size: 16 })
    );
    popovers.show(anchor, body);
  }

  /**
   * The row "..." menu.
   * @param {HTMLElement} anchor
   * @param {string} pageId
   */
  function openPageMenu(anchor, pageId) {
    const favorite = workspace.getFavorites().includes(pageId);
    const body = buildMenu(
      [
        { label: "Rename", icon: "rename", attrs: { "data-action": "rename" }, action: () => startRename(pageId) },
        {
          label: favorite ? "Remove from favorites" : "Add to favorites",
          icon: "star",
          attrs: { "data-action": "favorite" },
          action: () => actions.favorite?.(pageId, !favorite)
        },
        { separator: true },
        {
          label: "Delete",
          icon: "trash",
          danger: true,
          attrs: { "data-action": "delete" },
          action: () => actions.remove(pageId)
        }
      ],
      () => popovers.close(),
      (name) => icon(name, { size: 16 })
    );
    popovers.show(anchor, body);
  }

  /**
   * @param {string} label
   * @param {string} iconName
   * @param {string} action
   * @param {(button: HTMLElement) => void} handler
   */
  function rowButton(label, iconName, action, handler) {
    const button = h("button", {
      class: `row-button row-${action}`,
      type: "button",
      title: label,
      "aria-label": label,
      "data-action": action
    });
    button.append(icon(iconName, { size: 15 }));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handler(button);
    });
    return button;
  }

  /**
   * @param {string} type
   * @returns {HTMLElement}
   */
  function typeGlyph(type) {
    const glyph = h("span", { class: `type-glyph type-${type}`, title: TYPE_LABEL[type] ?? type }, [
      icon(`page-${type}`, { size: 16 })
    ]);
    return glyph;
  }

  /**
   * One page and its visible subtree. Nodes are kept per page id: a page whose own look is
   * unchanged keeps its row element across refreshes (selection and depth are patched in
   * place), so adding, renaming or moving one page touches only the rows that differ.
   * @param {string} pageId
   * @param {number} depth
   * @returns {HTMLElement}
   */
  function renderRow(pageId, depth) {
    const page = pageInfo(workspace, pageId);
    if (!page) return h("div");
    seenRows.add(pageId);

    const childIds = workspace.getChildren(pageId);
    const collapsed = isCollapsed(pageId);
    const editing = state.editingPageId === pageId;
    const signature = JSON.stringify([page.type, page.title, childIds.length > 0, collapsed, editing]);
    let entry = rowNodes.get(pageId);
    if (!entry) {
      entry = { signature: "", node: h("div", { class: "page-node", "data-node-id": pageId }), row: null };
      rowNodes.set(pageId, entry);
    }
    if (!entry.row || entry.signature !== signature) {
      entry.row = buildRow(pageId, page, childIds, collapsed);
      entry.signature = signature;
    }
    const row = entry.row;
    row.classList.toggle("is-selected", selectedPageId() === pageId);
    row.style.setProperty("--depth", String(depth));
    const children = collapsed ? [] : childIds.map((childId) => renderRow(childId, depth + 1));
    reconcileChildren(entry.node, [row, ...children]);
    return entry.node;
  }

  /**
   * @param {string} pageId
   * @param {{ type: string, title: string }} page
   * @param {string[]} childIds
   * @param {boolean} collapsed
   * @returns {HTMLElement}
   */
  function buildRow(pageId, page, childIds, collapsed) {
    const row = h("div", {
      class: "page-row",
      "data-page-id": pageId,
      draggable: "true"
    });

    if (childIds.length > 0) {
      const caret = h("button", {
        class: `page-caret${collapsed ? "" : " is-open"}`,
        type: "button",
        "aria-label": collapsed ? "Expand" : "Collapse",
        "aria-expanded": collapsed ? "false" : "true",
        "data-action": "toggle-children"
      });
      caret.append(icon("chevron", { size: 13 }));
      caret.addEventListener("click", (event) => {
        event.stopPropagation();
        setCollapsed(pageId, !isCollapsed(pageId));
        refresh();
      });
      row.append(caret);
    } else {
      row.append(h("span", { class: "page-caret-spacer", "aria-hidden": "true" }));
    }

    row.append(typeGlyph(page.type));

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
      title.addEventListener("dblclick", () => startRename(pageId));
      row.append(title);
    }

    row.append(
      h("span", { class: "page-actions" }, [
        rowButton(`Add a page inside ${page.title || "this page"}`, "plus", "add-child", (button) =>
          openTypePicker(button, pageId)
        ),
        rowButton(`Actions for ${page.title || "this page"}`, "more", "page-menu", (button) =>
          openPageMenu(button, pageId)
        )
      ])
    );

    // The whole row is the click target, not just the title text.
    row.addEventListener("click", (event) => selectFromRow(event, pageId));

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

    return row;
  }

  /**
   * Row-level click: selects the page unless the click landed on an interactive
   * child (caret, row actions, rename input) that handles itself.
   * @param {Event} event
   * @param {string} pageId
   */
  function selectFromRow(event, pageId) {
    const target = /** @type {Element} */ (event.target);
    if (target.closest(".page-caret, .page-actions, .rename-input")) return;
    if (selectedPageId() !== pageId) select(pageId);
  }

  /** @param {string} pageId */
  function renderFavorite(pageId) {
    const page = pageInfo(workspace, pageId);
    if (!page) return null;
    seenFavorites.add(pageId);
    const signature = JSON.stringify([page.type, page.title]);
    let entry = favoriteRows.get(pageId);
    if (!entry || entry.signature !== signature) {
      const row = h("div", { class: "favorite-row", "data-favorite-id": pageId });
      row.append(typeGlyph(page.type));
      row.append(h("button", { class: "favorite-title", type: "button", text: page.title || "Untitled" }));
      row.addEventListener("click", (event) => selectFromRow(event, pageId));
      row.append(
        h("span", { class: "page-actions" }, [
          rowButton(`Remove ${page.title || "page"} from favorites`, "star", "unfavorite", () =>
            actions.favorite?.(pageId, false)
          )
        ])
      );
      entry = { signature, row };
      favoriteRows.set(pageId, entry);
    }
    entry.row.classList.toggle("is-selected", selectedPageId() === pageId);
    return entry.row;
  }

  /**
   * @param {string} dragId
   * @param {DropTarget} target
   */
  function applyDrop(dragId, target) {
    const plan = planDrop(workspace, dragId, target);
    state.draggingPageId = null;
    if (plan) {
      if (plan.newParentId) setCollapsed(plan.newParentId, false);
      actions.move(dragId, plan);
    }
  }

  // The skeleton is built once; render() patches it.
  const titleText = h("span", { class: "workspace-title-text" });
  const titleRow = h("div", { class: "workspace-title" }, [titleText]);
  titleText.addEventListener("dblclick", () => {
    state.editingTitle = true;
    render();
    const input = /** @type {HTMLInputElement | null} */ (element.querySelector(".workspace-title-input"));
    input?.focus();
    input?.select();
  });
  /** @type {HTMLInputElement | null} */
  let titleInput = null;

  const newPage = h("button", {
    class: "new-page-trigger",
    type: "button",
    title: "New page",
    "aria-label": "New page",
    "data-action": "new-page"
  });
  newPage.append(icon("plus", { size: 16 }));
  newPage.addEventListener("click", () => openTypePicker(newPage));
  const header = h("div", { class: "sidebar-header" }, [titleRow, newPage]);

  const search = h("button", {
    class: "sidebar-search",
    type: "button",
    "aria-label": "Search pages",
    "data-action": "quick-find"
  });
  search.append(
    icon("search", { size: 15 }),
    h("span", { class: "sidebar-search-text", text: "Search" }),
    h("kbd", { text: "⌘K" })
  );
  search.addEventListener("click", () => actions.openQuickFind?.());

  const favoritesLabel = h("div", { class: "sidebar-section-label", text: "Favorites" });
  const favoritesSection = h("div", { class: "sidebar-section sidebar-favorites" }, [favoritesLabel]);
  const pagesLabel = h("div", { class: "sidebar-section-label", text: "Pages" });
  const tree = h("div", { class: "page-tree" });
  const emptyHint = h("p", { class: "empty-hint", text: "No pages yet — use + to create one." });

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

  function renderTitle() {
    titleText.textContent = workspace.title || "Untitled workspace";
    if (state.editingTitle && !titleInput) {
      const input = /** @type {HTMLInputElement} */ (
        h("input", { class: "workspace-title-input", value: workspace.title, "aria-label": "Workspace title" })
      );
      const commit = () => {
        if (!state.editingTitle) return;
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
      titleInput = input;
      titleRow.replaceChildren(input);
    } else if (!state.editingTitle && titleInput) {
      titleInput = null;
      titleRow.replaceChildren(titleText);
    }
  }

  function render() {
    renderTitle();

    seenRows = new Set();
    seenFavorites = new Set();

    const favorites = workspace.getFavorites();
    const favoriteNodes = favorites.map(renderFavorite).filter((row) => row !== null);
    for (const [id] of favoriteRows) if (!seenFavorites.has(id)) favoriteRows.delete(id);
    reconcileChildren(favoritesSection, [favoritesLabel, ...favoriteNodes]);

    const rootChildren = workspace.getChildren(null);
    const nodes = rootChildren.map((pageId) => renderRow(pageId, 0));
    for (const [id] of rowNodes) if (!seenRows.has(id)) rowNodes.delete(id);
    reconcileChildren(tree, nodes.length > 0 ? nodes : [emptyHint]);

    reconcileChildren(content, [
      header,
      search,
      ...(favoriteNodes.length > 0 ? [favoritesSection] : []),
      pagesLabel,
      tree,
      rootZone
    ]);
  }

  function refresh() {
    popovers.close();
    render();
  }

  refresh();

  return {
    element,
    refresh,
    select,
    selection: () => selectedPageId()
  };
}
