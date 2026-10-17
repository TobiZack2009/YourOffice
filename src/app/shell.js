/**
 * Application shell: sidebar + toolbar + canvas, wired to a workspace.
 *
 * The shell owns page selection and the active editor instance; every mutation
 * flows through workspace commands. Sheet and presentation pages render a
 * placeholder until their phases land (Phase 4 / Phase 5).
 */

import { registerDocumentCommands } from "../document/commands.js";
import { createSidebar } from "./sidebar.js";
import { createDocumentEditor } from "./block-editor.js";
import { clear, h } from "./dom.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/schema.js").PageType} PageType */

const REGISTRY_COMMANDS = new Set([
  "createPage",
  "renamePage",
  "deletePage",
  "movePage",
  "renameWorkspace"
]);

const BLOCK_BUTTONS = [
  { type: "paragraph", label: "Paragraph", glyph: "¶" },
  { type: "heading", level: 1, label: "Heading 1", glyph: "H1" },
  { type: "heading", level: 2, label: "Heading 2", glyph: "H2" },
  { type: "heading", level: 3, label: "Heading 3", glyph: "H3" },
  { type: "list", label: "List", glyph: "•" },
  { type: "quote", label: "Quote", glyph: "❝" },
  { type: "code", label: "Code block", glyph: "</>" },
  { type: "divider", label: "Divider", glyph: "—" }
];

const MARK_BUTTONS = [
  { mark: "bold", label: "Bold", glyph: "B", style: "font-weight:700" },
  { mark: "italic", label: "Italic", glyph: "I", style: "font-style:italic" },
  { mark: "underline", label: "Underline", glyph: "U", style: "text-decoration:underline" },
  { mark: "strike", label: "Strikethrough", glyph: "S", style: "text-decoration:line-through" },
  { mark: "code", label: "Inline code", glyph: "‹›", style: "font-family:ui-monospace,monospace" }
];

const INSERT_ITEMS = [
  { key: "paragraph", label: "Paragraph", block: { type: "paragraph" } },
  { key: "heading", label: "Heading 1", block: { type: "heading", level: 1 } },
  { key: "list", label: "List", block: { type: "list" } },
  { key: "quote", label: "Quote", block: { type: "quote" } },
  { key: "code", label: "Code block", block: { type: "code" } },
  { key: "divider", label: "Divider", block: { type: "divider" } }
];

/**
 * Mount the full application UI.
 * @param {HTMLElement} root
 * @param {Workspace} workspace
 * @param {{ confirm?: (message: string) => boolean }} [options]
 * @returns {{ destroy: () => void, select: (pageId: string) => void }}
 */
