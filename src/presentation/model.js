/**
 * Presentation page model (spec §7).
 *
 * A presentation is an ordered list of slides that all share one logical size
 * (1280x720 by default). Each slide owns objects with stable ids; stacking is the
 * separate `objectOrder` array (bottom to top), so z-order is never identity.
 *
 *   content = { size: { width, height }, slideOrder: string[], slides: { [id]: Slide } }
 *   Slide   = { id, layout, background: { color }, transition, objectOrder, objects,
 *               animationOrder, animations }
 *
 * The size lives on the presentation, never on a slide. Everything here is pure:
 * validators return error lists and never throw.
 */

import { createId } from "../core/ids.js";
import { validateRuns } from "../document/model.js";

/** @typedef {import("../document/model.js").InlineRun} InlineRun */
/** @typedef {import("../workspace/schema.js").PageEnvelope} PageEnvelope */

export const SLIDE_DEFAULTS = {
  width: 1280,
  height: 720,
  background: "#ffffff"
};

/** Bounds for the shared logical slide size. */
export const SIZE_LIMITS = { min: 320, max: 7680 };

export const OBJECT_TYPES = ["text", "shape", "line", "image"];
export const SHAPES = ["rect", "ellipse", "triangle", "roundRect", "arrow"];
export const TRANSITION_STYLES = ["none", "fade", "wipe"];
export const TRANSITION_DIRECTIONS = ["left", "right", "up", "down"];
export const ANIMATION_EFFECTS = ["appear", "fade-in", "slide-in", "motion"];
export const ANIMATION_TRIGGERS = ["click", "with", "after"];
export const ANIMATION_DIRECTIONS = ["left", "right", "up", "down"];
export const ALIGNS = ["left", "center", "right"];
export const VALIGNS = ["top", "middle", "bottom"];
export const LINK_KINDS = ["url", "page", "slide"];

export const TEXT_DEFAULTS = {
  fontSize: 32,
  color: "#1d1d1f",
  align: "left",
  valign: "top"
};

export const OBJECT_DEFAULTS = {
  fill: "#e6f0ff",
  stroke: { color: "#1d6fdc", width: 2 },
  lineStroke: { color: "#1d1d1f", width: 3 }
};

/** Default timing (ms) and geometry per animation effect. */
export const ANIMATION_DEFAULTS = {
  duration: { appear: 0, "fade-in": 500, "slide-in": 500, motion: 1000 },
  direction: "left",
  path: { from: { x: 0, y: 0 }, to: { x: 240, y: 0 } }
};

/** Upper bound for an animation's delay and duration, in milliseconds. */
export const ANIM_MAX_MS = 30000;

/** Largest motion-path offset (logical px) either way. */
export const ANIM_MAX_OFFSET = 20000;

