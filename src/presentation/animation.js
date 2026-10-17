/**
 * Animation logic (pure, no DOM): timeline planning and effect keyframes.
 *
 * A slide's animations play in `animationOrder`. A "click" trigger begins a new
 * step; "with previous" starts when the previous animation starts; "after
 * previous" starts when the previous one ends. Times are milliseconds relative to
 * the click that opens the step (step 0 plays on its own as soon as the slide
 * shows, before the first click).
 */

import { round, rotatedBounds } from "./geometry.js";

/** @typedef {import("./model.js").Slide} Slide */
/** @typedef {import("./model.js").Animation} Animation */
/** @typedef {import("./model.js").SlideObject} SlideObject */

/** Effects that bring an object onto the slide (it is hidden until they play). */
const ENTRANCE_EFFECTS = new Set(["appear", "fade-in", "slide-in"]);

/** Pause between click steps when a preview plays them without a presenter. */
export const PREVIEW_STEP_PAUSE = 400;

/**
 * @param {Animation} animation
 * @returns {boolean}
 */
export function isEntrance(animation) {
  return ENTRANCE_EFFECTS.has(animation.effect);
}

/**
 * @typedef {object} TimelineEntry
 * @property {string} id
 * @property {number} step Click step the animation belongs to (0 plays automatically).
 * @property {number} anchor Time the trigger fires, relative to the step's click.
 * @property {number} start `anchor + delay`.
 * @property {number} end `start + duration`.
 */

/**
 * Resolve the order, triggers and timings of a slide's animations.
 * @param {Pick<Slide, "animations" | "animationOrder">} slide
 * @returns {TimelineEntry[]}
 */
export function planTimeline(slide) {
  /** @type {TimelineEntry[]} */
  const entries = [];
  let step = 0;
  let previous = /** @type {TimelineEntry | null} */ (null);
  for (const id of slide.animationOrder ?? []) {
    const animation = slide.animations?.[id];
    if (!animation) continue;
    let anchor = 0;
    if (animation.trigger === "click") {
      if (previous) step += 1;
    } else if (previous) {
      anchor = animation.trigger === "with" ? previous.anchor : previous.end;
    }
    const start = anchor + animation.delay;
    const entry = { id, step, anchor, start, end: start + animation.duration };
    entries.push(entry);
    previous = entry;
  }
  return entries;
}

/**
 * Absolute preview schedule: steps run one after another, separated by a pause.
 * @param {Pick<Slide, "animations" | "animationOrder">} slide
 * @param {number} [pause]
 * @returns {{ items: { id: string, at: number, end: number }[], total: number }}
 */
export function planPreview(slide, pause = PREVIEW_STEP_PAUSE) {
  const timeline = planTimeline(slide);
  /** @type {{ id: string, at: number, end: number }[]} */
  const items = [];
  let offset = 0;
  let total = 0;
  let index = 0;
  while (index < timeline.length) {
    const step = timeline[index].step;
    let length = 0;
    while (index < timeline.length && timeline[index].step === step) {
      const entry = timeline[index];
      items.push({ id: entry.id, at: offset + entry.start, end: offset + entry.end });
      length = Math.max(length, entry.end);
      index += 1;
    }
    total = offset + length;
    offset = total + pause;
  }
  return { items, total };
}

/**
 * Objects that must be hidden until an entrance animation reveals them.
 * @param {Pick<Slide, "animations" | "animationOrder">} slide
 * @returns {Set<string>} object ids
 */
export function initiallyHidden(slide) {
  /** @type {Set<string>} */
  const hidden = new Set();
  for (const id of slide.animationOrder ?? []) {
    const animation = slide.animations?.[id];
    if (animation && isEntrance(animation)) hidden.add(animation.objectId);
  }
  return hidden;
}

/**
 * Translation that parks an object just outside the slide on the side it enters from.
 * @param {Pick<SlideObject, "x" | "y" | "width" | "height" | "rotation">} object
 * @param {"left" | "right" | "up" | "down"} direction Where the object comes from.
 * @param {{ width: number, height: number }} size
 * @returns {{ x: number, y: number }}
 */
export function slideInOffset(object, direction, size) {
  const bounds = rotatedBounds(object);
  switch (direction) {
    case "left":
      return { x: round(-(bounds.x + bounds.width)), y: 0 };
    case "right":
      return { x: round(size.width - bounds.x), y: 0 };
    case "up":
      return { x: 0, y: round(-(bounds.y + bounds.height)) };
    default:
      return { x: 0, y: round(size.height - bounds.y) };
  }
}

/** @param {{ x: number, y: number }} point */
function translateOf(point) {
  return `${round(point.x)}px ${round(point.y)}px`;
}

/**
 * Web Animations keyframes for one animation. Movement uses the individual CSS
 * `translate` property so it composes with the object's inline `rotate`/`transform`.
 * @param {Animation} animation
 * @param {Pick<SlideObject, "x" | "y" | "width" | "height" | "rotation">} object
 * @param {{ width: number, height: number }} size
 * @returns {Record<string, string | number>[]}
 */
export function effectKeyframes(animation, object, size) {
  switch (animation.effect) {
    case "appear":
    case "fade-in":
      return [{ opacity: 0 }, { opacity: 1 }];
    case "slide-in":
      return [
        { translate: translateOf(slideInOffset(object, animation.direction ?? "left", size)) },
        { translate: "0px 0px" }
      ];
    case "motion": {
      const path = animation.path ?? { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
      return [{ translate: translateOf(path.from) }, { translate: translateOf(path.to) }];
    }
    default:
      return [];
  }
}
