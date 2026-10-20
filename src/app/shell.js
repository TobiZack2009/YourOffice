/**
 * Application shell: sidebar + title strip + ribbon + canvas, wired to a workspace.
 *
 * The shell owns page selection and the active editor instance; every mutation
 * flows through workspace commands. The ribbon is contextual: its tabs follow the
 * open page's type (see ribbon-tabs.js).
 */

import { exportWorkspaceJSON, importWorkspaceJSON, installDomain } from "../domain/index.js";
import { createSession } from "./session.js";
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
import {
  breadcrumb as breadcrumbOf,
  pageContent,
  pageExists,
  pageInfo,
  pageTitle,
  pageType
} from "../workspace/selectors.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/schema.js").PageType} PageType */

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
 *   onImportError?: (error: Error) => void,
 *   session?: import("./session.js").Session
 * }} [options] `session`: what the user is doing (open page, zoom, folds, selections); a fresh
 *   in-memory one by default, so a caller that wants it kept across loads passes a persisted one.
 */
export function mountApp(root, workspace, options = {}) {
  installDomain(workspace);

  const session = options.session ?? createSession();
  /** The open page is session state: `selectedPageId()` reads it, `openPage` writes it. */
  const selectedPageId = () => session.get().selectedPageId;
  /** @param {string | null} pageId */
  const openPage = (pageId) => void session.set({ selectedPageId: pageId });

  /** @type {{ editor: import("./block-editor.js").EditorHandle | null, sheetEditor: import("./sheet-editor.js").SheetEditorHandle | null, presentationEditor: import("./presentation-editor.js").PresentationEditorHandle | null, slideshow: import("./slideshow.js").SlideshowHandle | null, titleInput: HTMLInputElement | null }} */
  const state = { editor: null, sheetEditor: null, presentationEditor: null, slideshow: null, titleInput: null };
  /** The page the current editor was built for (the session may already name another one). */
  let renderedPageId = /** @type {string | null} */ (null);
  let renderedPageType = /** @type {string | null} */ (null);

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
    },
    redo() {
      workspace.redo();
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
    getZoom: () => session.get().zoom,
    setZoom(percent) {
      if (!ZOOM_LEVELS.includes(percent)) return;
      session.set({ zoom: percent });
      applyZoom();
      ribbon.update();
    },
    isSidebarCollapsed: () => !session.get().sidebarVisible,
    toggleSidebar() {
      session.set({ sidebarVisible: !session.get().sidebarVisible });
      applySidebarVisibility();
      ribbon.update();
    },
    startSlideshow,
    isSlideshowActive: () => state.slideshow !== null
  };

  /** @param {boolean} [initial] On mount, the default zoom leaves the canvas unmarked. */
  function applyZoom(initial = false) {
    const percent = ZOOM_LEVELS.includes(session.get().zoom) ? session.get().zoom : 100;
    canvas.style.setProperty("--zoom", String(percent / 100));
    if (!initial || percent !== 100) canvas.setAttribute("data-zoom", String(percent));
  }

  function applySidebarVisibility() {
    shell.classList.toggle("sidebar-collapsed", !session.get().sidebarVisible);
  }

  function getContext() {
    return {
      workspace,
      page: pageInfo(workspace, selectedPageId()),
      docEditor: state.editor,
      sheetEditor: state.sheetEditor,
      presentationEditor: state.presentationEditor,
      shell: shellApi
    };
  }

  // The animation timeline shows only while the Animations tab is open.
  const ribbon = createRibbon(getContext, {
    session,
    onTabChange: (tabId) => {
      state.presentationEditor?.setView({ timeline: tabId === "animations" });
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
    createSidebar(workspace, sidebarActions(), { session });

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
    if (!selectedPageId()) return null;
    const content = /** @type {import("../document/model.js").DocumentContent | undefined} */ (
      pageContent(workspace, selectedPageId() ?? "")
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
    const pageId = selectedPageId();
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
        if (slideId) session.set({ slideByPage: { ...session.get().slideByPage, [pageId]: slideId } });
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

  /** The selection of the open editor, as model terms. */
  function captureEditorSelection() {
    const editor = state.editor ?? state.sheetEditor ?? state.presentationEditor;
    return editor ? editor.captureSelection() : null;
  }

  /**
   * Remember the open editor's selection in the session, so the next editor for that page can
   * put it back (undo, import, coming back to the page).
   */
  function saveEditorSelection() {
    if (!renderedPageId) return;
    const captured = captureEditorSelection();
    const selections = { ...session.get().selections };
    if (captured) selections[renderedPageId] = captured;
    else delete selections[renderedPageId];
    session.set({ selections });
  }

  function renderMain() {
    const samePage = renderedPageId !== null && renderedPageId === selectedPageId();
    saveEditorSelection();
    state.slideshow?.destroy();
    state.slideshow = null;
    state.editor?.destroy();
    state.editor = null;
    state.sheetEditor?.destroy();
    state.sheetEditor = null;
    state.presentationEditor?.destroy();
    state.presentationEditor = null;
    state.titleInput = null;
    clear(canvas);

    const pageId = selectedPageId();
    renderedPageId = pageId;
    const page = pageInfo(workspace, pageId);
    renderedPageType = page?.type ?? null;
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
      if (value !== pageTitle(workspace, pageId)) workspace.dispatch("renamePage", { pageId, title: value });
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
    state.titleInput = titleInput;

    if (page.type === "document") {
      const editor = createDocumentEditor(workspace, page.id, {
        resolvePageTitle: (id) => pageTitle(workspace, id),
        navigate: (id) => selectSidebar(id),
        onActiveChange: () => updateChromeLater()
      });
      state.editor = editor;
      canvas.append(pageHeader, h("div", { class: "page-body" }, [editor.element]));
      // A caret is only put back when the same page is rebuilt: a page switch must not take focus.
      if (samePage) editor.restoreSelection(session.get().selections[page.id]);
    } else if (page.type === "sheet") {
      const sheetEditor = createSheetEditor(workspace, page.id, {
        navigate: (id) => selectSidebar(id),
        onChange: () => updateChromeLater(),
        onSelectionChange: () => scheduleRibbonUpdate()
      });
      state.sheetEditor = sheetEditor;
      canvas.append(pageHeader, sheetEditor.element);
      sheetEditor.restoreSelection(session.get().selections[page.id]);
    } else {
      const timeline = ribbon.getActiveTab() === "animations";
      if (session.get().presentationView.timeline !== timeline) {
        session.set({ presentationView: { ...session.get().presentationView, timeline } });
      }
      // Falling back to the first slide while the editor is being built is not the user's choice:
      // keep the remembered slide, so redo can return to it.
      let built = false;
      const presentationEditor = createPresentationEditor(workspace, page.id, {
        navigate: (id) => selectSidebar(id),
        onChange: () => updateChromeLater(),
        onSelectionChange: () => scheduleRibbonUpdate(),
        initialSlideId: session.get().slideByPage[page.id],
        onSlideChange: (slideId) => {
          if (!built) return;
          const slides = { ...session.get().slideByPage };
          if (slideId) slides[page.id] = slideId;
          else delete slides[page.id];
          session.set({ slideByPage: slides });
        },
        view: session.get().presentationView,
        onViewChange: (view) => session.set({ presentationView: view }),
        clipboard: session.get().presentationClipboard,
        onClipboardChange: (clipboard) => session.set({ presentationClipboard: clipboard })
      });
      built = true;
      state.presentationEditor = presentationEditor;
      canvas.append(pageHeader, presentationEditor.element);
      // The remembered slide wins over a selection that was taken on another one.
      const saved = session.get().selections[page.id];
      if (saved?.slideId === presentationEditor.getSlideId()) presentationEditor.restoreSelection(saved);
    }

    updateChrome();
  }

  /** Follow a rename of the open page (undo, redo, sidebar) without rebuilding the editor. */
  function syncTitleInput() {
    const input = state.titleInput;
    const title = pageTitle(workspace, selectedPageId());
    if (!input || title === null || title === undefined) return;
    if (document.activeElement !== input && input.value !== title) input.value = title;
  }

  function renderBreadcrumb() {
    clear(breadcrumb);
    /** @type {string[]} */
    const trail = [workspace.title || "Workspace"];
    const pageId = selectedPageId();
    for (const page of breadcrumbOf(workspace, pageId)) trail.push(page.title || "Untitled");
    trail.forEach((label, index) => {
      if (index > 0) breadcrumb.append(h("span", { class: "breadcrumb-sep", text: "/", "aria-hidden": "true" }));
      const last = index === trail.length - 1;
      breadcrumb.append(h("span", { class: `breadcrumb-item${last ? " is-current" : ""}`, text: label }));
    });
  }

  /** Undo/redo buttons, dirty dot and the play button: cheap, so refreshed on every change. */
  function updateStrip() {
    undoButton.disabled = !workspace.canUndo;
    redoButton.disabled = !workspace.canRedo;
    dirtyDot.classList.toggle("is-dirty", workspace.dirty);
    const onPresentation = pageType(workspace, selectedPageId()) === "presentation";
    playButton.style.display = onPresentation ? "" : "none";
    playButton.disabled = !state.presentationEditor?.getSlideId();
  }

  let ribbonFrame = 0;
  /** The ribbon asks every control for its state, so editors that report often share one pass per frame. */
  function scheduleRibbonUpdate() {
    if (ribbonFrame) return;
    ribbonFrame = requestAnimationFrame(() => {
      ribbonFrame = 0;
      ribbon.update();
    });
  }

  function flushRibbonUpdate() {
    if (ribbonFrame) cancelAnimationFrame(ribbonFrame);
    ribbonFrame = 0;
    ribbon.update();
  }

  /** What an editor reports (a change it saw, a selection move): strip now, ribbon once per frame. */
  function updateChromeLater() {
    updateStrip();
    scheduleRibbonUpdate();
  }

  /** Refresh everything derived from workspace/editor state: breadcrumb, strip, ribbon. */
  function updateChrome() {
    renderBreadcrumb();
    updateStrip();
    flushRibbonUpdate();
  }

  // -- sidebar actions ----------------------------------------------------------

  function sidebarActions() {
    return {
      /** @param {string} pageId */
      select(pageId) {
        openPage(pageId);
        renderMain();
      },
      /**
       * @param {PageType} type
       * @param {string | null} [parentId]
       */
      create(type, parentId = null) {
        const created = workspace.transact(`create ${type}`, () => {
          const { pageId: created } = workspace.dispatch("createPage", { type, title: defaultTitle(type), parentId });
          if (type === "document") {
            workspace.dispatch("insertBlock", {
              pageId: created,
              block: { type: "paragraph", runs: [] }
            });
          }
          if (type === "sheet") {
            workspace.dispatch("createTable", {
              pageId: created,
              name: "Table 1",
              rows: 12,
              columns: 6,
              x: 32,
              y: 32
            });
          }
          if (type === "presentation") {
            workspace.dispatch("createSlide", { pageId: created, layout: "title" });
          }
          return created;
        });
        openPage(created);
        refreshSidebar();
        renderMain();
        selectSidebar(created);
        const first = documentFirstBlockId();
        if (first) state.editor?.focusBlock(first, "start");
      },
      /** @param {string} pageId @param {string} title */
      rename(pageId, title) {
        workspace.dispatch("renamePage", { pageId, title });
        updateChrome();
      },
      /** @param {string} pageId */
      remove(pageId) {
        const children = workspace.getChildren(pageId);
        const title = pageTitle(workspace, pageId);
        const ask = options.confirm ?? ((message) => (typeof window !== "undefined" && window.confirm ? window.confirm(message) : true));
        const message =
          children.length > 0
            ? `Delete “${title ?? "page"}” and its ${children.length} child page(s)?`
            : `Delete “${title ?? "page"}”?`;
        if (!ask(message)) return;
        workspace.dispatch("deletePage", { pageId, cascade: children.length > 0 });
        if (!pageExists(workspace, selectedPageId())) {
          openPage(workspace.getChildren(null)[0] ?? null);
        }
        refreshSidebar();
        if (selectedPageId()) selectSidebar(selectedPageId() ?? "");
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
    const payload = /** @type {import("../workspace/changes.js").Change} */ (event);
    if (payload.registry) refreshSidebar();
    // The editors follow the change themselves; the shell rebuilds one only when the page it
    // shows is gone or became another kind of page. Anything else (undo, redo, a rename of the
    // open page) keeps the editor, its focus and its selection.
    const open = selectedPageId();
    const firstPage = workspace.getChildren(null)[0] ?? null;
    if (payload.kind !== "commit" && ((open && !pageExists(workspace, open)) || (!open && firstPage))) {
      openPage(firstPage);
      const next = selectedPageId();
      if (next) selectSidebar(next);
      renderMain();
      return;
    }
    if (payload.kind !== "commit" && pageType(workspace, open) !== renderedPageType) {
      renderMain();
      refreshSidebar();
      return;
    }
    if (payload.registry) {
      syncTitleInput();
      renderBreadcrumb();
    }
    updateChromeLater();
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

  // Open the page the session names if it still exists, else the first (or leave the empty state).
  const first = pageExists(workspace, selectedPageId()) ? selectedPageId() : (workspace.getChildren(null)[0] ?? null);
  openPage(first);
  applyZoom(true);
  applySidebarVisibility();
  if (first) selectSidebar(first);
  renderMain();

  return {
    destroy() {
      unsubscribeChange();
      if (ribbonFrame) cancelAnimationFrame(ribbonFrame);
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
