/**
 * Slide show logic (pure, no DOM): where the presenter is, what a forward or back
 * press does, what a slide looks like part-way through its animations, and how a
 * slide transition moves.
 *
 * A show position is `{ index, step }`: the slide's place in presentation order and
 * how many of its click steps have played. `step: -1` is a slide that has just
 * appeared; step 0 then plays on its own (see `planTimeline`), later steps wait for
 * a press. A slide without animations only ever sits at `-1`.
 */

import { isEntrance, planTimeline } from "./animation.js";

/** @typedef {import("./model.js").Slide} Slide */
/** @typedef {import("./model.js").Transition} Transition */

/**
 * @typedef {object} ShowPosition
 * @property {number} index
 * @property {number} step
 */

/**
 * The highest click step a slide has, or -1 when it has no animations.
 * @param {Pick<Slide, "animations" | "animationOrder">} slide
 * @returns {number}
 */
export function lastStep(slide) {
  const timeline = planTimeline(slide);
  return timeline.length === 0 ? -1 : timeline[timeline.length - 1].step;
}

/**
 * Timeline entries that play together when a click opens `step`.
 * @param {Pick<Slide, "animations" | "animationOrder">} slide
 * @param {number} step
 */
export function stepEntries(slide, step) {
  return planTimeline(slide).filter((entry) => entry.step === step);
}

/**
 * How long a set of entries takes, measured from the click that opened the step.
 * @param {{ end: number }[]} entries
 * @returns {number}
 */
export function stepLength(entries) {
  return entries.reduce((longest, entry) => Math.max(longest, entry.end), 0);
}

/**
 * The resting look of a slide once steps up to `step` have finished: entrance
 * objects whose step has not come stay hidden, finished motions sit at their end
 * point. Everything else is untouched.
 * @param {Pick<Slide, "animations" | "animationOrder">} slide
 * @param {number} step
 * @returns {{ hidden: Set<string>, translate: Map<string, { x: number, y: number }> }}
 */
export function settledAt(slide, step) {
  /** @type {Set<string>} */
  const hidden = new Set();
  /** @type {Map<string, { x: number, y: number }>} */
  const translate = new Map();
  for (const entry of planTimeline(slide)) {
    const animation = slide.animations[entry.id];
    if (!animation) continue;
    const played = entry.step <= step;
    if (isEntrance(animation)) {
      if (!played) hidden.add(animation.objectId);
    } else if (animation.effect === "motion" && animation.path && played) {
      translate.set(animation.objectId, animation.path.to);
    }
  }
  return { hidden, translate };
}

/**
 * What a forward press does.
 * - `step`: play the next click step on this slide.
 * - `slide`: move to the next slide.
 * - `none`: this is the end of the show.
 * @param {number} slideCount
 * @param {ShowPosition} position
 * @param {number} last The current slide's `lastStep`.
 * @returns {{ action: "step" | "slide" | "none", position: ShowPosition }}
 */
export function nextPosition(slideCount, position, last) {
  if (position.step < last) return { action: "step", position: { index: position.index, step: position.step + 1 } };
  if (position.index < slideCount - 1) return { action: "slide", position: { index: position.index + 1, step: -1 } };
  return { action: "none", position };
}

/**
 * What a back press does.
 * - `settle`: undo the latest click step on this slide.
 * - `slide`: go to the previous slide, with all its animations finished.
 * - `none`: already at the start.
 * @param {ShowPosition} position
 * @param {number} previousLast The previous slide's `lastStep` (-1 when there is none).
 * @returns {{ action: "settle" | "slide" | "none", position: ShowPosition }}
 */
export function previousPosition(position, previousLast) {
  if (position.step > 0) return { action: "settle", position: { index: position.index, step: position.step - 1 } };
  if (position.index > 0) return { action: "slide", position: { index: position.index - 1, step: previousLast } };
  return { action: "none", position };
}

/** @type {Record<string, string>} */
const OPPOSITE = { left: "right", right: "left", up: "down", down: "up" };

/**
 * The transition used to get from one slide to another. Going forward the incoming
 * slide's own transition plays. Going back the slide being left supplies it, run the
 * other way, so a wipe retraces what the presenter saw.
 * @param {Pick<Slide, "transition">} from
 * @param {Pick<Slide, "transition">} to
 * @param {boolean} forward
 * @returns {Transition}
 */
export function transitionBetween(from, to, forward) {
  if (forward) return to.transition;
  const { transition } = from;
  return { ...transition, direction: /** @type {Transition["direction"]} */ (OPPOSITE[transition.direction] ?? transition.direction) };
}

/**
 * Keyframes that bring the incoming slide in over the outgoing one. A wipe from
 * `left` uncovers the incoming slide starting at its left edge.
 * @param {Pick<Transition, "style" | "direction">} transition
 * @returns {Record<string, string | number>[]}
 */
export function transitionKeyframes(transition) {
  if (transition.style === "fade") return [{ opacity: 0 }, { opacity: 1 }];
  if (transition.style === "wipe") {
    const hidden = {
      left: "inset(0 100% 0 0)",
      right: "inset(0 0 0 100%)",
      up: "inset(0 0 100% 0)",
      down: "inset(100% 0 0 0)"
    }[transition.direction] ?? "inset(0 100% 0 0)";
    return [{ clipPath: hidden }, { clipPath: "inset(0 0 0 0)" }];
  }
  return [];
}

/**
 * Whether a transition has anything to play.
 * @param {Pick<Transition, "style" | "duration">} transition
 * @returns {boolean}
 */
export function hasTransition(transition) {
  return transition.style !== "none" && transition.duration > 0;
}