export const MIN_FONT_SIZE = 4;
export const MAX_FONT_SIZE = 600;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * @typedef {object} Transition
 * @property {"none" | "fade" | "wipe"} style
 * @property {"left" | "right" | "up" | "down"} direction
 * @property {number} duration Milliseconds.
 *
 * @typedef {{ x: number, y: number }} Point
 *
 * @typedef {object} Animation
 * @property {string} id
 * @property {string} objectId
 * @property {"appear" | "fade-in" | "slide-in" | "motion"} effect
 * @property {"click" | "with" | "after"} trigger
 * @property {number} delay Milliseconds, relative to the trigger.
 * @property {number} duration Milliseconds.
 * @property {"left" | "right" | "up" | "down"} [direction] Slide-in only.
 * @property {{ from: Point, to: Point }} [path] Motion only; offsets from the resting position.
 *
 * @typedef {object} TextBody
 * @property {InlineRun[]} runs
 * @property {number} fontSize
 * @property {string} color
 * @property {"left" | "center" | "right"} align
 * @property {"top" | "middle" | "bottom"} valign
 *
 * @typedef {{ kind: "url", url: string } | { kind: "page", pageId: string } | { kind: "slide", slideId: string }} ObjectLink
 *
 * @typedef {object} SlideObject
 * @property {string} id
 * @property {"text" | "shape" | "line" | "image"} type
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} rotation Degrees, clockwise.
 * @property {string} [name]
 * @property {ObjectLink} [link]
 * @property {string | null} [fill]
 * @property {{ color: string, width: number } | null} [stroke]
 * @property {"rect" | "ellipse" | "triangle" | "roundRect" | "arrow"} [shape]
 * @property {boolean} [flipV] Line direction inside its box (false: top-left to bottom-right).
 * @property {TextBody} [text]
 * @property {string} [src] Image data URL.
 *
 * @typedef {object} Slide
 * @property {string} id
 * @property {string} layout
 * @property {{ color: string }} background
 * @property {Transition} transition
 * @property {string[]} objectOrder Z-order, bottom to top.
 * @property {Record<string, SlideObject>} objects
 * @property {string[]} animationOrder Playback order.
 * @property {Record<string, Animation>} animations
 *
 * @typedef {{ size: { width: number, height: number }, slideOrder: string[], slides: Record<string, Slide> }} PresentationContent
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isColor(value) {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

/** @returns {Transition} */
export function defaultTransition() {
  return { style: "none", direction: "left", duration: 500 };
}

/**
 * @param {Partial<TextBody>} [fields]
 * @returns {TextBody}
 */
export function createTextBody(fields = {}) {
  return {
    runs: structuredClone(fields.runs ?? []),
    fontSize: fields.fontSize ?? TEXT_DEFAULTS.fontSize,
    color: fields.color ?? TEXT_DEFAULTS.color,
    align: fields.align ?? /** @type {"left"} */ (TEXT_DEFAULTS.align),
    valign: fields.valign ?? /** @type {"top"} */ (TEXT_DEFAULTS.valign)
  };
}

/**
 * Build a slide object with sensible per-type defaults. Input is deep-copied so
 * callers' structures are never shared with the store.
 * @param {"text" | "shape" | "line" | "image"} type
 * @param {Partial<SlideObject>} [fields]
 * @returns {SlideObject}
 */
export function createObject(type, fields = {}) {
  const copy = structuredClone(fields);
  /** @type {SlideObject} */
  const object = {
    id: typeof copy.id === "string" && copy.id ? copy.id : createId("obj"),
    type,
    x: copy.x ?? 0,
    y: copy.y ?? 0,
    width: copy.width ?? (type === "line" ? 240 : 320),
    height: copy.height ?? (type === "line" ? 0 : type === "text" ? 80 : 200),
    rotation: copy.rotation ?? 0
  };
  if (copy.name !== undefined) object.name = copy.name;
  if (copy.link !== undefined) object.link = copy.link;

  if (type === "text") {
    object.text = createTextBody(copy.text);
    if (copy.fill !== undefined) object.fill = copy.fill;
    if (copy.stroke !== undefined) object.stroke = copy.stroke;
  } else if (type === "shape") {
    object.shape = copy.shape ?? "rect";
    object.fill = copy.fill !== undefined ? copy.fill : OBJECT_DEFAULTS.fill;
    object.stroke = copy.stroke !== undefined ? copy.stroke : { ...OBJECT_DEFAULTS.stroke };
    if (copy.text !== undefined) object.text = createTextBody({ align: "center", valign: "middle", ...copy.text });
  } else if (type === "line") {
    object.stroke = copy.stroke ?? { ...OBJECT_DEFAULTS.lineStroke };
    object.flipV = copy.flipV ?? false;
  } else if (type === "image") {
    object.src = copy.src ?? "";
  }
  return object;
}

/**
 * @param {Partial<Slide> & { objects?: SlideObject[] | Record<string, SlideObject> }} [fields]
 * @returns {Slide}
 */
export function createSlide(fields = {}) {
  /** @type {Slide} */
  const slide = {
    id: typeof fields.id === "string" && fields.id ? fields.id : createId("slide"),
    layout: fields.layout ?? "blank",
    background: { color: fields.background?.color ?? SLIDE_DEFAULTS.background },
    transition: { ...defaultTransition(), ...(fields.transition ?? {}) },
    objectOrder: [],
    objects: {},
    animationOrder: [],
    animations: {}
  };
  if (Array.isArray(fields.objects)) {
    for (const object of fields.objects) {
      slide.objects[object.id] = structuredClone(object);
      slide.objectOrder.push(object.id);
    }
  }
  return slide;
}

/**
 * Build an animation with defaults for its effect. Input is deep-copied.
 * @param {Partial<Animation> & { objectId: string }} fields
 * @returns {Animation}
 */
export function createAnimation(fields) {
  const copy = structuredClone(fields);
  const effect = copy.effect ?? "fade-in";
  /** @type {Animation} */
  const animation = {
    id: typeof copy.id === "string" && copy.id ? copy.id : createId("anim"),
    objectId: copy.objectId,
    effect,
    trigger: copy.trigger ?? "click",
    delay: copy.delay ?? 0,
    duration: copy.duration ?? ANIMATION_DEFAULTS.duration[effect] ?? 500
  };
  if (effect === "slide-in") {
    animation.direction = copy.direction ?? /** @type {"left"} */ (ANIMATION_DEFAULTS.direction);
  } else if (effect === "motion") {
    animation.path = copy.path ?? structuredClone(ANIMATION_DEFAULTS.path);
  }
  return animation;
}

/** @returns {PresentationContent} */
export function createPresentationContent() {
  return {
    size: { width: SLIDE_DEFAULTS.width, height: SLIDE_DEFAULTS.height },
    slideOrder: [],
    slides: {}
  };
}

/**
 * Validate a size object.
 * @param {unknown} size
 * @returns {string[]}
 */
export function validateSize(size) {
  if (!isPlainObject(size)) return ["size must be an object"];
  /** @type {string[]} */
  const errors = [];
  for (const field of ["width", "height"]) {
    const value = size[field];
    if (!isFiniteNumber(value) || /** @type {number} */ (value) < SIZE_LIMITS.min || /** @type {number} */ (value) > SIZE_LIMITS.max) {
      errors.push(`size.${field} must be a number between ${SIZE_LIMITS.min} and ${SIZE_LIMITS.max}`);
    }
  }
  return errors;
}

/**
 * Validate a text body.
 * @param {unknown} text
 * @returns {string[]}
 */
export function validateTextBody(text) {
  if (!isPlainObject(text)) return ["text must be an object"];
  /** @type {string[]} */
  const errors = validateRuns(text.runs).map((message) => `text.${message}`);
  if (!isFiniteNumber(text.fontSize) || /** @type {number} */ (text.fontSize) < MIN_FONT_SIZE || /** @type {number} */ (text.fontSize) > MAX_FONT_SIZE) {
    errors.push(`text.fontSize must be a number between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}`);
  }
  if (!isColor(text.color)) errors.push("text.color must be a hex colour");
  if (typeof text.align !== "string" || !ALIGNS.includes(text.align)) errors.push("text.align is invalid");
  if (typeof text.valign !== "string" || !VALIGNS.includes(text.valign)) errors.push("text.valign is invalid");
  return errors;
}

/**
 * Validate an object link.
 * @param {unknown} link
 * @returns {string[]}
 */
export function validateLink(link) {
  if (!isPlainObject(link)) return ["link must be an object"];
  if (link.kind === "url") {
    return typeof link.url === "string" && link.url.length > 0 ? [] : ["link.url must be a non-empty string"];
  }
  if (link.kind === "page") {
    return typeof link.pageId === "string" && link.pageId.length > 0 ? [] : ["link.pageId must be a non-empty string"];
  }
  if (link.kind === "slide") {
    return typeof link.slideId === "string" && link.slideId.length > 0 ? [] : ["link.slideId must be a non-empty string"];
  }
  return [`link.kind must be one of ${LINK_KINDS.join(", ")}`];
}

/**
 * Validate one slide object.
 * @param {unknown} object
 * @returns {string[]} error messages (empty when valid).
 */
export function validateObject(object) {
  if (!isPlainObject(object)) return ["object must be an object"];
  /** @type {string[]} */
  const errors = [];
  if (typeof object.id !== "string" || object.id.length === 0) errors.push("object.id must be a non-empty string");
  if (typeof object.type !== "string" || !OBJECT_TYPES.includes(object.type)) {
    errors.push(`object.type must be one of ${OBJECT_TYPES.join(", ")}`);
    return errors;
  }
  for (const field of ["x", "y", "rotation"]) {
    if (!isFiniteNumber(object[field])) errors.push(`object.${field} must be a finite number`);
  }
  for (const field of ["width", "height"]) {
    const value = object[field];
    // A line may have a zero extent on one axis (horizontal/vertical).
    const min = object.type === "line" ? 0 : 1;
    if (!isFiniteNumber(value) || /** @type {number} */ (value) < min) {
      errors.push(`object.${field} must be a number ≥ ${min}`);
    }
  }
  if (object.name !== undefined && typeof object.name !== "string") errors.push("object.name must be a string");
  if (object.link !== undefined) errors.push(...validateLink(object.link).map((m) => `object.${m}`));

  if (object.fill !== undefined && object.fill !== null && !isColor(object.fill)) {
    errors.push("object.fill must be a hex colour or null");
  }
  if (object.stroke !== undefined && object.stroke !== null) {
    const stroke = object.stroke;
    if (!isPlainObject(stroke) || !isColor(stroke.color) || !isFiniteNumber(stroke.width) || /** @type {number} */ (stroke.width) < 0) {
      errors.push("object.stroke must be { color, width ≥ 0 } or null");
    }
  }
  if (object.type === "shape" && (typeof object.shape !== "string" || !SHAPES.includes(object.shape))) {
    errors.push(`object.shape must be one of ${SHAPES.join(", ")}`);
  }
  if (object.flipV !== undefined && typeof object.flipV !== "boolean") errors.push("object.flipV must be a boolean");
  if (object.text !== undefined) {
    if (object.type === "line" || object.type === "image") errors.push(`${object.type} objects cannot carry text`);
    else errors.push(...validateTextBody(object.text).map((m) => `object.${m}`));
  } else if (object.type === "text") {
    errors.push("object.text is required for text objects");
  }
  if (object.type === "image") {
    if (typeof object.src !== "string") errors.push("object.src must be a string");
    else if (object.src !== "" && !object.src.startsWith("data:image/")) errors.push("object.src must be an image data URL");
  } else if (object.src !== undefined) {
    errors.push("only image objects carry src");
  }
  return errors;
}

/**
 * Validate a transition.
 * @param {unknown} transition
 * @returns {string[]}
 */
export function validateTransition(transition) {
  if (!isPlainObject(transition)) return ["transition must be an object"];
  /** @type {string[]} */
  const errors = [];
  if (typeof transition.style !== "string" || !TRANSITION_STYLES.includes(transition.style)) {
    errors.push(`transition.style must be one of ${TRANSITION_STYLES.join(", ")}`);
  }
  if (typeof transition.direction !== "string" || !TRANSITION_DIRECTIONS.includes(transition.direction)) {
    errors.push(`transition.direction must be one of ${TRANSITION_DIRECTIONS.join(", ")}`);
  }
  if (!isFiniteNumber(transition.duration) || /** @type {number} */ (transition.duration) < 0 || /** @type {number} */ (transition.duration) > 10000) {
    errors.push("transition.duration must be 0–10000 ms");
  }
  return errors;
}

/**
 * @param {unknown} point
 * @returns {boolean}
 */
function isOffset(point) {
  return (
    isPlainObject(point) &&
    isFiniteNumber(point.x) &&
    isFiniteNumber(point.y) &&
    Math.abs(/** @type {number} */ (point.x)) <= ANIM_MAX_OFFSET &&
    Math.abs(/** @type {number} */ (point.y)) <= ANIM_MAX_OFFSET
  );
}

/**
 * Validate one animation's own fields (not whether its object exists).
 * @param {unknown} animation
 * @returns {string[]}
 */
export function validateAnimation(animation) {
  if (!isPlainObject(animation)) return ["animation must be an object"];
  /** @type {string[]} */
  const errors = [];
  if (typeof animation.id !== "string" || animation.id.length === 0) errors.push("animation.id must be a non-empty string");
  if (typeof animation.objectId !== "string" || animation.objectId.length === 0) {
    errors.push("animation.objectId must be a non-empty string");
  }
  if (typeof animation.effect !== "string" || !ANIMATION_EFFECTS.includes(animation.effect)) {
    errors.push(`animation.effect must be one of ${ANIMATION_EFFECTS.join(", ")}`);
  }
  if (typeof animation.trigger !== "string" || !ANIMATION_TRIGGERS.includes(animation.trigger)) {
    errors.push(`animation.trigger must be one of ${ANIMATION_TRIGGERS.join(", ")}`);
  }
  for (const field of ["delay", "duration"]) {
    const value = animation[field];
    if (!isFiniteNumber(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > ANIM_MAX_MS) {
      errors.push(`animation.${field} must be 0–${ANIM_MAX_MS} ms`);
    }
  }
  if (animation.effect === "slide-in") {
    if (typeof animation.direction !== "string" || !ANIMATION_DIRECTIONS.includes(animation.direction)) {
      errors.push(`animation.direction must be one of ${ANIMATION_DIRECTIONS.join(", ")}`);
    }
  } else if (animation.direction !== undefined) {
    errors.push("only slide-in animations carry a direction");
  }
  if (animation.effect === "motion") {
    if (!isPlainObject(animation.path) || !isOffset(animation.path.from) || !isOffset(animation.path.to)) {
      errors.push("animation.path must be { from: {x, y}, to: {x, y} }");
    }
  } else if (animation.path !== undefined) {
    errors.push("only motion animations carry a path");
  }
  return errors;
}

/**
 * Validate one slide.
 * @param {unknown} slide
 * @returns {string[]} error messages (empty when valid).
 */
export function validateSlide(slide) {
  if (!isPlainObject(slide)) return ["slide must be an object"];
  /** @type {string[]} */
  const errors = [];
  if (typeof slide.id !== "string" || slide.id.length === 0) errors.push("slide.id must be a non-empty string");
  if (typeof slide.layout !== "string") errors.push("slide.layout must be a string");
  if (!isPlainObject(slide.background) || !isColor(slide.background.color)) {
    errors.push("slide.background.color must be a hex colour");
  }
  errors.push(...validateTransition(slide.transition).map((m) => `slide.${m}`));

  if (!Array.isArray(slide.objectOrder)) {
    errors.push("slide.objectOrder must be an array");
  }
  if (!isPlainObject(slide.objects)) {
    errors.push("slide.objects must be an object");
  }
  if (Array.isArray(slide.objectOrder) && isPlainObject(slide.objects)) {
    const seen = new Set();
    for (const id of slide.objectOrder) {
      if (typeof id !== "string") {
        errors.push("slide.objectOrder must hold string ids");
        continue;
      }
      if (seen.has(id)) errors.push(`slide.objectOrder lists "${id}" twice`);
      seen.add(id);
      if (!slide.objects[id]) errors.push(`slide.objectOrder references missing object "${id}"`);
    }
    for (const [id, object] of Object.entries(slide.objects)) {
      if (!seen.has(id)) errors.push(`slide.objects["${id}"] is not in objectOrder`);
      if (isPlainObject(object) && object.id !== id) errors.push(`slide.objects["${id}"].id does not match its key`);
      errors.push(...validateObject(object).map((m) => `slide.objects["${id}"]: ${m}`));
    }
  }

  // Animations are optional on disk (older slides): absent means none.
  const hasAnimations = slide.animations !== undefined || slide.animationOrder !== undefined;
  if (hasAnimations) {
    if (!Array.isArray(slide.animationOrder)) errors.push("slide.animationOrder must be an array");
    if (!isPlainObject(slide.animations)) errors.push("slide.animations must be an object");
    if (Array.isArray(slide.animationOrder) && isPlainObject(slide.animations)) {
      const seen = new Set();
      for (const id of slide.animationOrder) {
        if (typeof id !== "string") {
          errors.push("slide.animationOrder must hold string ids");
          continue;
        }
        if (seen.has(id)) errors.push(`slide.animationOrder lists "${id}" twice`);
        seen.add(id);
        if (!slide.animations[id]) errors.push(`slide.animationOrder references missing animation "${id}"`);
      }
      for (const [id, animation] of Object.entries(slide.animations)) {
        if (!seen.has(id)) errors.push(`slide.animations["${id}"] is not in animationOrder`);
        if (isPlainObject(animation) && animation.id !== id) errors.push(`slide.animations["${id}"].id does not match its key`);
        errors.push(...validateAnimation(animation).map((m) => `slide.animations["${id}"]: ${m}`));
        if (
          isPlainObject(animation) &&
          isPlainObject(slide.objects) &&
          typeof animation.objectId === "string" &&
          !slide.objects[animation.objectId]
        ) {
          errors.push(`slide.animations["${id}"] references missing object "${animation.objectId}"`);
        }
      }
    }
  }
  return errors;
}

/**
 * Validate a whole presentation content object.
 * @param {unknown} content
 * @returns {string[]} error messages (empty when valid).
 */
export function validatePresentationContent(content) {
  if (!isPlainObject(content)) return ["presentation content must be an object"];
  /** @type {string[]} */
  const errors = [...validateSize(content.size)];
  if (!Array.isArray(content.slideOrder)) errors.push("slideOrder must be an array");
  if (!isPlainObject(content.slides)) errors.push("slides must be an object");
  if (Array.isArray(content.slideOrder) && isPlainObject(content.slides)) {
    const seen = new Set();
    for (const id of content.slideOrder) {
      if (typeof id !== "string") {
        errors.push("slideOrder must hold string ids");
        continue;
      }
      if (seen.has(id)) errors.push(`slideOrder lists "${id}" twice`);
      seen.add(id);
      if (!content.slides[id]) errors.push(`slideOrder references missing slide "${id}"`);
    }
    for (const [id, slide] of Object.entries(content.slides)) {
      if (!seen.has(id)) errors.push(`slides["${id}"] is not in slideOrder`);
      if (isPlainObject(slide) && slide.id !== id) errors.push(`slides["${id}"].id does not match its key`);
      errors.push(...validateSlide(slide).map((m) => `slides["${id}"]: ${m}`));
    }
  }
  return errors;
}

/**
 * Make sure a presentation page has well-formed content (idempotent).
 * @param {PageEnvelope} page
 * @returns {PresentationContent}
 */
export function ensurePresentationContent(page) {
  const content = /** @type {PresentationContent | undefined} */ (page.content);
  if (!content || !isPlainObject(content.slides) || !Array.isArray(content.slideOrder)) {
    const fresh = createPresentationContent();
    page.content = /** @type {Record<string, unknown>} */ (fresh);
    return fresh;
  }
  if (!isPlainObject(content.size) || validateSize(content.size).length > 0) {
    content.size = { width: SLIDE_DEFAULTS.width, height: SLIDE_DEFAULTS.height };
  }
  for (const slide of Object.values(content.slides)) {
    if (!isPlainObject(slide.objects)) slide.objects = {};
    if (!Array.isArray(slide.objectOrder)) slide.objectOrder = Object.keys(slide.objects);
    if (!isPlainObject(slide.background)) slide.background = { color: SLIDE_DEFAULTS.background };
    if (!isPlainObject(slide.transition)) slide.transition = defaultTransition();
    if (!isPlainObject(slide.animations)) slide.animations = {};
    if (!Array.isArray(slide.animationOrder)) slide.animationOrder = Object.keys(slide.animations);
  }
  return content;
}
