/**
 * Slide animation preview: plays the current slide's animations once on the live
 * stage with the Web Animations API, then restores the resting state.
 *
 * Entrance objects are hidden until their animation starts. Steps that wait for a
 * click in a slideshow advance by themselves here (see `planPreview`). Where
 * `element.animate` does not exist (jsdom), the preview still reveals objects at
 * the right time and leaves motion objects at their end point.
 *
 * Nothing here touches the model: it only styles the elements it is given, and
 * `stop()` puts every one of them back.
 */

import { effectKeyframes, initiallyHidden, planPreview } from "../presentation/animation.js";

/** How long the finished state stays on screen before the preview ends (ms). */
export const PREVIEW_HOLD = 600;

/**
 * @typedef {object} PreviewOptions
 * @property {HTMLElement} slideEl The rendered slide (its children carry `data-object-id`).
 * @property {import("../presentation/model.js").Slide} slide
 * @property {{ width: number, height: number }} size
 * @property {() => void} [onDone] Called once when the preview ends by itself.
 *
 * @typedef {object} PreviewHandle
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => boolean} isRunning
 */

/**
 * @param {PreviewOptions} options
 * @returns {PreviewHandle}
 */
export function createPreview({ slideEl, slide, size, onDone }) {
  /** @type {Map<string, HTMLElement>} */
  const elements = new Map();
  for (const child of Array.from(slideEl.children)) {
    const id = /** @type {HTMLElement} */ (child).dataset.objectId;
    if (id) elements.set(id, /** @type {HTMLElement} */ (child));
  }

  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  /** @type {{ cancel: () => void }[]} */
  const running = [];
  let active = false;

  /**
   * @param {() => void} fn
   * @param {number} ms
   */
  function later(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  /** @param {string} animationId */
  function play(animationId) {
    const animation = slide.animations[animationId];
    const object = animation && slide.objects[animation.objectId];
    const el = animation && elements.get(animation.objectId);
    if (!animation || !object || !el) return;
    el.style.visibility = "";
    if (typeof el.animate === "function") {
      running.push(
        el.animate(effectKeyframes(animation, object, size), {
          duration: animation.duration,
          easing: animation.effect === "appear" ? "step-end" : "ease-in-out",
          fill: "both"
        })
      );
    } else if (animation.effect === "motion" && animation.path) {
      el.style.translate = `${animation.path.to.x}px ${animation.path.to.y}px`;
    }
  }

  function restore() {
    for (const animation of running) animation.cancel();
    running.length = 0;
    for (const el of elements.values()) {
      el.style.visibility = "";
      el.style.translate = "";
    }
  }

  function stop() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (!active && running.length === 0) return;
    active = false;
    restore();
  }

  function start() {
    stop();
    const plan = planPreview(slide);
    if (plan.items.length === 0) {
      onDone?.();
      return;
    }
    active = true;
    for (const id of initiallyHidden(slide)) {
      const el = elements.get(id);
      if (el) el.style.visibility = "hidden";
    }
    for (const item of plan.items) later(() => play(item.id), item.at);
    later(() => {
      stop();
      onDone?.();
    }, plan.total + PREVIEW_HOLD);
  }

  return { start, stop, isRunning: () => active };
}
