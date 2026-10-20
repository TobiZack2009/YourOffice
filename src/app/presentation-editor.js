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

import { guard, showNotice, clearNotice } from "./notice.js";
import { createId } from "../core/ids.js";
import {
  fitScale,
  normalizeAngle,
  objectsInMarquee,
  planSlideReorder,
  rectFromPoints,
  resizeRect,
  rotatedBounds,
  rotationFrom,
  round,
  snapMove,
  unionBounds,
  centerOf
} from "../presentation/geometry.js";
import {
  ANIM_MAX_OFFSET,
  MAX_IMAGE_BYTES,
  OBJECT_DEFAULTS,
  SIZE_LIMITS,
  createObject,
  createPresentationContent,
  createTextBody,
  ensurePresentationContent
} from "../presentation/model.js";
import { renderObject, renderSlide } from "../presentation/render.js";
import { createPreview } from "./animation-preview.js";
import { createAnimationTimeline, effectLabel, effectPatch, objectLabel } from "./animation-timeline.js";
import { clear, h } from "./dom.js";
import { icon } from "./icons.js";
import { caretOffset, parseInlineRuns, runsEqual } from "./inline.js";
import { markStateIn, setLinkIn, toggleMarkIn } from "./marks.js";
import { buildLinkForm, linkPages, pageIdOfLink, pageLinkUrl } from "./link-form.js";
import { buildMenu, createPopoverHost } from "./popover.js";
import { createInspector } from "./inspector.js";
import { createSlideStrip } from "./slide-strip.js";
import { findSection, findSectionByLocator, sectionKind, slideLocator } from "../references/sections.js";
import { ensureSection } from "../references/catalog.js";
import { buildBook } from "../sheet/table-engine.js";
import { enginesFor, staticReferenceHooks } from "./reference-render.js";
import { openExpressionEditor } from "./expression-editor.js";
import { openReferencePicker } from "./reference-picker.js";
import {
  promptName,
  referenceCount,
  referenceMenuItems,
  sectionMenuItems,
  showMenu as showAnchoredMenu,
  showReferenceList
} from "./handles.js";

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
 * @property {() => void} [onSelectionChange] Called when selection, tool, view or edit state changes.
 * @property {string | null} [initialSlideId] Slide to open on (falls back to the first).
 * @property {(slideId: string | null) => void} [onSlideChange]
 * @property {View} [view] Mutable view state owned by the caller, so it survives remounts.
 * @property {{ objects: SlideObject[], pastes: number }} [clipboard] Mutable object clipboard, same reason.
 */

export const GRID_SIZE = 10;
export const NUDGE = 1;
export const NUDGE_FAST = 10;
const DRAG_THRESHOLD = 3;
const DEFAULT_IMAGE_BOX = { width: 480, height: 270 };
/** Starting box of a standalone reference object, by what it shows. */
const REFERENCE_BOXES = {
  slide: { width: 480, height: 270 },
  table: { width: 480, height: 200 },
  blocks: { width: 480, height: 120 },
  expression: { width: 320, height: 80 }
};
const ROTATE_STEP = 15;
const STAGE_PADDING = 64;
const MAX_STAGE_SCALE = 3;
const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} tag
 * @param {Record<string, string | number>} attrs
 * @returns {SVGElement}
 */
function svgNode(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return /** @type {SVGElement} */ (el);
}

/** @param {SlideObject} o */
const textCapable = (o) => o.type === "text" || o.type === "shape";
/** @param {SlideObject} o */
const fillCapable = (o) => o.type === "text" || o.type === "shape";
/** @param {SlideObject} o */
const strokeCapable = (o) => o.type !== "image" && o.type !== "reference";

/** @param {Element | EventTarget | null} node */
function closest(node, selector) {
  return node instanceof Element ? node.closest(selector) : null;
}

/**
 * Handles shown on a selected object. Lines only get their two end points.
 * @param {SlideObject} object
 * @returns {{ name: string, left: number, top: number }[]}
 */
function handlePoints(object) {
  const all = [
    { name: "nw", left: 0, top: 0 },
    { name: "n", left: 50, top: 0 },
    { name: "ne", left: 100, top: 0 },
    { name: "e", left: 100, top: 50 },
    { name: "se", left: 100, top: 100 },
    { name: "s", left: 50, top: 100 },
    { name: "sw", left: 0, top: 100 },
    { name: "w", left: 0, top: 50 }
  ];
  if (object.type !== "line") return all;
  const ends = object.flipV ? ["ne", "sw"] : ["nw", "se"];
  return all.filter((p) => ends.includes(p.name));
}

/**
 * Put `node` at the caret inside `host` (or at its end when there is no caret there).
 * @param {HTMLElement} host
 * @param {Node} node
 * @returns {Range | null}
 */
