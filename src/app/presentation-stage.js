/**
 * Drawing the stage of the presentation editor: the slide at its scale, its objects keyed by id, and the overlay with selection boxes, snap guides and animation marks.
 * State shared with the editor arrives through the `ed` kernel; the mutable parts live on `ed.st`.
 */

import { centerOf, fitScale, rotatedBounds, round, unionBounds } from "../presentation/geometry.js";
import { clear, h } from "./dom.js";
import { reconcileChildren } from "../core/reconcile.js";
import { renderObject, renderSlide } from "../presentation/render.js";
import { GRID_SIZE, MAX_STAGE_SCALE, STAGE_PADDING, handlePoints, svgNode } from "./presentation-dom.js";

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
 * @property {() => void} [onSelectionChange] Called when selection, tool, view or edit state changes.
 * @property {string | null} [initialSlideId] Slide to open on (falls back to the first).
 * @property {(slideId: string | null) => void} [onSlideChange]
 * @property {View} [view] Initial view state (the caller keeps it in the session so it survives remounts).
 * @property {(view: View) => void} [onViewChange] Called with a copy of the view after it changed.
 * @property {{ objects: SlideObject[], pastes: number }} [clipboard] Initial object clipboard, same reason.
 * @property {(clipboard: { objects: SlideObject[], pastes: number }) => void} [onClipboardChange]
 */

