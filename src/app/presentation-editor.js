/**
 * Presentation editor: slide strip, stage and inspector for one presentation page.
 *
 * Model-first like the sheet and document editors: the slides live in the
 * workspace, this module only owns UI state (current slide, selection, the armed
 * insert tool, an in-place text edit, and the mouse gesture in flight) and turns
 * user intent into validated commands.
 *
 * Mouse gestures (`move | resize | rotate | marquee | draw | path`) preview directly on
 * the live DOM while the button is down and dispatch ONE command on release, so a
 * drag is a single undo step. The stage is the slide drawn at its logical size and
 * scaled with a CSS transform; pointer coordinates are converted back with
 * `rect.width / size.width` (falling back to 1 where there is no layout, as in jsdom).
 *
 * The handle returned here is the ribbon's whole interface, and the inspector's.
 */

import { buildBook } from "../references/table-engine.js";
import { clampPresentationSelection, readPresentationSelection } from "./selection.js";
import { createAnimationTimeline } from "./animation-timeline.js";
import { createGestureScope } from "./gesture.js";
import { createInspector } from "./inspector.js";
import { createPopoverHost } from "./popover.js";
import { createPresentationContent, readPresentationContent } from "../presentation/model.js";
import { createSlideStrip } from "./slide-strip.js";
import { defaultNotice } from "./notice.js";
import { enginesFor, staticReferenceHooks } from "../export/static-render.js";
import { findSectionByLocator, slideLocator } from "../references/sections.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { pageContent, pageExists, pageList, pageTitle } from "../workspace/selectors.js";
import { planSlideReorder, rotatedBounds, unionBounds } from "../presentation/geometry.js";
import { promptName, referenceCount, sectionMenuItems, showMenu as showAnchoredMenu, showReferenceList } from "./handles.js";
import { createPresentationStage } from "./presentation-stage.js";
import { createPresentationReferences } from "./presentation-references.js";
import { createPresentationSlides } from "./presentation-slides.js";
import { createPresentationObjects } from "./presentation-objects.js";
import { createPresentationAnimations } from "./presentation-animations.js";
import { createPresentationText } from "./presentation-text.js";
import { createPresentationGestures } from "./presentation-gestures.js";
import { createPresentationInput } from "./presentation-input.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../presentation/model.js").SlideObject} SlideObject */
/** @typedef {import("../presentation/model.js").Slide} Slide */
/** @typedef {import("../presentation/model.js").Animation} Animation */
/** @typedef {import("../presentation/model.js").PresentationContent} PresentationContent */
/** @typedef {import("./marks.js").Mark} Mark */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * The armed insert tool: the next drag on the stage draws this object.
 * @typedef {{ type: "text" } | { type: "shape", shape: string } | { type: "line" }} Tool
 *
 * @typedef {object} View
 * @property {boolean} inspector Show the right-hand inspector.
 * @property {boolean} snap Snap moves to guides (slide edges/centre, other objects).
 * @property {boolean} grid Snap moves to a 10px grid and show it.
 * @property {boolean} [timeline] Show the animation timeline under the stage.
 *
 * @typedef {object} PresentationEditorOptions
 * @property {() => void} [onChange] Called after the editor re-rendered from a model change.
 * @property {(pageId: string) => void} [navigate] Go to another page (used by reference lists).
 * @property {import("./notice.js").Notice} [notice] Where refused commands are reported.
 * @property {(assetId: string) => string | undefined} [resolveAssetUrl] Where image assets are shown from.
 * @property {() => void} [onSelectionChange] Called when selection, tool, view or edit state changes.
 * @property {string | null} [initialSlideId] Slide to open on (falls back to the first).
 * @property {(slideId: string | null) => void} [onSlideChange]
 * @property {View} [view] Initial view state (the caller keeps it in the session so it survives remounts).
 * @property {(view: View) => void} [onViewChange] Called with a copy of the view after it changed.
 * @property {{ objects: SlideObject[], pastes: number }} [clipboard] Initial object clipboard, same reason.
 * @property {(clipboard: { objects: SlideObject[], pastes: number }) => void} [onClipboardChange]
 */

export { GRID_SIZE, NUDGE, NUDGE_FAST } from "./presentation-dom.js";

/**
 * @param {Workspace} workspace
 * @param {string} pageId
 * @param {PresentationEditorOptions} [options]
 */