function insertNodeAtCaret(host, node) {
  const doc = host.ownerDocument;
  const selection = doc.getSelection?.();
  let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (!range || !host.contains(range.commonAncestorContainer)) {
    range = doc.createRange();
    range.selectNodeContents(host);
    range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return range;
}

/**
 * @param {HTMLElement} host
 * @param {string} text
 */
function insertTextAtCaret(host, text) {
  const doc = host.ownerDocument;
  if (typeof doc.execCommand === "function") {
    try {
      if (doc.execCommand("insertText", false, text)) return;
    } catch {
      // fall through to the manual path
    }
  }
  insertNodeAtCaret(host, doc.createTextNode(text));
}

/**
 * Enter inside an edited text: a `<br>`, plus a trailing sentinel so a final empty
 * line is visible. Sentinels are stripped before the DOM is parsed back into runs.
 * @param {HTMLElement} host
 */
function insertLineBreak(host) {
  const doc = host.ownerDocument;
  const br = doc.createElement("br");
  insertNodeAtCaret(host, br);
  if (!br.nextSibling) {
    const sentinel = doc.createElement("br");
    sentinel.setAttribute("data-sentinel", "true");
    host.append(sentinel);
  }
}

/**
 * @param {HTMLElement} host
 * @returns {import("../document/model.js").InlineRun[]}
 */
function runsFromHost(host) {
  const copy = /** @type {HTMLElement} */ (host.cloneNode(true));
  for (const sentinel of copy.querySelectorAll("br[data-sentinel]")) sentinel.remove();
  return parseInlineRuns(copy);
}

/**
 * @param {Workspace} workspace
 * @param {string} pageId
 * @param {PresentationEditorOptions} [options]
 */
export function createPresentationEditor(workspace, pageId, options = {}) {
  /** @type {View} */
  const view = options.view ?? { inspector: true, snap: true, grid: false, timeline: false };
  const clipboard = options.clipboard ?? { objects: [], pastes: 0 };

  const popovers = createPopoverHost(document.body);

  const root = h("div", { class: "presentation-editor", tabindex: "-1", "data-role": "presentation-editor" });
  const stageArea = h("div", { class: "stage-area", tabindex: "0", "data-role": "stage-area", "aria-label": "Slide" });
  const imageInput = /** @type {HTMLInputElement} */ (
    h("input", { type: "file", accept: "image/*", class: "visually-hidden", tabindex: "-1", "data-role": "image-file" })
  );

  /** @type {PresentationContent | null} */
  let cached = null;
  /** @type {string | null} */
  let currentSlideId = options.initialSlideId ?? null;
  /** @type {string[]} */
  let selectedIds = [];
  /** @type {Tool | null} */
  let tool = null;
  let destroyed = false;
  let suppressBlur = false;
  /** @type {HTMLElement | null} */
  let stage = null;
  /** @type {HTMLElement | null} */
  let slideEl = null;
  /** @type {HTMLElement | null} */
  let overlay = null;
  let scale = 1;
  /** @type {Map<string, HTMLElement>} */
  const objectEls = new Map();
  /** @type {ResizeObserver | null} */
  let resizeObserver = null;
  /** @type {string | null} */
  let selectedAnimationId = null;
  /** @type {import("./animation-preview.js").PreviewHandle | null} */
  let previewHandle = null;
  /** @type {ReturnType<typeof staticReferenceHooks> | null} */
  let hookCache = null;
  /** True once something on a slide read other pages, so their edits must redraw this one. */
  let drewReferences = false;
  /** Grown heights of `autoHeight` text objects (measured, never stored). @type {Map<string, number>} */
  const autoHeights = new Map();

  /**
   * What the live gesture is showing, drawn into the overlay.
   * @type {{ rects: Map<string, Partial<SlideObject>>, guides: import("../presentation/geometry.js").Guide[], marquee: Rect | null, draw: { tool: Tool, rect: Rect } | null, path: { animationId: string, from: { x: number, y: number }, to: { x: number, y: number } } | null }}
   */
  const preview = { rects: new Map(), guides: [], marquee: null, draw: null, path: null };
  /** @type {any} */
  let gesture = null;

  /**
   * @type {{ id: string, host: HTMLElement, original: import("../document/model.js").InlineRun[], lastRange: Range | null } | null}
   */
  let editing = null;

  // -- model access ------------------------------------------------------------

  function getContent() {
    if (!cached) {
      const page = workspace.getPage(pageId);
      cached = page ? ensurePresentationContent(page) : createPresentationContent();
    }
    return cached;
  }

  const getSize = () => getContent().size;
  const getSlideId = () => currentSlideId;

  /** @returns {Slide | null} */
  function getSlide() {
    const content = getContent();
    return (currentSlideId && content.slides[currentSlideId]) || null;
  }

  /** @returns {SlideObject[]} Selected objects in z-order. */
  function getSelectedObjects() {
    const slide = getSlide();
    if (!slide) return [];
    return slide.objectOrder.filter((id) => selectedIds.includes(id)).map((id) => slide.objects[id]);
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
    return guard(fn, refresh);
  }

  /** @param {string} message */
  function notify(message) {
    showNotice(message);
  }

  // -- references on slides --------------------------------------------------------

  /**
   * Hooks that draw reference objects and inline references read-only. Built lazily, once per
   * model change, so a slide without references never pays for the formula engines.
   */
  function slideHooks() {
    if (!hookCache) {
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
        resolvePageTitle: (/** @type {string} */ id) => workspace.getPage(id)?.title
      };
      const hooks = staticReferenceHooks(/** @type {any} */ (ctx), pageId, 1);
      hookCache = {
        renderReference: (object) => {
          drewReferences = true;
          return hooks.renderReference(object);
        },
        renderInlineRef: (ref) => {
          drewReferences = true;
          return hooks.renderInlineRef(ref);
        }
      };
    }
    return hookCache;
  }

  // -- slide strip + inspector ---------------------------------------------------

  const strip = createSlideStrip({
    getContent,
    getCurrent: () => currentSlideId,
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
      items = sectionMenuItems({ workspace, popovers, anchor: () => anchor, sectionId: found.id, navigate: options.navigate });
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
    listPages: () => workspace.getPages().map((p) => ({ id: p.id, title: p.title, type: p.type })),
    listSlides: () => getContent().slideOrder.map((id, i) => ({ id, number: i + 1 }))
  };
  const inspector = createInspector(inspectorApi);

  const timeline = createAnimationTimeline({
    getSlide,
    getSelectedId: () => selectedAnimationId,
    isPreviewing: () => previewHandle !== null,
    onSelect: (id) => selectAnimation(id),
    onMove: (id, index) => moveAnimation(id, index),
    onUpdate: (id, patch) => updateAnimation(patch, id),
    onDelete: (id) => removeAnimation(id),
    onTogglePreview: () => (previewHandle ? stopPreview() : void startPreview())
  });

  root.append(strip.element, stageArea, timeline.element, inspector.element, imageInput);

  // -- stage rendering ------------------------------------------------------------

  function computeScale() {
    const available = { width: stageArea.clientWidth - STAGE_PADDING, height: stageArea.clientHeight - STAGE_PADDING };
    return Math.min(MAX_STAGE_SCALE, fitScale(available, getSize()));
  }

  function renderStage() {
    clear(stageArea);
    objectEls.clear();
    stage = null;
    slideEl = null;
    overlay = null;
    stageArea.dataset.tool = tool ? tool.type : "";
    stageArea.classList.toggle("is-editing", editing !== null);

    const content = getContent();
    const slide = getSlide();
    if (!slide) {
      const add = h("button", { class: "stage-empty-add", type: "button", "data-action": "add-first-slide", text: "Add a slide" });
      add.addEventListener("click", () => newSlide("title", 0));
      stageArea.append(h("div", { class: "stage-empty" }, [h("p", { text: "This presentation has no slides." }), add]));
      return;
    }

    scale = computeScale();
    const size = content.size;
    stage = h("div", { class: "stage", "data-role": "stage" });
    stage.style.width = `${round(size.width * scale)}px`;
    stage.style.height = `${round(size.height * scale)}px`;
    stage.style.setProperty("--scale", String(scale));
    stage.style.setProperty("--inv-scale", String(1 / scale));
    stage.style.setProperty("--grid", `${GRID_SIZE * scale}px`);
    stage.classList.toggle("show-grid", view.grid);

    slideEl = renderSlide(slide, { size, scale, interactive: true, ...slideHooks() });
    for (const child of Array.from(slideEl.children)) {
      const id = /** @type {HTMLElement} */ (child).dataset.objectId;
      if (id) objectEls.set(id, /** @type {HTMLElement} */ (child));
    }

    measureAutoHeights(slide);

    overlay = h("div", { class: "stage-overlay", "data-role": "overlay" });
    overlay.style.width = `${size.width}px`;
    overlay.style.height = `${size.height}px`;
    overlay.style.transform = `scale(${scale})`;
    overlay.style.transformOrigin = "0 0";

    stage.append(slideEl, overlay);
    stageArea.append(stage);
    renderOverlay();
  }

  /**
   * Grow `autoHeight` text objects to fit what they hold (a block embed in the text can be
   * taller than the box). Only the drawing changes: no command, nothing stored.
   * @param {Slide} slide
   */
  function measureAutoHeights(slide) {
    autoHeights.clear();
    for (const id of slide.objectOrder) {
      const object = slide.objects[id];
      if (!object || object.type !== "text" || !object.autoHeight) continue;
      const el = objectEls.get(id);
      const body = /** @type {HTMLElement | null} */ (el?.querySelector(".slide-text") ?? null);
      if (!el || !body) continue;
      const needed = Math.ceil(body.scrollHeight);
      if (needed > object.height) {
        el.style.height = `${needed}px`;
        autoHeights.set(id, needed);
      }
    }
  }

  /**
   * The handle of a selected reference object: opens its menu.
   * @param {SlideObject} object
   * @returns {HTMLElement}
   */
  function referenceHandle(object) {
    const button = h("button", {
      class: "slide-reference-handle",
      type: "button",
      "data-role": "reference-handle",
      "aria-label": object.kind === "expression" ? "Expression" : "Embedded content",
      title: object.kind === "expression" ? "Expression" : "Embedded content"
    }, [icon(object.kind === "expression" ? "expression" : "link", { size: 14 })]);
    button.style.left = `${object.x + object.width}px`;
    button.style.top = `${object.y}px`;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      showAnchoredMenu(popovers, button, referenceItems(object, () => button));
    });
    return button;
  }

  /**
   * @param {SlideObject} object
   * @param {() => HTMLElement} anchor
   */
  function referenceItems(object, anchor) {
    return referenceMenuItems({
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor,
      hostId: pageId,
      record: object,
      navigate: options.navigate,
      editExpression: () => editExpression(object, anchor()),
      replaceSource: () => replaceSource(object, anchor())
    });
  }

  /** @param {SlideObject} object @param {HTMLElement} anchor */
  function editExpression(object, anchor) {
    openExpressionEditor({
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor,
      pageId,
      initial: object.expression ?? "",
      confirm: "Apply",
      onSubmit: (text) => run(() => send("setExpression", { instanceId: object.id, expression: text }))
    });
  }

  /** Swap which section a reference object shows. @param {SlideObject} object @param {HTMLElement} anchor */
  function replaceSource(object, anchor) {
    openReferencePicker({
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor,
      pageId,
      onPick: (item, name) =>
        run(() =>
          workspace.transact("change reference", () => {
            const sectionId = ensureSection(/** @type {any} */ (workspace), item, name);
            send("updateReference", { instanceId: object.id, patch: { sectionId } });
          })
        )
    });
  }

  /**
   * Where a new reference goes: into the text being edited at the caret, or as its own object.
   * Committing the edit first keeps the caret offset in step with the stored text.
   * @returns {{ inline: { slideId: string, objectId: string, offset: number } } | null}
   */
  function inlinePlacement() {
    if (!editing || !currentSlideId) return null;
    const { id, host } = editing;
    const blank = runsFromHost(host).every((r) => !r.ref && r.text.trim() === "");
    if (blank) return null;
    const offset = caretOffset(host);
    finishEdit(true);
    return { inline: { slideId: currentSlideId, objectId: id, offset } };
  }

  /**
   * Place a reference: inline when text is being edited, else a standalone object, centred.
   * @param {Record<string, unknown>} fields `kind` plus `sectionId` or `expression`.
   * @param {ReturnType<typeof inlinePlacement>} inlineAt
   * @param {{ width: number, height: number }} box
   */
  function placeReference(fields, inlineAt, box) {
    if (!currentSlideId) return;
    if (inlineAt) {
      const { objectId } = inlineAt.inline;
      workspace.transact("insert reference", () => {
        send("insertReference", { slideId: currentSlideId, display: {}, ...fields, ...inlineAt });
        if (getSlide()?.objects[objectId]?.type === "text") {
          send("updateObject", { slideId: currentSlideId, objectId, patch: { autoHeight: true } });
        }
      });
      return;
    }
    const size = getSize();
    const width = Math.min(box.width, size.width);
    const height = Math.min(box.height, size.height);
    const instanceId = createId("obj");
    selectedIds = [instanceId];
    tool = null;
    send("insertReference", {
      slideId: currentSlideId,
      display: {},
      ...fields,
      instanceId,
      x: Math.round((size.width - width) / 2),
      y: Math.round((size.height - height) / 2),
      width,
      height
    });
  }

  /**
   * Open the source picker and embed what is chosen.
   * @param {HTMLElement} [anchor]
   */
  function insertEmbed(anchor) {
    if (!currentSlideId) return;
    const inlineAt = inlinePlacement();
    openReferencePicker({
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor: anchor ?? stageArea,
      pageId,
      onPick: (item, name) =>
        run(() =>
          workspace.transact("insert reference", () => {
            const sectionId = ensureSection(/** @type {any} */ (workspace), item, name);
            const kind = sectionKind(findSection(workspace.data, sectionId));
            placeReference({ kind: "embed", sectionId }, inlineAt, REFERENCE_BOXES[kind] ?? REFERENCE_BOXES.blocks);
          })
        )
    });
  }

  /**
   * Open the expression editor and place its result.
   * @param {HTMLElement} [anchor]
   */
  function insertExpression(anchor) {
    if (!currentSlideId) return;
    const inlineAt = inlinePlacement();
    openExpressionEditor({
      workspace: /** @type {any} */ (workspace),
      popovers,
      anchor: anchor ?? stageArea,
      pageId,
      initial: "",
      confirm: "Insert",
      onSubmit: (text) => run(() => placeReference({ kind: "expression", expression: text }, inlineAt, REFERENCE_BOXES.expression))
    });
  }

  /**
   * @param {Partial<SlideObject> & Rect} box
   * @param {{ handles: boolean, id?: string }} spec
   */
  function selectionBox(box, spec) {
    const el = h("div", { class: "selection-box", "data-object-id": spec.id });
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    if (box.rotation) el.style.transform = `rotate(${box.rotation}deg)`;
    if (spec.handles) {
      for (const point of handlePoints(/** @type {SlideObject} */ (box))) {
        const handle = h("div", { class: "handle", "data-handle": point.name });
        handle.style.left = `${point.left}%`;
        handle.style.top = `${point.top}%`;
        el.append(handle);
      }
      el.append(h("div", { class: "rotate-stem" }), h("div", { class: "handle handle-rotate", "data-handle": "rotate" }));
    }
    return el;
  }

  /**
   * Numbered tags on animated objects, and the path of each motion animation.
   * @param {Slide} slide
   */
  function renderAnimationOverlay(slide) {
    if (!overlay || !view.timeline || previewHandle) return;
    const size = getSize();
    const selectedAnim = selectedAnimationId ? slide.animations[selectedAnimationId] : null;
    const selectedObject = selectedAnim ? slide.objects[selectedAnim.objectId] : null;
    if (selectedObject) {
      const bounds = rotatedBounds(selectedObject);
      const box = h("div", { class: "animation-target", "data-role": "animation-target" });
      box.style.left = `${bounds.x}px`;
      box.style.top = `${bounds.y}px`;
      box.style.width = `${bounds.width}px`;
      box.style.height = `${bounds.height}px`;
      overlay.append(box);
    }

    const paths = svgNode("svg", { class: "motion-paths", width: size.width, height: size.height });
    const handles = [];
    /** @type {Map<string, number>} */
    const perObject = new Map();
    slide.animationOrder.forEach((id, index) => {
      const animation = slide.animations[id];
      const object = animation && slide.objects[animation.objectId];
      if (!animation || !object) return;

      const slot = perObject.get(object.id) ?? 0;
      perObject.set(object.id, slot + 1);
      const bounds = rotatedBounds(object);
      const tag = h("div", {
        class: `animation-tag${id === selectedAnimationId ? " is-selected" : ""}`,
        "data-animation-id": id,
        text: String(index + 1)
      });
      tag.style.left = `${bounds.x + slot * 24 * (1 / scale)}px`;
      tag.style.top = `${bounds.y}px`;
      overlay?.append(tag);

      if (animation.effect !== "motion" || !animation.path) return;
      const path = preview.path?.animationId === id ? preview.path : animation.path;
      const centre = centerOf(object);
      const from = { x: centre.x + path.from.x, y: centre.y + path.from.y };
      const to = { x: centre.x + path.to.x, y: centre.y + path.to.y };
      const isSelected = id === selectedAnimationId;
      paths.append(svgNode("line", {
        class: `motion-line${isSelected ? " is-selected" : ""}`,
        "data-animation-id": id,
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y
      }));
      if (isSelected) {
        for (const [which, point] of /** @type {const} */ ([["from", from], ["to", to]])) {
          const handle = h("div", { class: `path-handle path-handle-${which}`, "data-path-handle": which, "data-animation-id": id });
          handle.style.left = `${point.x}px`;
          handle.style.top = `${point.y}px`;
          handles.push(handle);
        }
      }
    });
    overlay.prepend(paths);
    overlay.append(...handles);
  }

  function renderOverlay() {
    if (!overlay) return;
    clear(overlay);
    const slide = getSlide();
    if (!slide || previewHandle) return;

    const objects = getSelectedObjects().map(
      (o) => /** @type {SlideObject} */ ({ ...o, ...(autoHeights.has(o.id) ? { height: autoHeights.get(o.id) } : {}), ...(preview.rects.get(o.id) ?? {}) })
    );
    const single = objects.length === 1;
    for (const object of objects) {
      overlay.append(selectionBox(object, { handles: single && !editing && !gesture?.hideHandles, id: object.id }));
    }
    if (single && !editing && !gesture && objects[0].type === "reference") overlay.append(referenceHandle(objects[0]));
    if (objects.length > 1 && !gesture) {
      const bounds = unionBounds(objects.map(rotatedBounds));
      const group = selectionBox({ ...bounds }, { handles: false });
      group.classList.add("selection-group");
      overlay.append(group);
    }

    for (const guide of preview.guides) {
      const line = h("div", { class: "snap-guide", "data-axis": guide.axis });
      if (guide.axis === "x") {
        line.style.left = `${guide.position}px`;
        line.style.top = `${guide.start}px`;
        line.style.height = `${guide.end - guide.start}px`;
      } else {
        line.style.top = `${guide.position}px`;
        line.style.left = `${guide.start}px`;
        line.style.width = `${guide.end - guide.start}px`;
      }
      overlay.append(line);
    }

    const rectBox = (/** @type {Rect} */ rect, /** @type {string} */ className) => {
      const el = h("div", { class: className });
      el.style.left = `${rect.x}px`;
      el.style.top = `${rect.y}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      return el;
    };
    if (preview.marquee) overlay.append(rectBox(preview.marquee, "marquee"));
    if (preview.draw) overlay.append(rectBox(preview.draw.rect, "draw-preview"));
    renderAnimationOverlay(slide);
  }

  function clearPreview() {
    preview.rects.clear();
    preview.guides = [];
    preview.marquee = null;
    preview.draw = null;
    preview.path = null;
  }

  /**
   * Show an object at a tentative geometry without touching the model.
   * @param {string} id
   * @param {Partial<SlideObject>} patch
   */
  function previewObject(id, patch) {
    const slide = getSlide();
    const base = slide?.objects[id];
    if (!base) return;
    preview.rects.set(id, patch);
    const fresh = renderObject({ ...base, ...patch }, { interactive: true, ...slideHooks() });
    objectEls.get(id)?.replaceWith(fresh);
    objectEls.set(id, fresh);
  }

  /** Everything derived from the model: strip, stage, inspector. */
  function refresh() {
    if (destroyed) return;
    stopPreview({ quiet: true });
    cached = null;
    hookCache = null;
    drewReferences = false;
    const content = getContent();
    if (!currentSlideId || !content.slides[currentSlideId]) {
      const next = content.slideOrder[0] ?? null;
      if (next !== currentSlideId) {
        currentSlideId = next;
        options.onSlideChange?.(next);
      }
      selectedIds = [];
    }
    const slide = getSlide();
    selectedIds = selectedIds.filter((id) => slide?.objects[id]);
    if (selectedAnimationId && !slide?.animations?.[selectedAnimationId]) selectedAnimationId = null;
    editing = null;
    gesture = null;
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
    stageArea.dataset.tool = tool ? tool.type : "";
    stageArea.classList.toggle("is-editing", editing !== null);
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
    selectedIds = slide ? slide.objectOrder.filter((id) => ids.includes(id)) : [];
    afterStateChange();
  }

  function selectAll() {
    const slide = getSlide();
    if (slide) selectObjects([...slide.objectOrder]);
  }

  /** @param {string | null} slideId */
  function setCurrent(slideId) {
    stopPreview({ quiet: true });
    currentSlideId = slideId;
    selectedIds = [];
    selectedAnimationId = null;
    options.onSlideChange?.(slideId);
  }

  /** @param {string} slideId */
  function selectSlide(slideId) {
    if (slideId === currentSlideId || !getContent().slides[slideId]) return;
    finishEdit(true);
    setCurrent(slideId);
    refresh();
  }

  // -- slides --------------------------------------------------------------------------

  /**
   * @param {string} [layout]
   * @param {number} [index]
   */
  function newSlide(layout, index) {
    finishEdit(true);
    const order = getContent().slideOrder;
    const at = index ?? (currentSlideId ? order.indexOf(currentSlideId) + 1 : order.length);
    const slideId = createId("slide");
    setCurrent(slideId);
    run(() => send("createSlide", { slideId, index: at, ...(layout ? { layout } : {}) }));
  }

  /** @param {string | null} [slideId] */
  function duplicateSlide(slideId = currentSlideId) {
    if (!slideId) return;
    finishEdit(true);
    const newSlideId = createId("slide");
    setCurrent(newSlideId);
    run(() => send("duplicateSlide", { slideId, newSlideId }));
  }

  const canDeleteSlide = () => getContent().slideOrder.length > 1;

  /** @param {string | null} [slideId] */
  function deleteSlide(slideId = currentSlideId) {
    if (!slideId || !canDeleteSlide()) return;
    finishEdit(true);
    const order = getContent().slideOrder;
    const at = order.indexOf(slideId);
    if (slideId === currentSlideId) {
      const neighbour = order[at + 1] ?? order[at - 1] ?? null;
      setCurrent(neighbour);
    }
    run(() => send("deleteSlide", { slideId }));
  }

  /** @param {string[]} slideIds Delete several slides as one change. */
  function deleteSlides(slideIds) {
    const order = getContent().slideOrder;
    const ids = slideIds.filter((id) => order.includes(id));
    if (ids.length === 0 || ids.length >= order.length) return;
    finishEdit(true);
    if (currentSlideId && ids.includes(currentSlideId)) {
      const at = order.indexOf(currentSlideId);
      const rest = order.filter((id) => !ids.includes(id));
      const after = order.slice(at + 1).find((id) => rest.includes(id));
      const before = order.slice(0, at).reverse().find((id) => rest.includes(id));
      setCurrent(after ?? before ?? null);
    }
    run(() => send("deleteSlide", { slideIds: ids }));
  }

  /**
   * @param {string} slideId
   * @param {number} index Position once the slide is lifted out of the order.
   */
  function moveSlide(slideId, index) {
    finishEdit(true);
    const order = getContent().slideOrder;
    const clamped = Math.max(0, Math.min(order.length - 1, index));
    run(() => send("moveSlide", { slideId, index: clamped }));
  }

  /** @param {number} delta Move the current slide up (-1) or down (1). */
  function moveCurrentSlide(delta) {
    if (!currentSlideId) return;
    const at = getContent().slideOrder.indexOf(currentSlideId);
    moveSlide(currentSlideId, at + delta);
  }

  // -- slide settings -----------------------------------------------------------------

  /** @param {string} color */
  function setBackground(color) {
    if (!currentSlideId) return;
    run(() => send("setSlideBackground", { slideId: currentSlideId, color }));
  }

  /** @param {Record<string, unknown>} patch */
  function setTransition(patch) {
    if (!currentSlideId) return;
    run(() => send("setSlideTransition", { slideId: currentSlideId, transition: patch }));
  }

  function applyTransitionToAll() {
    if (!currentSlideId) return;
    run(() => send("applyTransitionToAll", { slideId: currentSlideId }));
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {boolean} scaleContent
   */
  function setSlideSize(width, height, scaleContent) {
    run(() => send("setSlideSize", { width, height, scaleContent }));
  }

  /**
   * Ask whether to scale the content, then change the presentation's slide size.
   * @param {number} width
   * @param {number} height
   */
  function requestSlideSize(width, height) {
    const ok = (/** @type {number} */ n) => Number.isInteger(n) && n >= SIZE_LIMITS.min && n <= SIZE_LIMITS.max;
    if (!ok(width) || !ok(height)) {
      notify(`Slide size must be whole numbers from ${SIZE_LIMITS.min} to ${SIZE_LIMITS.max}`);
      inspector.render();
      return;
    }
    const current = getSize();
    if (current.width === width && current.height === height) return;
    finishEdit(true);

    const choose = (/** @type {boolean} */ scaleContent) => () => {
      popovers.close();
      setSlideSize(width, height, scaleContent);
    };
    const scaleButton = h("button", { class: "popover-button is-primary", type: "button", "data-action": "size-scale", text: "Scale content" });
    const keepButton = h("button", { class: "popover-button", type: "button", "data-action": "size-keep", text: "Keep as is" });
    scaleButton.addEventListener("click", choose(true));
    keepButton.addEventListener("click", choose(false));
    const rect = stageArea.getBoundingClientRect();
    popovers.showAt(
      { x: rect.left + rect.width / 2 - 120, y: rect.top + 48 },
      h("div", { class: "size-popover" }, [
        h("p", { class: "size-popover-text", text: `Resize slides to ${width} × ${height}?` }),
        h("div", { class: "size-popover-buttons" }, [scaleButton, keepButton])
      ]),
      { class: "popover-dialog" }
    );
  }

  // -- object commands ------------------------------------------------------------------

  /**
   * @param {{ objectId: string, patch: Record<string, unknown> }[]} items
   */
  function patchObjects(items) {
    if (!currentSlideId || items.length === 0) return;
    finishEdit(true);
    if (items.length === 1) {
      const [item] = items;
      run(() => send("updateObject", { slideId: currentSlideId, ...item }));
    } else {
      run(() => send("updateObjects", { slideId: currentSlideId, items }));
    }
  }

  /** @param {Record<string, number>} patch x/y/width/height/rotation */
  function setGeometry(patch) {
    const objects = getSelectedObjects();
    if (objects.length === 0) return;
    if (objects.length === 1) {
      /** @type {Record<string, number>} */
      const clean = {};
      for (const key of ["x", "y", "width", "height", "rotation"]) {
        if (typeof patch[key] === "number" && Number.isFinite(patch[key])) clean[key] = round(patch[key]);
      }
      if (Object.keys(clean).length > 0) patchObjects([{ objectId: objects[0].id, patch: clean }]);
      return;
    }
    // Several objects move together; the union's top-left is what X/Y mean.
    const bounds = getSelectionBounds();
    if (!bounds) return;
    const dx = typeof patch.x === "number" ? patch.x - bounds.x : 0;
    const dy = typeof patch.y === "number" ? patch.y - bounds.y : 0;
    if (dx === 0 && dy === 0) return;
    patchObjects(objects.map((o) => ({ objectId: o.id, patch: { x: round(o.x + dx), y: round(o.y + dy) } })));
  }

  /** @param {string | null} color */
  function setFill(color) {
    patchObjects(getSelectedObjects().filter(fillCapable).map((o) => ({ objectId: o.id, patch: { fill: color } })));
  }

  /** @param {{ color?: string, width?: number } | null} spec */
  function setStroke(spec) {
    patchObjects(
      getSelectedObjects().filter(strokeCapable).map((o) => {
        if (spec === null) return { objectId: o.id, patch: { stroke: null } };
        const base = o.stroke ?? (o.type === "line" ? OBJECT_DEFAULTS.lineStroke : OBJECT_DEFAULTS.stroke);
        return { objectId: o.id, patch: { stroke: { ...base, ...spec } } };
      })
    );
  }

  /** @param {Record<string, unknown>} style fontSize / color / align / valign */
  function setTextStyle(style) {
    patchObjects(getSelectedObjects().filter(textCapable).map((o) => ({ objectId: o.id, patch: { text: style } })));
  }

  /** @param {"left" | "center" | "right"} align */
  function setAlign(align) {
    setTextStyle({ align });
  }

  /** @param {import("../presentation/model.js").ObjectLink | null} link */
  function setObjectLink(link) {
    patchObjects(getSelectedObjects().map((o) => ({ objectId: o.id, patch: { link } })));
  }

  /** @param {"front" | "forward" | "backward" | "back"} op */
  function arrange(op) {
    if (!currentSlideId || selectedIds.length === 0) return;
    finishEdit(true);
    run(() => send("reorderObjects", { slideId: currentSlideId, objectIds: [...selectedIds], op }));
  }

  function deleteSelected() {
    if (!currentSlideId || selectedIds.length === 0) return;
    finishEdit(false);
    const ids = [...selectedIds];
    selectedIds = [];
    run(() => send("deleteObjects", { slideId: currentSlideId, objectIds: ids }));
  }

  function duplicateSelected() {
    if (!currentSlideId || selectedIds.length === 0) return;
    finishEdit(true);
    const ordered = getSelectedObjects();
    const newIds = ordered.map(() => createId("obj"));
    selectedIds = [...newIds];
    run(() => send("duplicateObjects", { slideId: currentSlideId, objectIds: ordered.map((o) => o.id), newIds }));
  }

  function copySelected() {
    const objects = getSelectedObjects();
    if (objects.length === 0) return false;
    clipboard.objects = structuredClone(objects);
    clipboard.pastes = 0;
    options.onSelectionChange?.();
    return true;
  }

  function cutSelected() {
    if (copySelected()) deleteSelected();
  }

  const canPaste = () => clipboard.objects.length > 0;

  function pasteObjects() {
    if (!currentSlideId || !canPaste()) return;
    finishEdit(true);
    clipboard.pastes += 1;
    const newIds = clipboard.objects.map(() => createId("obj"));
    selectedIds = [...newIds];
    run(() => send("pasteObjects", {
      slideId: currentSlideId,
      objects: structuredClone(clipboard.objects),
      newIds,
      offset: 24 * clipboard.pastes
    }));
  }

  // -- animations ----------------------------------------------------------------------------------

  /** @returns {Animation[]} The current slide's animations in playback order. */
  function getAnimations() {
    const slide = getSlide();
    if (!slide) return [];
    return slide.animationOrder.map((id) => slide.animations[id]).filter(Boolean);
  }

  /** @returns {Animation | null} */
  function getSelectedAnimation() {
    return (selectedAnimationId && getSlide()?.animations?.[selectedAnimationId]) || null;
  }

  /** Selection key the animation was last synced to, so only a real change re-syncs. */
  let syncedSelection = "";

  /**
   * When the selected objects change, the animation being edited follows them: it stays if
   * it belongs to one of them, else the first animation of a selected object is picked, else
   * none. Emptying the selection leaves the animation alone (the timeline keeps editing it).
   */
  function syncAnimationToSelection() {
    const key = selectedIds.join(",");
    if (key === syncedSelection) return;
    syncedSelection = key;
    const slide = getSlide();
    if (!slide || selectedIds.length === 0) return;
    const current = selectedAnimationId ? slide.animations[selectedAnimationId] : null;
    if (current && selectedIds.includes(current.objectId)) return;
    const next = slide.animationOrder.find((id) => selectedIds.includes(slide.animations[id]?.objectId)) ?? null;
    if (next === selectedAnimationId) return;
    selectedAnimationId = next;
    timeline.select();
  }

  /** @param {string | null} id */
  function selectAnimation(id) {
    const next = id && getSlide()?.animations?.[id] ? id : null;
    if (next === selectedAnimationId) return;
    selectedAnimationId = next;
    timeline.select();
    renderOverlay();
    options.onSelectionChange?.();
  }

  /**
   * Animate the selected objects (one animation each). The first starts on click, the
   * rest start with it, so a multi-selection plays together.
   * @param {Animation["effect"]} effect
   * @param {{ direction?: Animation["direction"], trigger?: Animation["trigger"] }} [opts]
   * @returns {boolean}
   */
  function addAnimation(effect, opts = {}) {
    const slideId = currentSlideId;
    const objects = getSelectedObjects();
    if (!slideId || objects.length === 0) return false;
    stopPreview({ quiet: true });
    finishEdit(true);
    const ids = objects.map(() => createId("anim"));
    selectedAnimationId = ids[ids.length - 1];
    return run(() => {
      workspace.transact("add animation", () => {
        objects.forEach((object, i) => {
          send("addAnimation", {
            slideId,
            animation: {
              id: ids[i],
              objectId: object.id,
              effect,
              trigger: opts.trigger ?? (i === 0 ? "click" : "with"),
              ...(opts.direction ? { direction: opts.direction } : {})
            }
          });
        });
      });
    });
  }

  /**
   * The Animations ribbon's effect gallery. With an animation selected (and its object among
   * the selected objects, or nothing selected) the effect of that animation is replaced;
   * otherwise each selected object gets a new animation. Add animation always adds.
   * @param {Animation["effect"]} effect
   * @param {{ direction?: Animation["direction"] }} [opts]
   * @returns {boolean}
   */
  function applyAnimationEffect(effect, opts = {}) {
    const current = getSelectedAnimation();
    const objects = getSelectedObjects();
    if (!current || !(objects.length === 0 || objects.some((object) => object.id === current.objectId))) {
      return addAnimation(effect, opts);
    }
    const sameDirection = !opts.direction || opts.direction === current.direction;
    if (current.effect === effect && sameDirection) return true;
    return updateAnimation({
      ...(current.effect === effect ? {} : effectPatch(current, effect)),
      ...(effect === "slide-in" && opts.direction ? { direction: opts.direction } : {})
    });
  }

  /**
   * The slide's animations in playback order, for pickers.
   * @returns {{ id: string, number: number, label: string, selected: boolean }[]}
   */
  function describeAnimations() {
    const slide = getSlide();
    return getAnimations().map((animation, index) => ({
      id: animation.id,
      number: index + 1,
      label: `${effectLabel(animation)} · ${objectLabel(slide?.objects[animation.objectId])}`,
      selected: animation.id === selectedAnimationId
    }));
  }

  /**
   * Change fields of an animation (the selected one by default).
   * @param {Record<string, unknown>} patch
   * @param {string | null} [id]
   * @returns {boolean}
   */
  function updateAnimation(patch, id = selectedAnimationId) {
    if (!currentSlideId || !id) return false;
    stopPreview({ quiet: true });
    return run(() => send("updateAnimation", { slideId: currentSlideId, animationId: id, patch }));
  }

  /**
   * Remove an animation (the selected one by default); the next row takes the selection.
   * @param {string | null} [id]
   * @returns {boolean}
   */
  function removeAnimation(id = selectedAnimationId) {
    const slide = getSlide();
    if (!currentSlideId || !slide || !id || !slide.animations[id]) return false;
    stopPreview({ quiet: true });
    if (id === selectedAnimationId) {
      const rest = slide.animationOrder.filter((other) => other !== id);
      const at = slide.animationOrder.indexOf(id);
      selectedAnimationId = rest[Math.min(at, rest.length - 1)] ?? null;
    }
    return run(() => send("deleteAnimation", { slideId: currentSlideId, animationId: id }));
  }

  /**
   * @param {string} id
   * @param {number} index Position once the animation is lifted out of the order.
   * @returns {boolean}
   */
  function moveAnimation(id, index) {
    const slide = getSlide();
    if (!currentSlideId || !slide || !slide.animations[id]) return false;
    stopPreview({ quiet: true });
    const clamped = Math.max(0, Math.min(slide.animationOrder.length - 1, index));
    return run(() => send("moveAnimation", { slideId: currentSlideId, animationId: id, index: clamped }));
  }

  /**
   * Move the selected animation earlier (-1) or later (1).
   * @param {number} delta
   * @returns {boolean}
   */
  function moveSelectedAnimation(delta) {
    const slide = getSlide();
    if (!slide || !selectedAnimationId) return false;
    return moveAnimation(selectedAnimationId, slide.animationOrder.indexOf(selectedAnimationId) + delta);
  }

  const isPreviewing = () => previewHandle !== null;

  /**
   * Play the current slide's animations on the stage.
   * @returns {boolean} false when there is nothing to play
   */
  function startPreview() {
    const slide = getSlide();
    if (!slide || slide.animationOrder.length === 0) return false;
    stopPreview({ quiet: true });
    finishEdit(true);
    if (!slideEl) return false;
    popovers.close();
    const handle = createPreview({
      slideEl,
      slide,
      size: getSize(),
      onDone: () => {
        if (previewHandle === handle) stopPreview();
      }
    });
    previewHandle = handle;
    root.classList.add("is-previewing");
    renderOverlay();
    timeline.render();
    options.onSelectionChange?.();
    handle.start();
    return true;
  }

  /** @param {{ quiet?: boolean }} [opts] quiet: the caller re-renders everything anyway. */
  function stopPreview(opts = {}) {
    const handle = previewHandle;
    if (!handle) return;
    previewHandle = null;
    handle.stop();
    root.classList.remove("is-previewing");
    if (opts.quiet) return;
    renderOverlay();
    timeline.render();
    options.onSelectionChange?.();
  }

  // -- tools + insert -----------------------------------------------------------------------

  /** @param {Tool | null} next */
  function setTool(next) {
    if (next && !currentSlideId) return;
    finishEdit(true);
    tool = next;
    afterStateChange();
  }

  const getTool = () => tool;

  /**
   * Insert a finished object, select it and drop the tool.
   * @param {SlideObject} object
   * @param {{ edit?: boolean }} [opts]
   */
  function insertObject(object, opts = {}) {
    if (!currentSlideId) return;
    finishEdit(true);
    selectedIds = [object.id];
    tool = null;
    const ok = run(() => send("insertObject", { slideId: currentSlideId, object }));
    if (ok && opts.edit) startEdit(object.id);
  }

  /**
   * @param {Tool} drawTool
   * @param {Rect} rect
   * @param {boolean} flipV
   */
  function createFromTool(drawTool, rect, flipV) {
    const size = getSize();
    /** @type {SlideObject} */
    let object;
    if (drawTool.type === "line") {
      object = createObject("line", { x: rect.x, y: rect.y, width: rect.width, height: rect.height, flipV });
    } else if (drawTool.type === "text") {
      object = createObject("text", { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    } else {
      object = createObject("shape", { x: rect.x, y: rect.y, width: rect.width, height: rect.height, shape: /** @type {any} */ (drawTool.shape) });
    }
    object.x = Math.max(0, Math.min(size.width - 1, object.x));
    object.y = Math.max(0, Math.min(size.height - 1, object.y));
    insertObject(object, { edit: drawTool.type === "text" });
  }

  /** The default box for a click (no drag), centred on the click and kept on the slide. */
  function defaultBox(/** @type {Tool} */ drawTool, /** @type {{ x: number, y: number }} */ at) {
    const size = getSize();
    const base = createObject(drawTool.type === "line" ? "line" : drawTool.type === "text" ? "text" : "shape");
    const width = base.width;
    const height = base.height;
    return {
      x: round(Math.max(0, Math.min(size.width - width, at.x - width / 2)), 0),
      y: round(Math.max(0, Math.min(size.height - height, at.y - height / 2)), 0),
      width,
      height
    };
  }

  /**
   * Add an image from a data URL, fitted inside the slide and centred.
   * @param {string} dataUrl
   * @param {{ width?: number, height?: number }} [natural]
   */
  function insertImage(dataUrl, natural = {}) {
    if (!currentSlideId) return;
    const size = getSize();
    const nw = natural.width && natural.width > 0 ? natural.width : DEFAULT_IMAGE_BOX.width;
    const nh = natural.height && natural.height > 0 ? natural.height : DEFAULT_IMAGE_BOX.height;
    const fit = Math.min(1, (size.width * 0.6) / nw, (size.height * 0.6) / nh);
    const width = Math.max(8, Math.round(nw * fit));
    const height = Math.max(8, Math.round(nh * fit));
    insertObject(createObject("image", {
      src: dataUrl,
      width,
      height,
      x: Math.round((size.width - width) / 2),
      y: Math.round((size.height - height) / 2)
    }));
  }

  function pickImage() {
    if (!currentSlideId) return;
    imageInput.value = "";
    imageInput.click();
  }

  imageInput.addEventListener("change", () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      notify("That file is not an image");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      notify(`Images can be at most ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      const img = new Image();
      img.onload = () => insertImage(url, { width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => notify("Could not read that image");
      img.src = url;
    };
    reader.onerror = () => notify("Could not read that image");
    reader.readAsDataURL(file);
  });

  // -- in-place text -------------------------------------------------------------------------

  /** @returns {string | null} Id of the single selected object that can carry text. */
  function editableId() {
    const objects = getSelectedObjects();
    return objects.length === 1 && textCapable(objects[0]) ? objects[0].id : null;
  }

  const isEditing = () => editing !== null;

  /**
   * @param {string | null} [id]
   * @returns {boolean}
   */
  function startEdit(id = editableId()) {
    if (editing) return true;
    const slide = getSlide();
    const object = id ? slide?.objects[id] : null;
    if (!object || !textCapable(object)) return false;
    popovers.close();
    if (!(selectedIds.length === 1 && selectedIds[0] === object.id)) selectedIds = [object.id];
    tool = null;

    const shown = { ...object, text: object.text ?? createTextBody({ align: "center", valign: "middle" }) };
    const fresh = renderObject(shown, { interactive: true, ...slideHooks() });
    objectEls.get(object.id)?.replaceWith(fresh);
    objectEls.set(object.id, fresh);
    const host = /** @type {HTMLElement} */ (fresh.querySelector(".slide-text"));
    host.setAttribute("contenteditable", "true");
    host.setAttribute("tabindex", "-1");
    host.setAttribute("spellcheck", "false");
    host.dataset.editing = "true";
    editing = { id: object.id, host, original: structuredClone(object.text?.runs ?? []), lastRange: null };

    host.addEventListener("keydown", (event) => onHostKeydown(/** @type {KeyboardEvent} */ (event)));
    host.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = /** @type {ClipboardEvent} */ (event).clipboardData?.getData("text/plain") ?? "";
      if (text) insertTextAtCaret(host, text);
    });
    host.addEventListener("blur", (event) => {
      if (!editing || editing.host !== host || suppressBlur) return;
      const next = /** @type {FocusEvent} */ (event).relatedTarget;
      if (closest(next, ".popover")) return;
      finishEdit(true);
    });

    host.focus();
    const selection = document.getSelection?.();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(host);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    afterStateChange();
    return true;
  }

  /** @param {KeyboardEvent} event */
  function onHostKeydown(event) {
    if (!editing) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const host = editing.host;
    // Typing belongs to the text: keep it away from stage shortcuts and the shell's workspace undo.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      finishEdit(false, { refocus: true });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (mod) finishEdit(true, { refocus: true });
      else insertLineBreak(host);
    } else if (event.key === "Tab") {
      event.preventDefault();
    } else if (mod && (key === "b" || key === "i" || key === "u")) {
      event.preventDefault();
      toggleMark(/** @type {Mark} */ ({ b: "bold", i: "italic", u: "underline" }[key]));
    }
  }

  // Remember the last caret/selection inside the edited text, so a ribbon popover that takes focus
  // (the link field) can still act on what was selected.
  document.addEventListener("selectionchange", onSelectionChange);
  function onSelectionChange() {
    if (!editing) return;
    const selection = document.getSelection?.();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editing.host.contains(range.commonAncestorContainer)) editing.lastRange = range.cloneRange();
  }

  /**
   * Leave in-place editing.
   * @param {boolean} commit Save the text through `setObjectRuns` when it changed.
   * @param {{ refocus?: boolean }} [opts]
   * @returns {boolean} true when a command was dispatched
   */
  function finishEdit(commit, opts = {}) {
    if (!editing) return false;
    const { id, host, original } = editing;
    editing = null;
    let dispatched = false;
    if (commit && currentSlideId) {
      const runs = runsFromHost(host);
      if (!runsEqual(runs, original)) {
        dispatched = run(() => send("setObjectRuns", { slideId: currentSlideId, objectId: id, runs }));
      }
    }
    if (!dispatched) {
      renderStage();
      afterStateChange();
    }
    if (opts.refocus) stageArea.focus();
    return dispatched;
  }

  /** @param {Mark} mark */
  function toggleMark(mark) {
    if (editing) {
      restoreRange();
      toggleMarkIn(editing.host, mark);
      return;
    }
    const targets = getSelectedObjects().filter((o) => textCapable(o) && o.text && o.text.runs.length > 0);
    if (targets.length === 0 || !currentSlideId) return;
    const allOn = targets.every((o) => (o.text?.runs ?? []).every((r) => r.marks?.[mark]));
    workspace.transact(`toggle ${mark}`, () => {
      for (const object of targets) {
        const runs = (object.text?.runs ?? []).map((r) => {
          const marks = { ...(r.marks ?? {}) };
          if (allOn) delete marks[mark];
          else marks[mark] = true;
          return Object.keys(marks).length > 0 ? { text: r.text, marks } : { text: r.text };
        });
        send("setObjectRuns", { slideId: currentSlideId, objectId: object.id, runs });
      }
    });
  }

  /** @param {Mark} mark */
  function markActive(mark) {
    if (editing) return markStateIn(editing.host, mark);
    const targets = getSelectedObjects().filter((o) => textCapable(o) && o.text && o.text.runs.length > 0);
    return targets.length > 0 && targets.every((o) => (o.text?.runs ?? []).every((r) => r.marks?.[mark]));
  }

  function restoreRange() {
    if (!editing?.lastRange) return;
    const selection = document.getSelection?.();
    if (!selection) return;
    const current = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (current && editing.host.contains(current.commonAncestorContainer)) return;
    selection.removeAllRanges();
    selection.addRange(editing.lastRange);
  }

  /**
   * While editing: link the selected text. Otherwise: link the whole object.
   * An empty url removes the link.
   * @param {string} url
   * @returns {boolean}
   */
  function setLink(url) {
    if (editing) {
      restoreRange();
      return setLinkIn(editing.host, url);
    }
    if (getSelectedObjects().length === 0) return false;
    const pageId = pageIdOfLink(url);
    setObjectLink(!url ? null : pageId ? { kind: "page", pageId } : { kind: "url", url });
    return true;
  }

  /** The link under the caret/selection (editing) or on the selected object. */
  function getLinkUrl() {
    if (editing) {
      const range = editing.lastRange;
      const anchor = range ? closest(range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement, "a") : null;
      return anchor?.getAttribute("href") ?? "";
    }
    const link = getSelectedObjects()[0]?.link;
    if (link?.kind === "page") return pageLinkUrl(link.pageId);
    return link?.kind === "url" ? link.url : "";
  }

  /**
   * What the link form needs: the address (a page is `#<pageId>`) and whether something is
   * linked. A slide link counts as linked even though it has no address here.
   * @returns {import("./link-form.js").LinkInfo}
   */
  function getLinkInfo() {
    const url = getLinkUrl();
    const slideLink = !editing && getSelectedObjects()[0]?.link?.kind === "slide";
    const canLink = editing ? true : getSelectedObjects().length > 0;
    return { canLink, inLink: url !== "" || slideLink, url, text: "", hasSelection: true, wholeBlocks: true };
  }

  /**
   * The link form (web address or page) for the ribbon and the context menu. Applying links
   * the selected text while editing, otherwise the selected objects.
   * @param {() => void} close
   * @returns {HTMLElement}
   */
  function createLinkForm(close) {
    const form = buildLinkForm({
      info: getLinkInfo(),
      pages: linkPages(workspace),
      onApply: ({ url }) => setLink(url),
      onRemove: () => setLink(""),
      close
    });
    // Keep typing in the form from reaching the editor's shortcuts.
    form.addEventListener("keydown", (event) => event.stopPropagation());
    return form;
  }

  const canEditText = () => getSelectedObjects().some(textCapable);

  function getTextState() {
    return getSelectedObjects().find(textCapable)?.text ?? null;
  }

  // -- mouse gestures ------------------------------------------------------------------------------

  /**
   * Convert viewport coordinates into slide coordinates.
   * @param {number} clientX
   * @param {number} clientY
   */
  function toSlide(clientX, clientY) {
    const size = getSize();
    const rect = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const sx = rect.width / size.width || 1;
    const sy = rect.height / size.height || 1;
    return { x: (clientX - rect.left) / sx, y: (clientY - rect.top) / sy };
  }

  /** @param {MouseEvent} event */
  function onMouseDown(event) {
    if (event.button !== 0) return;
    const target = /** @type {Element} */ (event.target);
    if (editing && editing.host.contains(target)) return;
    if (closest(target, ".stage-empty")) return;
    if (previewHandle) {
      event.preventDefault();
      stopPreview();
      return;
    }
    if (closest(target, "[data-role=reference-handle]")) return;
    if (editing) finishEdit(true);

    // Pointer-down on the stage never starts a native text selection or drag.
    event.preventDefault();
    stageArea.focus();
    popovers.close();

    const point = toSlide(event.clientX, event.clientY);
    const slide = getSlide();
    if (!slide || !stage) return;

    const pathHandle = closest(target, "[data-path-handle]");
    if (pathHandle) {
      beginPathGesture(/** @type {HTMLElement} */ (pathHandle), point, event);
      return;
    }

    const handle = closest(target, "[data-handle]");
    if (handle) {
      beginHandleGesture(/** @type {HTMLElement} */ (handle).dataset.handle ?? "", point, event);
      return;
    }

    const inStage = closest(target, ".stage") !== null;
    if (tool && inStage) {
      gesture = { type: "draw", tool, start: point, startClient: { x: event.clientX, y: event.clientY } };
      startDocumentListeners();
      return;
    }

    const objectEl = closest(target, ".slide-object");
    const id = objectEl ? /** @type {HTMLElement} */ (objectEl).dataset.objectId : undefined;
    if (id && slide.objects[id]) {
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      let collapseTo = null;
      if (additive) {
        selectedIds = selectedIds.includes(id) ? selectedIds.filter((s) => s !== id) : [...selectedIds, id];
        afterStateChange();
        if (!selectedIds.includes(id)) return;
      } else if (!selectedIds.includes(id)) {
        selectedIds = [id];
        afterStateChange();
      } else if (selectedIds.length > 1) {
        collapseTo = id;
      }
      beginMove(point, event, collapseTo);
      return;
    }

    if (inStage) {
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const base = additive ? [...selectedIds] : [];
      if (!additive && selectedIds.length > 0) {
        selectedIds = [];
        afterStateChange();
      }
      gesture = { type: "marquee", start: point, base, moved: false, startClient: { x: event.clientX, y: event.clientY } };
      startDocumentListeners();
      return;
    }

    if (selectedIds.length > 0) {
      selectedIds = [];
      afterStateChange();
    }
  }

  /**
   * @param {{ x: number, y: number }} point
   * @param {MouseEvent} event
   * @param {string | null} collapseTo
   */
  function beginMove(point, event, collapseTo) {
    const objects = getSelectedObjects();
    gesture = {
      type: "move",
      start: point,
      startClient: { x: event.clientX, y: event.clientY },
      ids: objects.map((o) => o.id),
      origin: new Map(objects.map((o) => [o.id, { x: o.x, y: o.y }])),
      bounds: unionBounds(objects.map(rotatedBounds)),
      moved: false,
      collapseTo,
      hideHandles: false
    };
    startDocumentListeners();
  }

  /**
   * @param {string} name
   * @param {{ x: number, y: number }} point
   * @param {MouseEvent} event
   */
  function beginHandleGesture(name, point, event) {
    const object = getSelectedObjects()[0];
    if (!object || selectedIds.length !== 1) return;
    const common = { start: point, startClient: { x: event.clientX, y: event.clientY }, id: object.id, object: { ...object }, moved: false, hideHandles: false };
    if (name === "rotate") {
      const center = centerOf(object);
      const offset = object.rotation - rotationFrom(center, point);
      gesture = { type: "rotate", ...common, center, offset };
    } else {
      gesture = { type: "resize", ...common, handle: name };
    }
    startDocumentListeners();
  }

  /**
   * Drag one end of a motion path.
   * @param {HTMLElement} handleEl
   * @param {{ x: number, y: number }} point
   * @param {MouseEvent} event
   */
  function beginPathGesture(handleEl, point, event) {
    const animationId = handleEl.dataset.animationId ?? "";
    const animation = getSlide()?.animations?.[animationId];
    const which = handleEl.dataset.pathHandle === "from" ? "from" : "to";
    if (!animation?.path) return;
    gesture = {
      type: "path",
      animationId,
      which,
      start: point,
      startClient: { x: event.clientX, y: event.clientY },
      path: structuredClone(animation.path),
      moved: false,
      hideHandles: false
    };
    startDocumentListeners();
  }

  function startDocumentListeners() {
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function stopDocumentListeners() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }

  /** @param {{ x: number, y: number }} startClient @param {MouseEvent} event */
  const pastThreshold = (startClient, event) =>
    Math.hypot(event.clientX - startClient.x, event.clientY - startClient.y) >= DRAG_THRESHOLD;

  /** Gesture geometry lands on whole logical pixels. */
  const whole = (/** @type {Rect} */ rect) => ({
    x: round(rect.x, 0),
    y: round(rect.y, 0),
    width: round(rect.width, 0),
    height: round(rect.height, 0)
  });

  /** @param {MouseEvent} event */
  function onMouseMove(event) {
    if (!gesture) return;
    const slide = getSlide();
    if (!slide) return;
    const point = toSlide(event.clientX, event.clientY);
    const size = getSize();

    if (gesture.type === "move") {
      if (!gesture.moved && !pastThreshold(gesture.startClient, event)) return;
      gesture.moved = true;
      let dx = point.x - gesture.start.x;
      let dy = point.y - gesture.start.y;
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      let guides = [];
      if (!event.altKey && (view.snap || view.grid)) {
        const moving = { x: gesture.bounds.x + dx, y: gesture.bounds.y + dy, width: gesture.bounds.width, height: gesture.bounds.height };
        const others = view.snap
          ? slide.objectOrder.filter((id) => !gesture.ids.includes(id)).map((id) => rotatedBounds(slide.objects[id]))
          : [];
        if (view.snap) {
          const snapped = snapMove(moving, others, size, { grid: view.grid ? GRID_SIZE : 0 });
          dx += snapped.dx;
          dy += snapped.dy;
          guides = snapped.guides;
        } else {
          dx += Math.round(moving.x / GRID_SIZE) * GRID_SIZE - moving.x;
          dy += Math.round(moving.y / GRID_SIZE) * GRID_SIZE - moving.y;
        }
      }
      preview.guides = guides;
      for (const id of gesture.ids) {
        const origin = gesture.origin.get(id);
        previewObject(id, { x: round(origin.x + dx, 0), y: round(origin.y + dy, 0) });
      }
      gesture.hideHandles = true;
      renderOverlay();
    } else if (gesture.type === "resize") {
      if (!gesture.moved && !pastThreshold(gesture.startClient, event)) return;
      gesture.moved = true;
      const object = gesture.object;
      const rect = resizeRect(object, object.rotation, gesture.handle, { x: point.x - gesture.start.x, y: point.y - gesture.start.y }, {
        keepAspect: event.shiftKey || object.type === "image",
        fromCenter: event.altKey,
        minWidth: object.type === "line" ? 0 : 8,
        minHeight: object.type === "line" ? 0 : 8
      });
      previewObject(gesture.id, whole(rect));
      renderOverlay();
    } else if (gesture.type === "rotate") {
      if (!gesture.moved && !pastThreshold(gesture.startClient, event)) return;
      gesture.moved = true;
      let degrees = normalizeAngle(rotationFrom(gesture.center, point) + gesture.offset);
      if (event.shiftKey) degrees = normalizeAngle(Math.round(degrees / ROTATE_STEP) * ROTATE_STEP);
      previewObject(gesture.id, { rotation: Math.round(degrees) % 360 });
      renderOverlay();
    } else if (gesture.type === "path") {
      if (!gesture.moved && !pastThreshold(gesture.startClient, event)) return;
      gesture.moved = true;
      const clampOffset = (/** @type {number} */ n) => Math.max(-ANIM_MAX_OFFSET, Math.min(ANIM_MAX_OFFSET, round(n, 0)));
      const origin = gesture.path[gesture.which];
      const next = { ...gesture.path, [gesture.which]: { x: clampOffset(origin.x + point.x - gesture.start.x), y: clampOffset(origin.y + point.y - gesture.start.y) } };
      preview.path = { animationId: gesture.animationId, from: next.from, to: next.to };
      renderOverlay();
    } else if (gesture.type === "marquee") {
      if (!gesture.moved && !pastThreshold(gesture.startClient, event)) return;
      gesture.moved = true;
      const rect = rectFromPoints(gesture.start, point);
      preview.marquee = rect;
      const hit = objectsInMarquee(slide, rect);
      selectedIds = slide.objectOrder.filter((id) => gesture.base.includes(id) || hit.includes(id));
      renderOverlay();
      inspector.render();
    } else if (gesture.type === "draw") {
      const clamp = (/** @type {{ x: number, y: number }} */ p) => ({
        x: Math.max(0, Math.min(size.width, p.x)),
        y: Math.max(0, Math.min(size.height, p.y))
      });
      gesture.end = clamp(point);
      if (!gesture.moved && !pastThreshold(gesture.startClient, event)) return;
      gesture.moved = true;
      preview.draw = { tool: gesture.tool, rect: whole(rectFromPoints(clamp(gesture.start), gesture.end)) };
      renderOverlay();
    }
  }

  /** @param {MouseEvent} _event */
  function onMouseUp(_event) {
    const active = gesture;
    if (!active) return;
    stopDocumentListeners();
    gesture = null;
    const slideId = currentSlideId;
    const drawn = preview.draw;
    const finalRects = new Map(preview.rects);
    const finalPath = preview.path;
    clearPreview();
    if (!slideId) return;

    if (active.type === "move") {
      if (!active.moved) {
        if (active.collapseTo) selectObjects([active.collapseTo]);
        return;
      }
      const items = [];
      for (const id of active.ids) {
        const rect = /** @type {{ x: number, y: number } | undefined} */ (finalRects.get(id));
        const origin = active.origin.get(id);
        if (rect && origin && (rect.x !== origin.x || rect.y !== origin.y)) items.push({ objectId: id, patch: { x: rect.x, y: rect.y } });
      }
      if (items.length > 0) patchObjects(items);
      else {
        renderStage();
        afterStateChange();
      }
    } else if (active.type === "resize" || active.type === "rotate") {
      const patch = finalRects.get(active.id);
      if (active.moved && patch) patchObjects([{ objectId: active.id, patch: /** @type {Record<string, unknown>} */ (patch) }]);
      else {
        renderStage();
        afterStateChange();
      }
    } else if (active.type === "path") {
      const unchanged = finalPath && JSON.stringify({ from: finalPath.from, to: finalPath.to }) === JSON.stringify(active.path);
      if (active.moved && finalPath && !unchanged) {
        updateAnimation({ path: { from: finalPath.from, to: finalPath.to } }, active.animationId);
      } else {
        renderOverlay();
      }
    } else if (active.type === "marquee") {
      renderOverlay();
      afterStateChange();
    } else if (active.type === "draw") {
      const end = active.end ?? active.start;
      if (active.moved && drawn && (drawn.rect.width >= 8 || drawn.rect.height >= 8)) {
        const flip = active.tool.type === "line" && (end.x - active.start.x) * (end.y - active.start.y) < 0;
        createFromTool(active.tool, drawn.rect, flip);
      } else {
        createFromTool(active.tool, defaultBox(active.tool, active.start), false);
      }
    }
  }

  function cancelGesture() {
    if (!gesture) return;
    stopDocumentListeners();
    const wasMarquee = gesture.type === "marquee";
    gesture = null;
    clearPreview();
    renderStage();
    if (wasMarquee) selectedIds = [];
    afterStateChange();
  }

  /** @param {MouseEvent} event */
  function onDoubleClick(event) {
    const objectEl = closest(event.target, ".slide-object");
    if (!objectEl || editing) return;
    const id = /** @type {HTMLElement} */ (objectEl).dataset.objectId;
    const object = id ? getSlide()?.objects[id] : null;
    if (object?.type === "reference" && object.kind === "expression") {
      event.preventDefault();
      selectedIds = [object.id];
      afterStateChange();
      editExpression(object, /** @type {HTMLElement} */ (objectEl));
      return;
    }
    if (!object || !textCapable(object)) return;
    event.preventDefault();
    if (!(selectedIds.length === 1 && selectedIds[0] === id)) {
      selectedIds = [object.id];
      afterStateChange();
    }
    startEdit(object.id);
  }

  // -- context menu ------------------------------------------------------------------------------------

  /** @param {{ x: number, y: number }} point @param {import("./popover.js").MenuItem[]} items */
  function showMenu(point, items) {
    popovers.showAt(point, buildMenu(items, popovers.close, (name) => icon(name, { size: 16 })));
  }

  /** @param {MouseEvent} event */
  function onContextMenu(event) {
    if (editing && editing.host.contains(/** @type {Node} */ (event.target))) return;
    event.preventDefault();
    if (editing) finishEdit(true);
    if (gesture) return;
    const point = { x: event.clientX, y: event.clientY };
    const objectEl = closest(event.target, ".slide-object");
    const id = objectEl ? /** @type {HTMLElement} */ (objectEl).dataset.objectId : undefined;
    const slide = getSlide();
    if (!slide) return;

    if (id && slide.objects[id]) {
      if (!selectedIds.includes(id)) {
        selectedIds = [id];
        afterStateChange();
      }
      const single = selectedIds.length === 1;
      const canText = single && textCapable(slide.objects[id]);
      /** @type {import("./popover.js").MenuItem[]} */
      const items = [
        { label: "Cut", icon: "cut", attrs: { "data-action": "cut" }, action: cutSelected },
        { label: "Copy", icon: "copy", attrs: { "data-action": "copy" }, action: () => void copySelected() },
        { label: "Paste", icon: "paste", attrs: { "data-action": "paste" }, disabled: !canPaste(), action: pasteObjects },
        { separator: true },
        { label: "Duplicate", icon: "duplicate", attrs: { "data-action": "duplicate" }, action: duplicateSelected },
        { label: "Delete", icon: "trash", danger: true, attrs: { "data-action": "delete" }, action: deleteSelected },
        { separator: true },
        {
          label: "Arrange",
          icon: "bring-front",
          attrs: { "data-action": "arrange" },
          submenu: [
            { label: "Bring to front", icon: "bring-front", attrs: { "data-action": "arrange-front" }, action: () => arrange("front") },
            { label: "Bring forward", icon: "bring-forward", attrs: { "data-action": "arrange-forward" }, action: () => arrange("forward") },
            { label: "Send backward", icon: "send-backward", attrs: { "data-action": "arrange-backward" }, action: () => arrange("backward") },
            { label: "Send to back", icon: "send-back", attrs: { "data-action": "arrange-back" }, action: () => arrange("back") }
          ]
        }
      ];
      if (single) items.push({ label: "Link…", icon: "link", attrs: { "data-action": "link" }, action: () => openLinkPopover(point) });
      if (canText) items.push({ label: "Edit text", icon: "textbox", attrs: { "data-action": "edit-text" }, action: () => void startEdit() });
      showMenu(point, items);
      return;
    }

    showMenu(point, [
      { label: "Paste", icon: "paste", attrs: { "data-action": "paste" }, disabled: !canPaste(), action: pasteObjects },
      { label: "Select all", attrs: { "data-action": "select-all" }, action: selectAll }
    ]);
  }

  /** @param {{ x: number, y: number }} point */
  function openLinkPopover(point) {
    const form = createLinkForm(() => popovers.close());
    popovers.showAt(point, form, { class: "popover-dialog" });
    form.querySelector("input")?.focus();
  }

  // -- keyboard ------------------------------------------------------------------------------------------

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    const target = /** @type {Element} */ (event.target);
    if (event.key === "Escape" && previewHandle) {
      event.preventDefault();
      stopPreview();
      return;
    }
    if (closest(target, "input, select, textarea, [contenteditable='true'], .slide-strip, .inspector, .animation-timeline, .popover")) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;

    if (key === "Escape") {
      if (gesture) {
        cancelGesture();
      } else if (tool) {
        setTool(null);
      } else if (selectedIds.length > 0) {
        selectObjects([]);
      }
      return;
    }
    if (gesture) return;

    if (mod && !event.altKey) {
      const lower = key.toLowerCase();
      if (lower === "a") { event.preventDefault(); selectAll(); }
      else if (lower === "c") { event.preventDefault(); copySelected(); }
      else if (lower === "x") { event.preventDefault(); cutSelected(); }
      else if (lower === "v") { event.preventDefault(); pasteObjects(); }
      else if (lower === "d") { event.preventDefault(); duplicateSelected(); }
      else if (lower === "b" || lower === "i" || lower === "u") {
        event.preventDefault();
        toggleMark(/** @type {Mark} */ ({ b: "bold", i: "italic", u: "underline" }[lower]));
      }
      return;
    }

    if (key === "Delete" || key === "Backspace") {
      if (selectedIds.length > 0) {
        event.preventDefault();
        deleteSelected();
      }
    } else if (key.startsWith("Arrow") && selectedIds.length > 0) {
      event.preventDefault();
      const step = event.shiftKey ? NUDGE_FAST : NUDGE;
      const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
      const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      patchObjects(getSelectedObjects().map((o) => ({ objectId: o.id, patch: { x: round(o.x + dx), y: round(o.y + dy) } })));
    } else if (key === "F2" || key === "Enter") {
      if (editableId()) {
        event.preventDefault();
        startEdit();
      }
    } else if (key === "PageDown" || key === "PageUp") {
      const order = getContent().slideOrder;
      const next = order[order.indexOf(currentSlideId ?? "") + (key === "PageDown" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        selectSlide(next);
      }
    } else if (key.length === 1 && !event.altKey && editableId()) {
      // Typing on a selected text object starts editing; the character lands in the text.
      event.preventDefault();
      if (startEdit() && editing) insertTextAtCaret(editing.host, key);
    }
  }

  // -- wiring ------------------------------------------------------------------------------------------------

  stageArea.addEventListener("mousedown", (event) => onMouseDown(/** @type {MouseEvent} */ (event)));
  stageArea.addEventListener("dblclick", (event) => onDoubleClick(/** @type {MouseEvent} */ (event)));
  stageArea.addEventListener("contextmenu", (event) => onContextMenu(/** @type {MouseEvent} */ (event)));
  root.addEventListener("keydown", (event) => onKeydown(/** @type {KeyboardEvent} */ (event)));

  const unsubscribe = workspace.events.on("change", (event) => {
    if (destroyed) return;
    const payload = /** @type {{ pages?: string[] }} */ (event ?? {});
    if (payload.pages && !payload.pages.includes(pageId) && !drewReferences) return;
    cached = null;
    if (editing) {
      const dispatched = finishEdit(true);
      if (dispatched) return;
    }
    refresh();
  });

  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      if (destroyed || gesture || editing) return;
      if (Math.abs(computeScale() - scale) > 0.001) {
        stopPreview();
        renderStage();
      }
    });
    resizeObserver.observe(stageArea);
  }

  /** @param {Partial<View>} patch */
  function setView(patch) {
    Object.assign(view, patch);
    root.classList.toggle("hide-inspector", !view.inspector);
    root.classList.toggle("show-timeline", Boolean(view.timeline));
    stage?.classList.toggle("show-grid", view.grid);
    if (!view.timeline) stopPreview({ quiet: true });
    renderOverlay();
    timeline.render();
    options.onSelectionChange?.();
  }

  root.classList.toggle("hide-inspector", !view.inspector);
  root.classList.toggle("show-timeline", Boolean(view.timeline));
  if (!currentSlideId || !getContent().slides[currentSlideId]) currentSlideId = getContent().slideOrder[0] ?? null;
  strip.render();
  timeline.render();
  renderStage();
  inspector.render();

  return {
    element: root,
    refresh,
    destroy() {
      destroyed = true;
      stopPreview({ quiet: true });
      stopDocumentListeners();
      document.removeEventListener("selectionchange", onSelectionChange);
      unsubscribe();
      resizeObserver?.disconnect();
      clearNotice();
      popovers.destroy();
    },
    // state
    getContent,
    getSlide,
    getSlideId,
    getSize,
    getSelection: () => [...selectedIds],
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
