/**
 * Application shell: sidebar + title strip + ribbon + canvas, wired to a workspace.
 *
 * The shell owns page selection and the active editor instance; every mutation
 * flows through workspace commands. The ribbon is contextual: its tabs follow the
 * open page's type (see ribbon-tabs.js).
 */

import { createId } from "../core/ids.js";
import { exportWorkspaceJSON, importWorkspaceJSON, installDomain } from "../domain/index.js";
import { createSidebar } from "./sidebar.js";
import { createDocumentEditor } from "./block-editor.js";
import { createSheetEditor } from "./sheet-editor.js";
import { createPresentationEditor } from "./presentation-editor.js";
import { createRibbon } from "./ribbon.js";
import { createQuickFind } from "./quick-find.js";
import { createSlideshow } from "./slideshow.js";
import { icon } from "./icons.js";
import { usesModelHistory } from "./history-scope.js";
import { showNotice } from "./notice.js";
import { clear, h } from "./dom.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/schema.js").PageType} PageType */

const REGISTRY_COMMANDS = new Set([
  "createPage",
  "renamePage",
  "deletePage",
  "movePage",
  "renameWorkspace",
  "setFavorite"
]);

const ZOOM_LEVELS = [75, 100, 125, 150];

/**
 * Download `text` as a file in the browser.
 * @param {string} filename
 * @param {string} text
 */