export function createPresentationEditor(workspace, pageId, options = {}) {
  const notice = options.notice ?? defaultNotice;
  /** @type {View} */
  const view = { inspector: true, snap: true, grid: false, timeline: false, ...options.view };

  /**
   * The editor's mutable state, in one object so the modules it is split into share it.
   * @type {{ cached: PresentationContent | null, currentSlideId: string | null, lostSlideId: string | null, selectedIds: string[], tool: Tool | null, destroyed: boolean, suppressBlur: boolean, stage: HTMLElement | null, slideEl: HTMLElement | null, overlay: HTMLElement | null, scale: number, stageKey: string, resizeObserver: ResizeObserver | null, selectedAnimationId: string | null, previewHandle: import("./animation-preview.js").PreviewHandle | null, hookCache: ReturnType<typeof staticReferenceHooks> | null, drewReferences: boolean, gesture: any, editing: { id: string, host: HTMLElement, original: import("../document/model.js").InlineRun[], lastRange: Range | null } | null, syncedSelection: string, gestureStops: Array<() => void>, clipboard: { objects: SlideObject[], pastes: number }}}
   */
  const st = {
    cached: null,
    currentSlideId: options.initialSlideId ?? null,
    lostSlideId: null,
    selectedIds: [],
    tool: null,
    destroyed: false,
    suppressBlur: false,
    stage: null,
    slideEl: null,
    overlay: null,
    scale: 1,
    stageKey: "",
    resizeObserver: null,
    selectedAnimationId: null,
    previewHandle: null,
    hookCache: null,
    drewReferences: false,
    gesture: null,
    editing: null,
    syncedSelection: "",
    gestureStops: [],
    clipboard: structuredClone(options.clipboard ?? { objects: [], pastes: 0 })
  };

  const popovers = createPopoverHost(document.body);

  const root = h("div", { class: "presentation-editor", tabindex: "-1", "data-role": "presentation-editor" });
  const stageArea = h("div", { class: "stage-area", tabindex: "0", "data-role": "stage-area", "aria-label": "Slide", "data-history": "model" });
  const imageInput = /** @type {HTMLInputElement} */ (
    h("input", { type: "file", accept: "image/*", class: "visually-hidden", tabindex: "-1", "data-role": "image-file" })
  );

  /** @type {Map<string, HTMLElement>} */
  const objectEls = new Map();
  /** What each stage object was drawn from, so an unchanged one keeps its element. @type {Map<string, { signature: string | null, el: HTMLElement }>} */
  const objectViews = new Map();
  /** Grown heights of `autoHeight` text objects (measured, never stored). @type {Map<string, number>} */
  const autoHeights = new Map();

  /**
   * What the live gesture is showing, drawn into the overlay.
   * @type {{ rects: Map<string, Partial<SlideObject>>, guides: import("../presentation/geometry.js").Guide[], marquee: Rect | null, draw: { tool: Tool, rect: Rect } | null, path: { animationId: string, from: { x: number, y: number }, to: { x: number, y: number } } | null }}
   */
  const preview = { rects: new Map(), guides: [], marquee: null, draw: null, path: null };

  // -- model access ------------------------------------------------------------

  function getContent() {
    if (!st.cached) {
      st.cached = pageExists(workspace, pageId)
        ? readPresentationContent(pageContent(workspace, pageId), pageId)
        : createPresentationContent();
    }
    return st.cached;
  }

  const getSize = () => getContent().size;
  const getSlideId = () => st.currentSlideId;

  /** @returns {Slide | null} */
  function getSlide() {
    const content = getContent();
    return (st.currentSlideId && content.slides[st.currentSlideId]) || null;
  }

  /** @returns {SlideObject[]} Selected objects in z-order. */
  function getSelectedObjects() {
    const slide = getSlide();
    if (!slide) return [];
    return slide.objectOrder.filter((id) => st.selectedIds.includes(id)).map((id) => slide.objects[id]);
  }

  function getSelectionBounds() {
    const objects = getSelectedObjects();
    return objects.length > 0 ? unionBounds(objects.map(rotatedBounds)) : null;
  }

  /**
   * @param {string} type
   * @param {Record<string, unknown>} payload
   */
  function send(type, payload) {
    workspace.dispatch(type, { pageId, ...payload });
  }

  /**
   * Run a model mutation, turning a rejected command into a notice instead of a crash.
   * @param {() => void} fn
   * @returns {boolean}
   */
  function run(fn) {
    return notice.guard(fn, refresh);
  }

  /** @param {string} message */
  function notify(message) {
    notice.show(message);
  }

  // -- references on slides --------------------------------------------------------

  /**
   * Hooks that draw reference objects and inline references read-only. Built lazily, once per
   * model change, so a slide without references never pays for the formula engines.
   */
  function slideHooks() {
    if (!st.hookCache) {
      const data = workspace.data;
      /** @type {any} */
      let engines = null;
      /** @type {any} */
      let book = null;
      const ctx = {
        data,
        get engines() {
          return (engines ??= enginesFor(data));
        },
        get book() {
          return (book ??= buildBook(data));
        },
        resolvePageTitle: (/** @type {string} */ id) => pageTitle(workspace, id),
        resolveAssetUrl: options.resolveAssetUrl
      };
      const hooks = staticReferenceHooks(/** @type {any} */ (ctx), pageId, 1);
      st.hookCache = {
        resolveAssetUrl: options.resolveAssetUrl,
        renderReference: (object) => {
          st.drewReferences = true;
          return hooks.renderReference(object);
        },
        renderInlineRef: (ref) => {
          st.drewReferences = true;
          return hooks.renderInlineRef(ref);
        }
      };
    }
    return st.hookCache;
  }

  // -- slide strip + inspector ---------------------------------------------------

  const strip = createSlideStrip({
    getContent,
    getCurrent: () => st.currentSlideId,
    slideHooks,
    popovers,
    onSelect: (slideId) => selectSlide(slideId),
    onCreate: ({ layout, index }) => newSlide(layout, index),
    onDuplicate: (slideId) => duplicateSlide(slideId),
    onDelete: (slideId) => deleteSlide(slideId),
    onDeleteMany: (slideIds) => deleteSlides(slideIds),
    onMove: (slideId, index) => moveSlide(slideId, index),
    referenceCount: (slideId) => {
      const section = findSectionByLocator(workspace.data.pages[pageId], { slideId });
      return section ? referenceCount(workspace, section.id) : 0;
    },
    onHandle: (slideIds, anchor) => openSlideHandle(slideIds, anchor)
  });

  /**
   * The click-only section handle of a slide, or of a selection of several: name them
   * as one section, see what reads it.
   * @param {string[]} slideIds In presentation order.
   * @param {HTMLElement} anchor
   */
  function openSlideHandle(slideIds, anchor) {
    const locator = slideLocator(slideIds);
    const many = slideIds.length > 1;
    const found = findSectionByLocator(workspace.data.pages[pageId], locator);
    /** @type {import("./popover.js").MenuItem[]} */
    let items;
    if (found?.name) {
      items = sectionMenuItems({ workspace, popovers, anchor: () => anchor, sectionId: found.id, navigate: options.navigate, guard: notice.guard });
    } else {
      const count = found ? referenceCount(workspace, found.id) : 0;
      items = [
        {
          label: many ? `Name these ${slideIds.length} slides` : "Name this slide",
          icon: "rename",
          attrs: { "data-action": "section-make" },
          action: () =>
            promptName(popovers, anchor, {
              title: many ? "Name for these slides" : "Slide name",
              confirm: "Save",
              onSubmit: (name) =>
                run(() =>
                  found
                    ? workspace.dispatch("renameSection", { sectionId: found.id, name })
                    : workspace.dispatch("createSection", { pageId, locator, name })
                )
            })
        },
        {
          label: `Show references (${count})`,
          icon: "link",
          disabled: !found,
          attrs: { "data-action": "section-references" },
          action: () => found && showReferenceList({ workspace, popovers, anchor, sectionId: found.id, navigate: options.navigate })
        }
      ];
    }
    showAnchoredMenu(popovers, anchor, items);
  }

  /** @type {import("./inspector.js").InspectorApi} */
  const inspectorApi = {
    getSelectedObjects,
    getSlide,
    getSize,
    getSelectionBounds,
    setGeometry: (patch) => setGeometry(patch),
    setFill: (color) => setFill(color),
    setStroke: (stroke) => setStroke(stroke),
    setTextStyle: (style) => setTextStyle(style),
    arrange: (op) => arrange(op),
    setObjectLink: (link) => setObjectLink(link),
    setBackground: (color) => setBackground(color),
    setTransition: (patch) => setTransition(patch),
    applyTransitionToAll: () => applyTransitionToAll(),
    requestSlideSize: (width, height) => requestSlideSize(width, height),
    listPages: () => pageList(workspace),
    listSlides: () => getContent().slideOrder.map((id, i) => ({ id, number: i + 1 }))
  };
  const inspector = createInspector(inspectorApi);

  const timeline = createAnimationTimeline({
    getSlide,
    getSelectedId: () => st.selectedAnimationId,
    isPreviewing: () => st.previewHandle !== null,
    onSelect: (id) => selectAnimation(id),
    onMove: (id, index) => moveAnimation(id, index),
    onUpdate: (id, patch) => updateAnimation(patch, id),
    onDelete: (id) => removeAnimation(id),
    onTogglePreview: () => (st.previewHandle ? stopPreview() : void startPreview())
  });

  /** Document-level listeners of the running gesture; aborted on destroy. */
  const gestureScope = createGestureScope(document);
  /** @type {Record<string, any>} The modules the editor is split into, by name. */
  const parts = {};

  /** The editor kernel: what the modules share. Functions are hoisted, so each module can take what it needs at once. */
  const ed = {
    afterStateChange,
    autoHeights,
    gestureScope,
    getContent,
    getSelectedObjects,
    getSelectionBounds,
    getSize,
    getSlide,
    imageInput,
    inspector,
    notice,
    notify,
    objectEls,
    objectViews,
    options,
    pageId,
    popovers,
    preview,
    refresh,
    root,
    run,
    selectAll,
    selectObjects,
    send,
    slideHooks,
    st,
    stageArea,
    timeline,
    view,
    workspace
  };

  // What the modules offer one another and the editor, by the module that defines it.
  /** @type {Record<string, string>} */
  const offered = {
    stage: "clearPreview computeScale previewObject renderOverlay renderStage",
    references: "editExpression insertEmbed insertExpression referenceHandle",
    slides: "applyTransitionToAll canDeleteSlide deleteSlide deleteSlides duplicateSlide moveCurrentSlide moveSlide newSlide requestSlideSize selectSlide setBackground setSlideSize setTransition",
    objects: "arrange canPaste copySelected createFromTool cutSelected defaultBox deleteSelected duplicateSelected getTool insertImage pasteObjects patchObjects pickImage setAlign setFill setGeometry setObjectLink setStroke setTextStyle setTool",
    animations: "addAnimation applyAnimationEffect describeAnimations getAnimations getSelectedAnimation isPreviewing moveAnimation moveSelectedAnimation removeAnimation selectAnimation startPreview stopPreview syncAnimationToSelection updateAnimation",
    text: "canEditText createLinkForm editableId finishEdit getLinkInfo getLinkUrl getTextState isEditing markActive onSelectionChange setLink startEdit toggleMark",
    gestures: "cancelGesture onMouseDown stopDocumentListeners",
    input: "onContextMenu onDoubleClick onKeydown"
  };
  for (const [part, names] of Object.entries(offered)) {
    for (const name of names.split(" ")) ed[name] = (/** @type {any[]} */ ...args) => parts[part][name](...args);
  }

  parts.stage = createPresentationStage(ed);
  parts.references = createPresentationReferences(ed);
  parts.slides = createPresentationSlides(ed);
  parts.objects = createPresentationObjects(ed);
  parts.animations = createPresentationAnimations(ed);
  parts.text = createPresentationText(ed);
  parts.gestures = createPresentationGestures(ed);
  parts.input = createPresentationInput(ed);

  const {
    addAnimation, applyAnimationEffect, applyTransitionToAll, arrange, canDeleteSlide, canEditText,
    canPaste, clearPreview, computeScale, copySelected, createLinkForm, cutSelected, deleteSelected,
    deleteSlide, deleteSlides, describeAnimations, duplicateSelected, duplicateSlide, finishEdit,
    getAnimations, getLinkInfo, getLinkUrl, getSelectedAnimation, getTextState, getTool,
    insertEmbed, insertExpression, insertImage, isEditing, isPreviewing, markActive, moveAnimation,
    moveCurrentSlide, moveSelectedAnimation, moveSlide, newSlide, onContextMenu, onDoubleClick,
    onKeydown, onMouseDown, onSelectionChange, pasteObjects, pickImage, removeAnimation,
    renderOverlay, renderStage, requestSlideSize, selectAnimation, selectSlide, setAlign,
    setBackground, setFill, setGeometry, setLink, setObjectLink, setSlideSize, setStroke,
    setTextStyle, setTool, setTransition, startEdit, startPreview, stopDocumentListeners,
    stopPreview, syncAnimationToSelection, toggleMark, updateAnimation
  } = ed;

  root.append(strip.element, stageArea, timeline.element, inspector.element, imageInput);

  // -- stage rendering ------------------------------------------------------------

  /** Everything derived from the model: strip, stage, inspector. */
  function refresh() {
    if (st.destroyed) return;
    stopPreview({ quiet: true });
    st.cached = null;
    st.hookCache = null;
    st.drewReferences = false;
    const content = getContent();
    if (st.lostSlideId && content.slides[st.lostSlideId]) {
      // The slide the user was on came back (redo): go back to it.
      st.currentSlideId = st.lostSlideId;
      st.lostSlideId = null;
      st.selectedIds = [];
      options.onSlideChange?.(st.currentSlideId);
    }
    if (!st.currentSlideId || !content.slides[st.currentSlideId]) {
      if (st.currentSlideId) st.lostSlideId = st.currentSlideId;
      const next = content.slideOrder[0] ?? null;
      if (next !== st.currentSlideId) {
        st.currentSlideId = next;
        options.onSlideChange?.(next);
      }
      st.selectedIds = [];
    }
    const slide = getSlide();
    st.selectedIds = st.selectedIds.filter((id) => slide?.objects[id]);
    if (st.selectedAnimationId && !slide?.animations?.[st.selectedAnimationId]) st.selectedAnimationId = null;
    st.editing = null;
    st.gesture = null;
    clearPreview();
    strip.render();
    timeline.render();
    renderStage();
    inspector.render();
    options.onChange?.();
    options.onSelectionChange?.();
  }

  /** Selection/tool/view/edit changed without a model change. */
  function afterStateChange() {
    syncAnimationToSelection();
    renderOverlay();
    stageArea.dataset.tool = st.tool ? st.tool.type : "";
    stageArea.classList.toggle("is-editing", st.editing !== null);
    inspector.render();
    options.onSelectionChange?.();
  }

  // -- selection -------------------------------------------------------------------

  /**
   * @param {string[]} ids
   */
  function selectObjects(ids) {
    finishEdit(true);
    const slide = getSlide();
    st.selectedIds = slide ? slide.objectOrder.filter((id) => ids.includes(id)) : [];
    afterStateChange();
  }

  function selectAll() {
    const slide = getSlide();
    if (slide) selectObjects([...slide.objectOrder]);
  }

  // -- slides --------------------------------------------------------------------------

  // -- slide settings -----------------------------------------------------------------

  // -- object commands ------------------------------------------------------------------

  // -- animations ----------------------------------------------------------------------------------

  // -- tools + insert -----------------------------------------------------------------------

  // -- in-place text -------------------------------------------------------------------------

  // Remember the last caret/selection inside the edited text, so a ribbon popover that takes focus
  // (the link field) can still act on what was selected.

  // -- mouse gestures ------------------------------------------------------------------------------

  // -- context menu ------------------------------------------------------------------------------------

  // -- keyboard ------------------------------------------------------------------------------------------

  // -- wiring ------------------------------------------------------------------------------------------------

  stageArea.addEventListener("mousedown", (event) => onMouseDown(/** @type {MouseEvent} */ (event)));
  stageArea.addEventListener("dblclick", (event) => onDoubleClick(/** @type {MouseEvent} */ (event)));
  stageArea.addEventListener("contextmenu", (event) => onContextMenu(/** @type {MouseEvent} */ (event)));
  root.addEventListener("keydown", (event) => onKeydown(/** @type {KeyboardEvent} */ (event)));

  const unsubscribe = workspace.events.on("change", (event) => {
    if (st.destroyed) return;
    const payload = /** @type {{ pages?: string[] }} */ (event ?? {});
    if (payload.pages && !payload.pages.includes(pageId) && !st.drewReferences) return;
    st.cached = null;
    if (st.editing) {
      const dispatched = finishEdit(true);
      if (dispatched) return;
    }
    refresh();
  });

  if (typeof ResizeObserver !== "undefined") {
    st.resizeObserver = new ResizeObserver(() => {
      if (st.destroyed || st.gesture || st.editing) return;
      if (Math.abs(computeScale() - st.scale) > 0.001) {
        stopPreview();
        renderStage();
      }
    });
    st.resizeObserver.observe(stageArea);
  }

  /** @param {Partial<View>} patch */
  function setView(patch) {
    Object.assign(view, patch);
    options.onViewChange?.({ ...view });
    root.classList.toggle("hide-inspector", !view.inspector);
    root.classList.toggle("show-timeline", Boolean(view.timeline));
    st.stage?.classList.toggle("show-grid", view.grid);
    if (!view.timeline) stopPreview({ quiet: true });
    renderOverlay();
    timeline.render();
    options.onSelectionChange?.();
  }

  root.classList.toggle("hide-inspector", !view.inspector);
  root.classList.toggle("show-timeline", Boolean(view.timeline));
  if (!st.currentSlideId || !getContent().slides[st.currentSlideId]) st.currentSlideId = getContent().slideOrder[0] ?? null;
  strip.render();
  timeline.render();
  renderStage();
  inspector.render();

  return {
    element: root,
    refresh,
    destroy() {
      st.destroyed = true;
      stopPreview({ quiet: true });
      stopDocumentListeners();
      gestureScope.abort();
      parts.text.dispose();
      unsubscribe();
      st.resizeObserver?.disconnect();
      notice.clear();
      popovers.destroy();
    },
    // state
    getContent,
    getSlide,
    getSlideId,
    getSize,
    getSelection: () => [...st.selectedIds],
    captureSelection: () => ({ slideId: st.currentSlideId, objectIds: [...st.selectedIds] }),
    /**
     * Put a captured selection back: the slide, and the objects that still exist on it.
     * @param {unknown} value
     * @returns {boolean} Whether a selection was restored.
     */
    restoreSelection(value) {
      const wanted = readPresentationSelection(value);
      const clamped = wanted ? clampPresentationSelection(wanted, getContent()) : null;
      if (!clamped?.slideId) return false;
      selectSlide(clamped.slideId);
      selectObjects(clamped.objectIds);
      return true;
    },
    dependsOn: () => new Set([pageId]),
    getSelectedObjects,
    getSelectionBounds,
    selectObjects,
    selectAll,
    selectSlide,
    getView: () => ({ ...view }),
    setView,
    getTool,
    setTool,
    listPages: inspectorApi.listPages,
    listSlides: inspectorApi.listSlides,
    // references
    insertEmbed,
    insertExpression,
    // slides
    newSlide,
    duplicateSlide,
    deleteSlide,
    canDeleteSlide,
    moveSlide,
    moveCurrentSlide,
    planReorder: (/** @type {string} */ dragId, /** @type {{ type: "before" | "after", id: string }} */ target) =>
      planSlideReorder(getContent().slideOrder, dragId, target),
    setBackground,
    setTransition,
    applyTransitionToAll,
    requestSlideSize,
    setSlideSize,
    // animations
    getAnimations,
    getSelectedAnimation,
    selectAnimation,
    addAnimation,
    applyAnimationEffect,
    describeAnimations,
    updateAnimation,
    removeAnimation,
    moveAnimation,
    moveSelectedAnimation,
    startPreview,
    stopPreview: () => stopPreview(),
    isPreviewing,
    // objects
    copy: copySelected,
    cut: cutSelected,
    paste: pasteObjects,
    canPaste,
    duplicate: duplicateSelected,
    deleteSelected,
    arrange,
    setGeometry,
    setFill,
    setStroke,
    setTextStyle,
    setAlign,
    setObjectLink,
    pickImage,
    insertImage,
    // text
    startEdit,
    finishEdit,
    isEditing,
    toggleMark,
    markActive,
    setLink,
    getLinkUrl,
    getLinkInfo,
    createLinkForm,
    canEditText,
    getTextState,
    focus: () => stageArea.focus()
  };
}

/**
 * @typedef {ReturnType<typeof createPresentationEditor>} PresentationEditorHandle
 */