/** @param {any} ed Editor kernel (see `createPresentationEditor`). */
export function createPresentationStage(ed) {
  const { autoHeights, getContent, getSelectedObjects, getSize, getSlide, newSlide, objectEls, objectViews, preview, referenceHandle, run, slideHooks, st, stageArea, view } = ed;

  function computeScale() {
    const available = { width: stageArea.clientWidth - STAGE_PADDING, height: stageArea.clientHeight - STAGE_PADDING };
    return Math.min(MAX_STAGE_SCALE, fitScale(available, getSize()));
  }

  /**
   * What an object's drawn element depends on, or null when it also reads other pages (a
   * reference, an inline reference) and so must be redrawn on every pass.
   * @param {SlideObject} object
   * @returns {string | null}
   */
  function objectSignature(object) {
    if (object.type === "reference") return null;
    if ((object.text?.runs ?? []).some((run) => run.ref)) return null;
    return JSON.stringify(object);
  }

  /**
   * Make the slide element hold the slide's objects in order. An object whose data is unchanged
   * keeps its element (the same node across a change); one that changed, or whose element was
   * swapped for a preview or the text editor, is drawn again.
   * @param {Slide} slide
   * @param {HTMLElement} target
   */
  function syncObjects(slide, target) {
    const hooks = slideHooks();
    /** @type {HTMLElement[]} */
    const nodes = [];
    const seen = new Set();
    for (const id of slide.objectOrder) {
      const object = slide.objects[id];
      if (!object) continue;
      const signature = objectSignature(object);
      const view = objectViews.get(id);
      const kept = view && signature !== null && view.signature === signature && objectEls.get(id) === view.el;
      const el = kept ? view.el : renderObject(object, { interactive: true, ...hooks });
      objectViews.set(id, { signature, el });
      objectEls.set(id, el);
      nodes.push(el);
      seen.add(id);
    }
    for (const id of [...objectViews.keys()]) {
      if (seen.has(id)) continue;
      objectViews.delete(id);
      objectEls.delete(id);
    }
    reconcileChildren(target, nodes);
  }

  function renderStage() {
    stageArea.dataset.tool = st.tool ? st.tool.type : "";
    stageArea.classList.toggle("is-editing", st.editing !== null);

    const content = getContent();
    const slide = getSlide();
    if (!slide) {
      clear(stageArea);
      objectEls.clear();
      objectViews.clear();
      st.stage = null;
      st.slideEl = null;
      st.overlay = null;
      st.stageKey = "";
      const add = h("button", { class: "stage-empty-add", type: "button", "data-action": "add-first-slide", text: "Add a slide" });
      add.addEventListener("click", () => newSlide("title", 0));
      stageArea.append(h("div", { class: "stage-empty" }, [h("p", { text: "This presentation has no slides." }), add]));
      return;
    }

    st.scale = computeScale();
    const size = content.size;
    const key = `${slide.id}|${st.scale}|${size.width}x${size.height}`;
    if (st.stage && st.slideEl && st.overlay && st.stage.parentNode === stageArea && st.stageKey === key) {
      // Same slide at the same scale: keep the stage and every object that did not change.
      st.slideEl.dataset.layout = slide.layout;
      st.slideEl.style.background = slide.background?.color ?? "#ffffff";
      syncObjects(slide, st.slideEl);
      measureAutoHeights(slide);
      renderOverlay();
      return;
    }

    clear(stageArea);
    objectEls.clear();
    objectViews.clear();
    st.stage = h("div", { class: "stage", "data-role": "stage" });
    st.stage.style.width = `${round(size.width * st.scale)}px`;
    st.stage.style.height = `${round(size.height * st.scale)}px`;
    st.stage.style.setProperty("--scale", String(st.scale));
    st.stage.style.setProperty("--inv-scale", String(1 / st.scale));
    st.stage.style.setProperty("--grid", `${GRID_SIZE * st.scale}px`);
    st.stage.classList.toggle("show-grid", view.grid);

    st.slideEl = renderSlide({ ...slide, objectOrder: [], objects: {} }, { size, scale: st.scale, interactive: true });
    syncObjects(slide, st.slideEl);
    measureAutoHeights(slide);

    st.overlay = h("div", { class: "stage-overlay", "data-role": "overlay" });
    st.overlay.style.width = `${size.width}px`;
    st.overlay.style.height = `${size.height}px`;
    st.overlay.style.transform = `scale(${st.scale})`;
    st.overlay.style.transformOrigin = "0 0";

    st.stage.append(st.slideEl, st.overlay);
    stageArea.append(st.stage);
    st.stageKey = key;
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
    if (!st.overlay || !view.timeline || st.previewHandle) return;
    const size = getSize();
    const selectedAnim = st.selectedAnimationId ? slide.animations[st.selectedAnimationId] : null;
    const selectedObject = selectedAnim ? slide.objects[selectedAnim.objectId] : null;
    if (selectedObject) {
      const bounds = rotatedBounds(selectedObject);
      const box = h("div", { class: "animation-target", "data-role": "animation-target" });
      box.style.left = `${bounds.x}px`;
      box.style.top = `${bounds.y}px`;
      box.style.width = `${bounds.width}px`;
      box.style.height = `${bounds.height}px`;
      st.overlay.append(box);
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
        class: `animation-tag${id === st.selectedAnimationId ? " is-selected" : ""}`,
        "data-animation-id": id,
        text: String(index + 1)
      });
      tag.style.left = `${bounds.x + slot * 24 * (1 / st.scale)}px`;
      tag.style.top = `${bounds.y}px`;
      st.overlay?.append(tag);

      if (animation.effect !== "motion" || !animation.path) return;
      const path = preview.path?.animationId === id ? preview.path : animation.path;
      const centre = centerOf(object);
      const from = { x: centre.x + path.from.x, y: centre.y + path.from.y };
      const to = { x: centre.x + path.to.x, y: centre.y + path.to.y };
      const isSelected = id === st.selectedAnimationId;
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
    st.overlay.prepend(paths);
    st.overlay.append(...handles);
  }

  function renderOverlay() {
    if (!st.overlay) return;
    clear(st.overlay);
    const slide = getSlide();
    if (!slide || st.previewHandle) return;

    const objects = getSelectedObjects().map(
      (o) => /** @type {SlideObject} */ ({ ...o, ...(autoHeights.has(o.id) ? { height: autoHeights.get(o.id) } : {}), ...(preview.rects.get(o.id) ?? {}) })
    );
    const single = objects.length === 1;
    for (const object of objects) {
      st.overlay.append(selectionBox(object, { handles: single && !st.editing && !st.gesture?.hideHandles, id: object.id }));
    }
    if (single && !st.editing && !st.gesture && objects[0].type === "reference") st.overlay.append(referenceHandle(objects[0]));
    if (objects.length > 1 && !st.gesture) {
      const bounds = unionBounds(objects.map(rotatedBounds));
      const group = selectionBox({ ...bounds }, { handles: false });
      group.classList.add("selection-group");
      st.overlay.append(group);
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
      st.overlay.append(line);
    }

    const rectBox = (/** @type {Rect} */ rect, /** @type {string} */ className) => {
      const el = h("div", { class: className });
      el.style.left = `${rect.x}px`;
      el.style.top = `${rect.y}px`;
      el.style.width = `${rect.width}px`;
      el.style.height = `${rect.height}px`;
      return el;
    };
    if (preview.marquee) st.overlay.append(rectBox(preview.marquee, "marquee"));
    if (preview.draw) st.overlay.append(rectBox(preview.draw.rect, "draw-preview"));
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

  return { computeScale, objectSignature, syncObjects, renderStage, measureAutoHeights, selectionBox, renderAnimationOverlay, renderOverlay, clearPreview, previewObject };
}
