/**
 * Slide commands of the presentation editor: current slide, add, duplicate, delete, move, background, transition and slide size.
 * State shared with the editor arrives through the `ed` kernel; the mutable parts live on `ed.st`.
 */

import { SIZE_LIMITS } from "../presentation/model.js";
import { createId } from "../core/ids.js";
import { h } from "./dom.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../presentation/model.js").SlideObject} SlideObject */
/** @typedef {import("../presentation/model.js").Slide} Slide */
/** @typedef {import("../presentation/model.js").Animation} Animation */
/** @typedef {import("../presentation/model.js").PresentationContent} PresentationContent */
/** @typedef {import("./marks.js").Mark} Mark */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** @param {any} ed Editor kernel (see `createPresentationEditor`). */
export function createPresentationSlides(ed) {
  const { finishEdit, getContent, getSize, inspector, notify, options, popovers, refresh, run, send, st, stageArea, stopPreview } = ed;

  /** @param {string | null} slideId */
  function setCurrent(slideId) {
    stopPreview({ quiet: true });
    st.currentSlideId = slideId;
    st.lostSlideId = null;
    st.selectedIds = [];
    st.selectedAnimationId = null;
    options.onSlideChange?.(slideId);
  }

  /** @param {string} slideId */
  function selectSlide(slideId) {
    if (slideId === st.currentSlideId || !getContent().slides[slideId]) return;
    finishEdit(true);
    setCurrent(slideId);
    refresh();
  }

  /**
   * @param {string} [layout]
   * @param {number} [index]
   */
  function newSlide(layout, index) {
    finishEdit(true);
    const order = getContent().slideOrder;
    const at = index ?? (st.currentSlideId ? order.indexOf(st.currentSlideId) + 1 : order.length);
    const slideId = createId("slide");
    setCurrent(slideId);
    run(() => send("createSlide", { slideId, index: at, ...(layout ? { layout } : {}) }));
  }

  /** @param {string | null} [slideId] */
  function duplicateSlide(slideId = st.currentSlideId) {
    if (!slideId) return;
    finishEdit(true);
    const newSlideId = createId("slide");
    setCurrent(newSlideId);
    run(() => send("duplicateSlide", { slideId, newSlideId }));
  }

  const canDeleteSlide = () => getContent().slideOrder.length > 1;

  /** @param {string | null} [slideId] */
  function deleteSlide(slideId = st.currentSlideId) {
    if (!slideId || !canDeleteSlide()) return;
    finishEdit(true);
    const order = getContent().slideOrder;
    const at = order.indexOf(slideId);
    if (slideId === st.currentSlideId) {
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
    if (st.currentSlideId && ids.includes(st.currentSlideId)) {
      const at = order.indexOf(st.currentSlideId);
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
    if (!st.currentSlideId) return;
    const at = getContent().slideOrder.indexOf(st.currentSlideId);
    moveSlide(st.currentSlideId, at + delta);
  }

  /** @param {string} color */
  function setBackground(color) {
    if (!st.currentSlideId) return;
    run(() => send("setSlideBackground", { slideId: st.currentSlideId, color }));
  }

  /** @param {Record<string, unknown>} patch */
  function setTransition(patch) {
    if (!st.currentSlideId) return;
    run(() => send("setSlideTransition", { slideId: st.currentSlideId, transition: patch }));
  }

  function applyTransitionToAll() {
    if (!st.currentSlideId) return;
    run(() => send("applyTransitionToAll", { slideId: st.currentSlideId }));
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

  return { setCurrent, selectSlide, newSlide, duplicateSlide, canDeleteSlide, deleteSlide, deleteSlides, moveSlide, moveCurrentSlide, setBackground, setTransition, applyTransitionToAll, setSlideSize, requestSlideSize };
}
