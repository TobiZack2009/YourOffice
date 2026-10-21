/**
 * Animation commands of the presentation editor: add, edit, reorder and remove animations, and the in-editor preview.
 * State shared with the editor arrives through the `ed` kernel; the mutable parts live on `ed.st`.
 */

import { createId } from "../core/ids.js";
import { createPreview } from "./animation-preview.js";
import { effectLabel, effectPatch, objectLabel } from "./animation-timeline.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../presentation/model.js").SlideObject} SlideObject */
/** @typedef {import("../presentation/model.js").Slide} Slide */
/** @typedef {import("../presentation/model.js").Animation} Animation */
/** @typedef {import("../presentation/model.js").PresentationContent} PresentationContent */
/** @typedef {import("./marks.js").Mark} Mark */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/** @param {any} ed Editor kernel (see `createPresentationEditor`). */
export function createPresentationAnimations(ed) {
  const { finishEdit, getSelectedObjects, getSize, getSlide, options, popovers, renderOverlay, root, run, send, st, timeline, workspace } = ed;

  /** @returns {Animation[]} The current slide's animations in playback order. */
  function getAnimations() {
    const slide = getSlide();
    if (!slide) return [];
    return slide.animationOrder.map((id) => slide.animations[id]).filter(Boolean);
  }

  /** @returns {Animation | null} */
  function getSelectedAnimation() {
    return (st.selectedAnimationId && getSlide()?.animations?.[st.selectedAnimationId]) || null;
  }

  /**
   * When the selected objects change, the animation being edited follows them: it stays if
   * it belongs to one of them, else the first animation of a selected object is picked, else
   * none. Emptying the selection leaves the animation alone (the timeline keeps editing it).
   */
  function syncAnimationToSelection() {
    const key = st.selectedIds.join(",");
    if (key === st.syncedSelection) return;
    st.syncedSelection = key;
    const slide = getSlide();
    if (!slide || st.selectedIds.length === 0) return;
    const current = st.selectedAnimationId ? slide.animations[st.selectedAnimationId] : null;
    if (current && st.selectedIds.includes(current.objectId)) return;
    const next = slide.animationOrder.find((id) => st.selectedIds.includes(slide.animations[id]?.objectId)) ?? null;
    if (next === st.selectedAnimationId) return;
    st.selectedAnimationId = next;
    timeline.select();
  }

  /** @param {string | null} id */
  function selectAnimation(id) {
    const next = id && getSlide()?.animations?.[id] ? id : null;
    if (next === st.selectedAnimationId) return;
    st.selectedAnimationId = next;
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
    const slideId = st.currentSlideId;
    const objects = getSelectedObjects();
    if (!slideId || objects.length === 0) return false;
    stopPreview({ quiet: true });
    finishEdit(true);
    const ids = objects.map(() => createId("anim"));
    st.selectedAnimationId = ids[ids.length - 1];
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
      selected: animation.id === st.selectedAnimationId
    }));
  }

  /**
   * Change fields of an animation (the selected one by default).
   * @param {Record<string, unknown>} patch
   * @param {string | null} [id]
   * @returns {boolean}
   */
  function updateAnimation(patch, id = st.selectedAnimationId) {
    if (!st.currentSlideId || !id) return false;
    stopPreview({ quiet: true });
    return run(() => send("updateAnimation", { slideId: st.currentSlideId, animationId: id, patch }));
  }

  /**
   * Remove an animation (the selected one by default); the next row takes the selection.
   * @param {string | null} [id]
   * @returns {boolean}
   */
  function removeAnimation(id = st.selectedAnimationId) {
    const slide = getSlide();
    if (!st.currentSlideId || !slide || !id || !slide.animations[id]) return false;
    stopPreview({ quiet: true });
    if (id === st.selectedAnimationId) {
      const rest = slide.animationOrder.filter((other) => other !== id);
      const at = slide.animationOrder.indexOf(id);
      st.selectedAnimationId = rest[Math.min(at, rest.length - 1)] ?? null;
    }
    return run(() => send("deleteAnimation", { slideId: st.currentSlideId, animationId: id }));
  }

  /**
   * @param {string} id
   * @param {number} index Position once the animation is lifted out of the order.
   * @returns {boolean}
   */
  function moveAnimation(id, index) {
    const slide = getSlide();
    if (!st.currentSlideId || !slide || !slide.animations[id]) return false;
    stopPreview({ quiet: true });
    const clamped = Math.max(0, Math.min(slide.animationOrder.length - 1, index));
    return run(() => send("moveAnimation", { slideId: st.currentSlideId, animationId: id, index: clamped }));
  }

  /**
   * Move the selected animation earlier (-1) or later (1).
   * @param {number} delta
   * @returns {boolean}
   */
  function moveSelectedAnimation(delta) {
    const slide = getSlide();
    if (!slide || !st.selectedAnimationId) return false;
    return moveAnimation(st.selectedAnimationId, slide.animationOrder.indexOf(st.selectedAnimationId) + delta);
  }

  const isPreviewing = () => st.previewHandle !== null;

  /**
   * Play the current slide's animations on the stage.
   * @returns {boolean} false when there is nothing to play
   */
  function startPreview() {
    const slide = getSlide();
    if (!slide || slide.animationOrder.length === 0) return false;
    stopPreview({ quiet: true });
    finishEdit(true);
    if (!st.slideEl) return false;
    popovers.close();
    const handle = createPreview({
      slideEl: st.slideEl,
      slide,
      size: getSize(),
      onDone: () => {
        if (st.previewHandle === handle) stopPreview();
      }
    });
    st.previewHandle = handle;
    root.classList.add("is-previewing");
    renderOverlay();
    timeline.render();
    options.onSelectionChange?.();
    handle.start();
    return true;
  }

  /** @param {{ quiet?: boolean }} [opts] quiet: the caller re-renders everything anyway. */
  function stopPreview(opts = {}) {
    const handle = st.previewHandle;
    if (!handle) return;
    st.previewHandle = null;
    handle.stop();
    root.classList.remove("is-previewing");
    if (opts.quiet) return;
    renderOverlay();
    timeline.render();
    options.onSelectionChange?.();
  }

  return { getAnimations, getSelectedAnimation, syncAnimationToSelection, selectAnimation, addAnimation, applyAnimationEffect, describeAnimations, updateAnimation, removeAnimation, moveAnimation, moveSelectedAnimation, isPreviewing, startPreview, stopPreview };
}