export function mountApp(root, workspace, options = {}) {
  if (!workspace.hasCommand("insertBlock")) registerDocumentCommands(workspace);

  /** @type {{ selectedPageId: string | null, editor: import("./block-editor.js").EditorHandle | null }} */
  const state = { selectedPageId: null, editor: null };

  clear(root);
  const shell = h("div", { class: "app" });
  const main = h("main", { class: "main" });
  const toolbar = h("header", { class: "toolbar" });
  const canvas = h("div", { class: "canvas" });
  const { element: sidebarElement, refresh: refreshSidebar, select: selectSidebar, selection } =
    createSidebar(workspace, sidebarActions());
  main.append(toolbar, canvas);
  shell.append(sidebarElement, main);
  root.append(shell);

  // -- toolbar -----------------------------------------------------------------

  const blockButtons = new Map();
  const typeGroup = h("div", { class: "toolbar-group" });
  for (const spec of BLOCK_BUTTONS) {
    const button = h("button", {
      class: "toolbar-button block-button",
      type: "button",
      title: spec.label,
      "aria-label": spec.label,
      "data-action": "block-type",
      "data-type": spec.type,
      "data-level": spec.level ?? ""
    });
    button.append(h("span", { class: "glyph", text: spec.glyph }));
    button.addEventListener("click", () => {
      state.editor?.setActiveType({ type: spec.type, level: spec.level });
      updateToolbar();
    });
    blockButtons.set(spec.level ? `${spec.type}:${spec.level}` : spec.type, button);
    typeGroup.append(button);
  }

  const markGroup = h("div", { class: "toolbar-group" });
  for (const spec of MARK_BUTTONS) {
    const button = h("button", {
      class: "toolbar-button mark-button",
      type: "button",
      title: spec.label,
      "aria-label": spec.label,
      "data-action": "mark",
      "data-mark": spec.mark,
      style: spec.style
    });
    button.append(h("span", { class: "glyph", text: spec.glyph }));
    button.addEventListener("click", () => state.editor?.toggleMark(/** @type {any} */ (spec.mark)));
    markGroup.append(button);
  }

  const linkButton = h("button", {
    class: "toolbar-button link-button",
    type: "button",
    title: "Link",
    "aria-label": "Link",
    "data-action": "link"
  });
  linkButton.append(h("span", { class: "glyph", text: "↗" }));
  markGroup.append(linkButton);

  const insertGroup = h("div", { class: "toolbar-group" });
  const insertButton = h("button", {
    class: "toolbar-button insert-button",
    type: "button",
    "data-action": "insert",
    title: "Insert a block",
    "aria-label": "Insert a block"
  });
  insertButton.append(h("span", { class: "glyph", text: "+" }), h("span", { text: "Insert" }));
  insertGroup.append(insertButton);

  const historyGroup = h("div", { class: "toolbar-group toolbar-group-end" });
  const undoButton = h("button", {
    class: "toolbar-button",
    type: "button",
    "data-action": "undo",
    title: "Undo",
    "aria-label": "Undo"
  });
  undoButton.append(h("span", { class: "glyph", text: "↶" }));
  const redoButton = h("button", {
    class: "toolbar-button",
    type: "button",
    "data-action": "redo",
    title: "Redo",
    "aria-label": "Redo"
  });
  redoButton.append(h("span", { class: "glyph", text: "↷" }));
  const dirtyDot = h("span", { class: "dirty-dot", title: "Unsaved changes", "aria-hidden": "true" });
  historyGroup.append(undoButton, redoButton, dirtyDot);

  toolbar.append(typeGroup, h("div", { class: "toolbar-sep" }), markGroup, h("div", { class: "toolbar-sep" }), insertGroup, historyGroup);

  // Keep the editor selection when a toolbar button is pressed.
  toolbar.addEventListener("mousedown", (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.closest("button")) event.preventDefault();
  });

  undoButton.addEventListener("click", () => {
    workspace.undo();
    renderMain();
  });
  redoButton.addEventListener("click", () => {
    workspace.redo();
    renderMain();
  });
  linkButton.addEventListener("click", openLinkPopover);
  insertButton.addEventListener("click", openInsertMenu);

  let openPopover = null;

  /** @returns {Range | null} */
  function currentRange() {
    const selection = document.getSelection();
    return selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  }

  /** @param {Range | null} range */
  function restoreRange(range) {
    if (!range) return;
    const selection = document.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function closePopover() {
    if (openPopover) {
      openPopover.remove();
      openPopover = null;
    }
  }

  /**
   * @param {HTMLElement} anchor
   * @param {HTMLElement} content
   * @param {boolean} [keepFocus]
   */
  function showPopover(anchor, content, keepFocus = false) {
    closePopover();
    const popover = h("div", { class: "popover" }, [content]);
    toolbar.append(popover);
    const anchorRect = anchor.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    popover.style.left = `${Math.max(0, anchorRect.left - toolbarRect.left)}px`;
    popover.style.top = `${anchorRect.bottom - toolbarRect.top + 6}px`;
    openPopover = popover;
    if (keepFocus) {
      const field = /** @type {HTMLInputElement | null} */ (popover.querySelector("input"));
      field?.focus();
    }
    return popover;
  }

  function openLinkPopover() {
    const savedRange = currentRange();
    const input = h("input", {
      class: "popover-input",
      type: "url",
      placeholder: "https://…",
      "aria-label": "Link URL",
      "data-role": "link-input"
    });
    const apply = h("button", { class: "popover-apply", type: "button", text: "Apply" });
    const remove = h("button", { class: "popover-remove", type: "button", text: "Remove" });
    const footer = h("div", { class: "popover-row" }, [apply, remove]);
    const content = h("div", { class: "popover-body" }, [input, footer]);

    apply.addEventListener("click", () => {
      const value = input.value.trim();
      if (value) {
        restoreRange(savedRange);
        state.editor?.setLink(value);
      }
      closePopover();
    });
    remove.addEventListener("click", () => {
      restoreRange(savedRange);
      state.editor?.setLink("");
      closePopover();
    });
    input.addEventListener("keydown", (event) => {
      const keyboard = /** @type {KeyboardEvent} */ (event);
      if (keyboard.key === "Enter") {
        keyboard.preventDefault();
        apply.click();
      } else if (keyboard.key === "Escape") {
        closePopover();
      }
    });

    showPopover(linkButton, content, true);
  }

  function openInsertMenu() {
    const list = h("div", { class: "menu" });
    for (const item of INSERT_ITEMS) {
      const button = h("button", {
        class: "menu-item",
        type: "button",
        text: item.label,
        "data-action": "insert-item",
        "data-insert": item.key
      });
      button.addEventListener("click", () => {
        state.editor?.insertAfterActive(item.block);
        closePopover();
        updateToolbar();
      });
      list.append(button);
    }

    const pageIds = workspace.getPages().map((page) => page.id).filter((id) => id !== state.selectedPageId);
    const linkList = h("div", { class: "menu-section" }, [
      h("div", { class: "menu-label", text: pageIds.length ? "Page link" : "No other pages" })
    ]);
    for (const pageId of pageIds) {
      const page = workspace.getPage(pageId);
      const button = h("button", {
        class: "menu-item",
        type: "button",
        text: page?.title || "Untitled",
        "data-action": "insert-page-link",
        "data-page-id": pageId
      });
      button.addEventListener("click", () => {
        state.editor?.insertAfterActive({ type: "pageLink", pageId });
        closePopover();
      });
      linkList.append(button);
    }

    showPopover(insertButton, h("div", { class: "menu-body" }, [list, linkList]));
  }

  // -- main canvas --------------------------------------------------------------

  function documentFirstBlockId() {
    if (!state.selectedPageId) return null;
    const page = workspace.getPage(state.selectedPageId);
    const content = /** @type {import("../document/model.js").DocumentContent | undefined} */ (
      page?.content
    );
    return content?.blockOrder?.[0] ?? null;
  }

  function renderMain() {
    state.editor?.destroy();
    state.editor = null;
    closePopover();
    clear(canvas);

    const pageId = state.selectedPageId;
    const page = pageId ? workspace.getPage(pageId) : undefined;

    if (!page) {
      canvas.append(
        h("div", { class: "canvas-empty" }, [
          h("h2", { text: "No page selected" }),
          h("p", { text: "Create a page from the sidebar to get started." })
        ])
      );
      updateToolbar();
      return;
    }

    const pageHeader = h("div", { class: "page-header" });
    const titleInput = h("input", {
      class: "page-title-input",
      value: page.title,
      "aria-label": "Page title",
      "data-role": "page-title"
    });
    const commitTitle = () => {
      const value = titleInput.value.trim();
      if (value !== page.title) workspace.dispatch("renamePage", { pageId, title: value });
    };
    titleInput.addEventListener("keydown", (event) => {
      const keyboard = /** @type {KeyboardEvent} */ (event);
      if (keyboard.key === "Enter") {
        event.preventDefault();
        titleInput.blur();
      }
    });
    titleInput.addEventListener("blur", commitTitle);
    const kind = h("span", { class: `page-kind kind-${page.type}`, text: page.type });
    pageHeader.append(titleInput, kind);

    if (page.type === "document") {
      const editor = createDocumentEditor(workspace, page.id, {
        resolvePageTitle: (id) => workspace.getPage(id)?.title,
        onActiveChange: () => updateToolbar()
      });
      state.editor = editor;
      canvas.append(pageHeader, h("div", { class: "page-body" }, [editor.element]));
    } else {
      canvas.append(pageHeader, renderStub(page.type));
    }

    updateToolbar();
  }

  /**
   * @param {PageType} type
   * @returns {HTMLElement}
   */
  function renderStub(type) {
    const messages = {
      sheet: ["Spreadsheet", "The Numbers-style canvas arrives in Phase 4."],
      presentation: ["Presentation", "1280×720 slides arrive in Phase 5."]
    };
    const [title, detail] = messages[type] ?? ["Coming soon", "This page type is not editable yet."];
    return h("div", { class: "stub" }, [
      h("h2", { text: title }),
      h("p", { text: detail })
    ]);
  }

  function updateToolbar() {
    const info = state.editor?.activeInfo?.() ?? null;
    const disabled = !state.editor;
    for (const [key, button] of blockButtons) {
      const active =
        info &&
        ((key === info.type && !key.includes(":")) ||
          (key === `${info.type}:${info.level}` && info.type === "heading"));
      button.classList.toggle("is-active", Boolean(active));
      button.disabled = disabled;
    }
    for (const button of markGroup.querySelectorAll("button")) {
      button.disabled = disabled;
    }
    insertButton.disabled = disabled;
    undoButton.disabled = !workspace.canUndo;
    redoButton.disabled = !workspace.canRedo;
    dirtyDot.classList.toggle("is-dirty", workspace.dirty);
  }

  // -- sidebar actions ----------------------------------------------------------

  function sidebarActions() {
    return {
      /** @param {string} pageId */
      select(pageId) {
        state.selectedPageId = pageId;
        renderMain();
      },
      /** @param {PageType} type */
      create(type) {
        workspace.transact(`create ${type}`, () => {
          workspace.dispatch("createPage", { type, title: defaultTitle(type) });
          const created = workspace.getChildren(null).slice(-1)[0];
          if (type === "document" && created) {
            workspace.dispatch("insertBlock", {
              pageId: created,
              block: { type: "paragraph", runs: [] }
            });
          }
        });
        const created = workspace.getChildren(null).slice(-1)[0];
        if (created) {
          state.selectedPageId = created;
          refreshSidebar();
          renderMain();
          selectSidebar(created);
          const first = documentFirstBlockId();
          if (first) state.editor?.focusBlock(first, "start");
        }
      },
      /** @param {string} pageId @param {string} title */
      rename(pageId, title) {
        workspace.dispatch("renamePage", { pageId, title });
        updateToolbar();
      },
      /** @param {string} pageId */
      remove(pageId) {
        const children = workspace.getChildren(pageId);
        const page = workspace.getPage(pageId);
        const ask = options.confirm ?? ((message) => (typeof window !== "undefined" && window.confirm ? window.confirm(message) : true));
        const message =
          children.length > 0
            ? `Delete “${page?.title ?? "page"}” and its ${children.length} child page(s)?`
            : `Delete “${page?.title ?? "page"}”?`;
        if (!ask(message)) return;
        workspace.dispatch("deletePage", { pageId, cascade: children.length > 0 });
        if (!workspace.getPage(state.selectedPageId ?? "")) {
          state.selectedPageId = workspace.getChildren(null)[0] ?? null;
        }
        refreshSidebar();
        if (state.selectedPageId) selectSidebar(state.selectedPageId ?? "");
        renderMain();
      },
      /**
       * @param {string} pageId
       * @param {{ newParentId: string | null, index: number }} move
       */
      move(pageId, move) {
        workspace.dispatch("movePage", { pageId, newParentId: move.newParentId, index: move.index });
        refreshSidebar();
      },
      /** @param {string} title */
      renameWorkspace(title) {
        workspace.dispatch("renameWorkspace", { title });
        updateToolbar();
      }
    };
  }

  /**
   * @param {PageType} type
   * @returns {string}
   */
  function defaultTitle(type) {
    return type === "document" ? "Untitled Document" : type === "sheet" ? "Untitled Sheet" : "Untitled Presentation";
  }

  // -- store + global wiring ----------------------------------------------------

  const unsubscribeChange = workspace.events.on("change", (event) => {
    const payload = /** @type {{ kind?: string, commands?: string[], pages?: string[] }} */ (event ?? {});
    if (payload.kind && payload.kind !== "commit") {
      renderMain();
      refreshSidebar();
      return;
    }
    const commands = payload.commands ?? [];
    if (
      commands.includes("renamePage") &&
      state.selectedPageId &&
      (payload.pages ?? []).includes(state.selectedPageId)
    ) {
      renderMain();
      refreshSidebar();
      return;
    }
    if (commands.some((c) => REGISTRY_COMMANDS.has(c))) {
      refreshSidebar();
    }
    updateToolbar();
  });

  /** @param {KeyboardEvent} event */
  function onGlobalKeydown(event) {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      workspace.undo();
      renderMain();
    } else if ((key === "z" && event.shiftKey) || key === "y") {
      event.preventDefault();
      workspace.redo();
      renderMain();
    } else if (key === "s") {
      event.preventDefault();
      workspace.markSaved();
      updateToolbar();
    }
  }

  document.addEventListener("keydown", onGlobalKeydown);

  // Select the first page (or leave empty state) on mount.
  const first = workspace.getChildren(null)[0] ?? null;
  state.selectedPageId = first;
  if (first) selectSidebar(first);
  renderMain();

  return {
    destroy() {
      unsubscribeChange();
      document.removeEventListener("keydown", onGlobalKeydown);
      state.editor?.destroy();
      state.editor = null;
      clear(root);
    },
    /** @param {string} pageId */
    select(pageId) {
      selectSidebar(pageId);
    },
    /** @returns {import("./block-editor.js").EditorHandle | null} */
    getEditor: () => state.editor,
    /** @returns {string | null} */
    getSelection: () => selection()
  };
}