function browserDownload(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** @param {string} title */
function fileStem(title) {
  const stem = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return stem || "workspace";
}

/**
 * Mount the full application UI.
 * @param {HTMLElement} root
 * @param {Workspace} workspace
 * @param {{
 *   confirm?: (message: string) => boolean,
 *   download?: (filename: string, text: string) => void,
 *   onImport?: (workspace: Workspace) => void,
 *   onImportError?: (error: Error) => void
 * }} [options]
 */
export function mountApp(root, workspace, options = {}) {
  installDomain(workspace);

  /** @type {{ selectedPageId: string | null, editor: import("./block-editor.js").EditorHandle | null, sheetEditor: import("./sheet-editor.js").SheetEditorHandle | null, presentationEditor: import("./presentation-editor.js").PresentationEditorHandle | null, zoom: number, slideshow: import("./slideshow.js").SlideshowHandle | null }} */
  const state = { selectedPageId: null, editor: null, sheetEditor: null, presentationEditor: null, zoom: 100, slideshow: null };
  // Presentation UI state that must survive the editor being rebuilt on undo/redo.
  const presentationView = { inspector: true, snap: true, grid: false, timeline: false };
  const presentationClipboard = { objects: /** @type {any[]} */ ([]), pastes: 0 };
  /** @type {Map<string, string>} */
  const lastSlideByPage = new Map();

  clear(root);
  const shell = h("div", { class: "app", "data-page-type": "none" });
  const main = h("main", { class: "main" });
  const canvas = h("div", { class: "canvas" });
  canvas.style.setProperty("--zoom", "1");

  // -- title strip -------------------------------------------------------------

  const breadcrumb = h("nav", { class: "breadcrumb", "aria-label": "Breadcrumb" });
  const undoButton = h("button", {
    class: "title-button",
    type: "button",
    "data-action": "undo",
    title: "Undo",
    "aria-label": "Undo"
  }, [icon("undo", { size: 16 })]);
  const redoButton = h("button", {
    class: "title-button",
    type: "button",
    "data-action": "redo",
    title: "Redo",
    "aria-label": "Redo"
  }, [icon("redo", { size: 16 })]);
  const playButton = h("button", {
    class: "title-button",
    type: "button",
    "data-action": "play-slideshow",
    title: "Start slide show from the current slide (Shift+Cmd/Ctrl+Enter)",
    "aria-label": "Start slide show"
  }, [icon("play", { size: 16 })]);
  playButton.style.display = "none";
  const dirtyDot = h("span", { class: "dirty-dot", title: "Unsaved changes", "aria-hidden": "true" });
  const titleStrip = h("header", { class: "title-strip" }, [
    breadcrumb,
    h("div", { class: "title-strip-end" }, [playButton, undoButton, redoButton, dirtyDot])
  ]);
  titleStrip.addEventListener("mousedown", (event) => {
    if (/** @type {HTMLElement} */ (event.target).closest("button")) event.preventDefault();
  });
  undoButton.addEventListener("click", () => shellApi.undo());
  redoButton.addEventListener("click", () => shellApi.redo());
  playButton.addEventListener("click", () => shellApi.startSlideshow("current"));

  // -- ribbon -------------------------------------------------------------------

  /** @type {import("./ribbon-tabs.js").ShellApi} */
  const shellApi = {
    undo() {
      workspace.undo();
      renderMain();
    },
    redo() {
      workspace.redo();
      renderMain();
    },
    save() {
      workspace.markSaved();
      updateChrome();
    },
    exportJSON() {
      const text = exportWorkspaceJSON(workspace);
      (options.download ?? browserDownload)(`${fileStem(workspace.title)}.yourOffice.json`, text);
      workspace.markSaved();
      updateChrome();
    },
    pickImport() {
      fileInput.value = "";
      fileInput.click();
    },
    renameWorkspace(title) {
      workspace.dispatch("renameWorkspace", { title });
      updateChrome();
    },
    getZoom: () => state.zoom,
    setZoom(percent) {
      if (!ZOOM_LEVELS.includes(percent)) return;
      state.zoom = percent;
      canvas.style.setProperty("--zoom", String(percent / 100));
      canvas.setAttribute("data-zoom", String(percent));
      ribbon.update();
    },
    isSidebarCollapsed: () => shell.classList.contains("sidebar-collapsed"),
    toggleSidebar() {
      shell.classList.toggle("sidebar-collapsed");
      ribbon.update();
    },
    startSlideshow,
    isSlideshowActive: () => state.slideshow !== null
  };

  function getContext() {
    return {
      workspace,
      page: state.selectedPageId ? workspace.getPage(state.selectedPageId) : undefined,
      docEditor: state.editor,
      sheetEditor: state.sheetEditor,
      presentationEditor: state.presentationEditor,
      shell: shellApi
    };
  }

  // The animation timeline shows only while the Animations tab is open.
  const ribbon = createRibbon(getContext, {
    onTabChange: (tabId) => {
      presentationView.timeline = tabId === "animations";
      state.presentationEditor?.setView({ timeline: presentationView.timeline });
    }
  });

  // Hidden file input behind File > Import.
  const fileInput = /** @type {HTMLInputElement} */ (
    h("input", { type: "file", accept: ".json,application/json", class: "visually-hidden", "data-role": "import-file", tabindex: "-1" })
  );
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = importWorkspaceJSON(String(reader.result ?? ""));
        options.onImport?.(imported);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (options.onImportError) options.onImportError(failure);
        else if (typeof window !== "undefined" && window.alert) window.alert(`Import failed: ${failure.message}`);
      }
    };
    reader.readAsText(file);
  });

  const { element: sidebarElement, refresh: refreshSidebar, select: selectSidebar, selection } =
    createSidebar(workspace, sidebarActions());

  main.append(titleStrip, ribbon.element, canvas);
  shell.append(sidebarElement, main, fileInput);
  root.append(shell);

  const quickFind = createQuickFind(workspace, {
    container: shell,
    onSelect: (pageId) => {
      selectSidebar(pageId);
    }
  });

  // -- main canvas --------------------------------------------------------------

  function documentFirstBlockId() {
    if (!state.selectedPageId) return null;
    const page = workspace.getPage(state.selectedPageId);
    const content = /** @type {import("../document/model.js").DocumentContent | undefined} */ (
      page?.content
    );
    return content?.blockOrder?.[0] ?? null;
  }

  /**
   * Play the open presentation over the main column. The sidebar stays; leaving the show
   * (Esc, the exit button, or choosing a page) brings back the editor at the slide reached.
   * @param {"beginning" | "current"} [from]
   * @returns {boolean} false when there is nothing to play
   */
  function startSlideshow(from = "current") {
    const editor = state.presentationEditor;
    const pageId = state.selectedPageId;
    if (state.slideshow) return true;
    if (!editor || !pageId) return false;
    // Commit any text being edited, and keep Space/Enter off a focused ribbon button.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    editor.stopPreview();
    const show = createSlideshow(workspace, pageId, {
      startSlideId: from === "current" ? editor.getSlideId() : null,
      navigate: (target) => selectSidebar(target),
      onExit: (slideId) => {
        state.slideshow = null;
        lastSlideByPage.set(pageId, slideId);
        state.presentationEditor?.selectSlide(slideId);
        ribbon.update();
      }
    });
    if (!show) return false;
    state.slideshow = show;
    main.append(show.element);
    show.start();
    show.focus();
    return true;
  }

  function renderMain() {
    state.slideshow?.destroy();
    state.slideshow = null;
    state.editor?.destroy();
    state.editor = null;
    state.sheetEditor?.destroy();
    state.sheetEditor = null;
    state.presentationEditor?.destroy();
    state.presentationEditor = null;
    clear(canvas);

    const pageId = state.selectedPageId;
    const page = pageId ? workspace.getPage(pageId) : undefined;
    shell.setAttribute("data-page-type", page?.type ?? "none");
    ribbon.setPage(page?.type ?? null);

    if (!page) {
      canvas.append(
        h("div", { class: "canvas-empty" }, [
          h("h2", { text: "No page selected" }),
          h("p", { text: "Create a page from the sidebar to get started." })
        ])
      );
      updateChrome();
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
    pageHeader.append(titleInput);

    if (page.type === "document") {
      const editor = createDocumentEditor(workspace, page.id, {
        resolvePageTitle: (id) => workspace.getPage(id)?.title,
        navigate: (id) => selectSidebar(id),
        onActiveChange: () => updateChrome()
      });
      state.editor = editor;
      canvas.append(pageHeader, h("div", { class: "page-body" }, [editor.element]));
    } else if (page.type === "sheet") {
      const sheetEditor = createSheetEditor(workspace, page.id, {
        navigate: (id) => selectSidebar(id),
        onChange: () => updateChrome(),
        onSelectionChange: () => ribbon.update()
      });
      state.sheetEditor = sheetEditor;
      canvas.append(pageHeader, sheetEditor.element);
    } else {
      presentationView.timeline = ribbon.getActiveTab() === "animations";
      const presentationEditor = createPresentationEditor(workspace, page.id, {
        navigate: (id) => selectSidebar(id),
        onChange: () => updateChrome(),
        onSelectionChange: () => ribbon.update(),
        initialSlideId: lastSlideByPage.get(page.id),
        onSlideChange: (slideId) => lastSlideByPage.set(page.id, slideId),
        view: presentationView,
        clipboard: presentationClipboard
      });
      state.presentationEditor = presentationEditor;
      canvas.append(pageHeader, presentationEditor.element);
    }

    updateChrome();
  }

  function renderBreadcrumb() {
    clear(breadcrumb);
    /** @type {string[]} */
    const trail = [workspace.title || "Workspace"];
    const pageId = state.selectedPageId;
    if (pageId && workspace.getPage(pageId)) {
      /** @type {string[]} */
      const ancestors = [];
      let parent = workspace.getParent(pageId);
      while (parent) {
        ancestors.unshift(workspace.getPage(parent)?.title || "Untitled");
        parent = workspace.getParent(parent);
      }
      trail.push(...ancestors, workspace.getPage(pageId)?.title || "Untitled");
    }
    trail.forEach((label, index) => {
      if (index > 0) breadcrumb.append(h("span", { class: "breadcrumb-sep", text: "/", "aria-hidden": "true" }));
      const last = index === trail.length - 1;
      breadcrumb.append(h("span", { class: `breadcrumb-item${last ? " is-current" : ""}`, text: label }));
    });
  }

  /** Refresh everything derived from workspace/editor state: strip, dirty dot, ribbon. */
  function updateChrome() {
    renderBreadcrumb();
    undoButton.disabled = !workspace.canUndo;
    redoButton.disabled = !workspace.canRedo;
    dirtyDot.classList.toggle("is-dirty", workspace.dirty);
    const onPresentation = state.selectedPageId ? workspace.getPage(state.selectedPageId)?.type === "presentation" : false;
    playButton.style.display = onPresentation ? "" : "none";
    playButton.disabled = !state.presentationEditor?.getSlideId();
    ribbon.update();
  }

  // -- sidebar actions ----------------------------------------------------------

  function sidebarActions() {
    return {
      /** @param {string} pageId */
      select(pageId) {
        state.selectedPageId = pageId;
        renderMain();
      },
      /**
       * @param {PageType} type
       * @param {string | null} [parentId]
       */
      create(type, parentId = null) {
        workspace.transact(`create ${type}`, () => {
          workspace.dispatch("createPage", { type, title: defaultTitle(type), parentId });
          const created = workspace.getChildren(parentId).slice(-1)[0];
          if (type === "document" && created) {
            workspace.dispatch("insertBlock", {
              pageId: created,
              block: { type: "paragraph", runs: [] }
            });
          }
          if (type === "sheet" && created) {
            workspace.dispatch("createTable", {
              pageId: created,
              name: "Table 1",
              rows: 12,
              columns: 6,
              x: 32,
              y: 32
            });
          }
          if (type === "presentation" && created) {
            workspace.dispatch("createSlide", { pageId: created, slideId: createId("slide"), layout: "title" });
          }
        });
        const created = workspace.getChildren(parentId).slice(-1)[0];
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
        updateChrome();
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
        shellApi.renameWorkspace(title);
      },
      /** @param {string} pageId @param {boolean} favorite */
      favorite(pageId, favorite) {
        workspace.dispatch("setFavorite", { pageId, favorite });
        refreshSidebar();
      },
      openQuickFind() {
        quickFind.open();
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

  // A listener that throws must not take the others down; tell the person instead of the console only.
  const previousOnError = workspace.events.onError;
  workspace.events.onError = (error) => {
    console.error("change listener threw", error);
    showNotice("Something went wrong while updating the view.");
  };

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
    updateChrome();
  });

  /** @param {KeyboardEvent} event */
  function onGlobalKeydown(event) {
    if (state.slideshow) return;
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === "enter") {
      if (!state.presentationEditor) return;
      event.preventDefault();
      startSlideshow(event.shiftKey ? "current" : "beginning");
    } else if (key === "k") {
      event.preventDefault();
      quickFind.open();
    } else if (key === "z" && !event.shiftKey) {
      if (!usesModelHistory(event.target)) return;
      event.preventDefault();
      shellApi.undo();
    } else if ((key === "z" && event.shiftKey) || key === "y") {
      if (!usesModelHistory(event.target)) return;
      event.preventDefault();
      shellApi.redo();
    } else if (key === "s") {
      event.preventDefault();
      shellApi.save();
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
      workspace.events.onError = previousOnError;
      document.removeEventListener("keydown", onGlobalKeydown);
      quickFind.destroy();
      ribbon.destroy();
      state.slideshow?.destroy();
      state.slideshow = null;
      state.editor?.destroy();
      state.editor = null;
      state.sheetEditor?.destroy();
      state.sheetEditor = null;
      state.presentationEditor?.destroy();
      state.presentationEditor = null;
      clear(root);
    },
    /** @param {string} pageId */
    select(pageId) {
      selectSidebar(pageId);
    },
    /** @returns {import("./block-editor.js").EditorHandle | null} */
    getEditor: () => state.editor,
    /** @returns {import("./sheet-editor.js").SheetEditorHandle | null} */
    getSheetEditor: () => state.sheetEditor,
    /** @returns {import("./presentation-editor.js").PresentationEditorHandle | null} */
    getPresentationEditor: () => state.presentationEditor,
    /** @returns {string | null} */
    getSelection: () => selection(),
    openQuickFind: () => quickFind.open(),
    /** @returns {import("./slideshow.js").SlideshowHandle | null} */
    getSlideshow: () => state.slideshow,
    startSlideshow
  };
}
