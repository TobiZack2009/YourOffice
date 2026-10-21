/**
 * Presentation commands (spec §7).
 *
 * Every mutation is a validated command run inside a transaction, so undo/redo
 * works through the workspace history. Slide and object ids are stable: moving a
 * slide or restacking an object changes `slideOrder` / `objectOrder`, never an id.
 *
 * Registered with `registerPresentationCommands(store)` so the workspace layer
 * stays independent of the presentation editor.
 */

import { CommandError } from "../core/errors.js";
import { createId } from "../core/ids.js";
import { validateRuns } from "../document/model.js";
import { touchPage } from "../workspace/commands.js";
import { scaleObject } from "./geometry.js";
import { DEFAULT_LAYOUT, getLayout } from "./layouts.js";
import {
  ANIMATION_DEFAULTS,
  SIZE_LIMITS,
  TRANSITION_DIRECTIONS,
  TRANSITION_STYLES,
  createAnimation,
  createSlide,
  createTextBody,
  ensurePresentationContent,
  isColor,
  validateAnimation,
  validateObject,
  validateSize
} from "./model.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../workspace/store.js").Transaction} Transaction */
/** @typedef {import("./model.js").PresentationContent} PresentationContent */
/** @typedef {import("./model.js").Slide} Slide */
/** @typedef {import("./model.js").SlideObject} SlideObject */
/** @typedef {import("./model.js").Animation} Animation */

/** How far pasted/duplicated objects are nudged so they do not hide their source. */
const COPY_OFFSET = 24;

/** Fields `updateObject` may change; identity and type are never patchable. */
const PATCHABLE = new Set([
  "x", "y", "width", "height", "rotation", "name", "link", "fill", "stroke", "shape", "flipV", "text", "src", "autoHeight"
]);

/**
 * @param {unknown} value
 * @param {string} field
 * @param {string} reason
 * @returns {string}
 */
function requireString(value, field, reason) {
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandError(`${field} must be a non-empty string`, reason);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function requireInsertIndex(value, field) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 0) {
    throw new CommandError(`${field} must be a non-negative integer`, "invalidIndex");
  }
  return /** @type {number} */ (value);
}

/**
 * @param {Workspace} store
 * @param {unknown} pageId
 * @returns {{ page: import("../workspace/schema.js").PageEnvelope, content: PresentationContent }}
 */
function requirePresentationPage(store, pageId) {
  const id = requireString(pageId, "pageId", "invalidPage");
  const page = /** @type {import("../workspace/schema.js").PageEnvelope | undefined} */ (
    store._data.pages[id] ?? store._data.detached?.[id]
  );
  if (!page) throw new CommandError(`page does not exist: ${id}`, "unknownPage");
  if (page.type !== "presentation") {
    throw new CommandError(`page ${id} is not a presentation page`, "wrongPageType");
  }
  return { page, content: ensurePresentationContent(page) };
}

/**
 * @param {PresentationContent} content
 * @param {unknown} slideId
 * @returns {Slide}
 */
function requireSlide(content, slideId) {
  const id = requireString(slideId, "slideId", "invalidSlide");
  const slide = content.slides[id];
  if (!slide) throw new CommandError(`slide does not exist: ${id}`, "unknownSlide");
  return slide;
}

/**
 * @param {Slide} slide
 * @param {unknown} objectId
 * @returns {SlideObject}
 */
function requireObject(slide, objectId) {
  const id = requireString(objectId, "objectId", "invalidObject");
  const object = slide.objects[id];
  if (!object) throw new CommandError(`object does not exist: ${id}`, "unknownObject");
  return object;
}

/**
 * A non-empty list of existing object ids, without duplicates.
 * @param {Slide} slide
 * @param {unknown} ids
 * @returns {string[]}
 */
function requireObjectIds(slide, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new CommandError("objectIds must be a non-empty array", "invalidObject");
  }
  for (const id of ids) requireObject(slide, id);
  return [...new Set(/** @type {string[]} */ (ids))];
}

/** Fields `updateAnimation` may change; identity and the target object are never patchable. */
const ANIMATION_PATCHABLE = new Set(["effect", "trigger", "delay", "duration", "direction", "path"]);

/**
 * @param {Slide} slide
 * @param {unknown} animationId
 * @returns {Animation}
 */
function requireAnimation(slide, animationId) {
  const id = requireString(animationId, "animationId", "invalidAnimation");
  const animation = slide.animations[id];
  if (!animation) throw new CommandError(`animation does not exist: ${id}`, "unknownAnimation");
  return animation;
}

/**
 * Apply a whitelisted patch to an animation. Switching effect swaps the
 * effect-specific fields (direction for slide-in, path for motion), then the
 * result is validated.
 * @param {Animation} animation
 * @param {unknown} patch
 */
function applyAnimationPatch(animation, patch) {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new CommandError("patch must be an object", "invalidPatch");
  }
  const p = /** @type {Record<string, unknown>} */ (patch);
  for (const key of Object.keys(p)) {
    if (!ANIMATION_PATCHABLE.has(key)) throw new CommandError(`"${key}" cannot be changed`, "invalidPatch");
  }
  const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (animation));
  for (const [key, value] of Object.entries(p)) target[key] = typeof value === "object" ? structuredClone(value) : value;

  if (animation.effect === "slide-in") {
    if (animation.direction === undefined) animation.direction = /** @type {"left"} */ (ANIMATION_DEFAULTS.direction);
  } else {
    delete animation.direction;
  }
  if (animation.effect === "motion") {
    if (animation.path === undefined) animation.path = structuredClone(ANIMATION_DEFAULTS.path);
  } else {
    delete animation.path;
  }
  const errors = validateAnimation(animation);
  if (errors.length > 0) throw new CommandError(`invalid animation: ${errors.join("; ")}`, "invalidAnimation");
}

/**
 * Append a validated object to a slide.
 * @param {Slide} slide
 * @param {SlideObject} object
 * @param {number} [index] Position in the z-order (defaults to the top).
 */
function addObject(slide, object, index) {
  const errors = validateObject(object);
  if (errors.length > 0) throw new CommandError(`invalid object: ${errors.join("; ")}`, "invalidObject");
  if (slide.objects[object.id]) throw new CommandError(`object id already in use: ${object.id}`, "duplicateObject");
  slide.objects[object.id] = object;
  const at = index === undefined ? slide.objectOrder.length : Math.min(index, slide.objectOrder.length);
  slide.objectOrder.splice(at, 0, object.id);
}

/**
 * Deep-copy objects with fresh ids, nudged by an offset.
 * @param {SlideObject[]} objects
 * @param {unknown} newIds Optional ids to use (parallel to `objects`).
 * @param {number} offset
 * @returns {SlideObject[]}
 */
function cloneObjects(objects, newIds, offset) {
  if (newIds !== undefined && (!Array.isArray(newIds) || newIds.length !== objects.length)) {
    throw new CommandError("newIds must match the number of objects", "invalidObject");
  }
  return objects.map((object, i) => {
    const copy = structuredClone(object);
    copy.id = newIds ? requireString(/** @type {string[]} */ (newIds)[i], "newIds", "invalidObject") : createId("obj");
    copy.x = Math.round((copy.x + offset) * 100) / 100;
    copy.y = Math.round((copy.y + offset) * 100) / 100;
    return copy;
  });
}

/**
 * Apply a whitelisted patch to an object, then validate the result.
 * @param {SlideObject} object
 * @param {unknown} patch
 */
function applyPatch(object, patch) {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new CommandError("patch must be an object", "invalidPatch");
  }
  const p = /** @type {Record<string, unknown>} */ (patch);
  for (const key of Object.keys(p)) {
    if (!PATCHABLE.has(key)) throw new CommandError(`"${key}" cannot be changed`, "invalidPatch");
  }
  const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (object));
  for (const [key, value] of Object.entries(p)) {
    if (key === "text") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new CommandError("text patch must be an object", "invalidPatch");
      }
      const base = object.text ?? createTextBody({ align: "center", valign: "middle" });
      object.text = { ...base, ...structuredClone(/** @type {Partial<import("./model.js").TextBody>} */ (value)) };
    } else if (value === null && (key === "link" || key === "name")) {
      delete target[key];
    } else if (key === "stroke" || key === "fill") {
      target[key] = structuredClone(value);
    } else {
      target[key] = typeof value === "object" ? structuredClone(value) : value;
    }
  }
  const errors = validateObject(object);
  if (errors.length > 0) throw new CommandError(`invalid object: ${errors.join("; ")}`, "invalidObject");
}

/**
 * Move the chosen ids through the z-order.
 * @param {string[]} order Bottom to top.
 * @param {Set<string>} chosen
 * @param {"front" | "forward" | "backward" | "back"} op
 * @returns {string[]}
 */
function reorder(order, chosen, op) {
  const next = [...order];
  if (op === "front") return [...next.filter((id) => !chosen.has(id)), ...next.filter((id) => chosen.has(id))];
  if (op === "back") return [...next.filter((id) => chosen.has(id)), ...next.filter((id) => !chosen.has(id))];
  if (op === "forward") {
    for (let i = next.length - 2; i >= 0; i--) {
      if (chosen.has(next[i]) && !chosen.has(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]];
    }
  } else {
    for (let i = 1; i < next.length; i++) {
      if (chosen.has(next[i]) && !chosen.has(next[i - 1])) [next[i], next[i - 1]] = [next[i - 1], next[i]];
    }
  }
  return next;
}

/** @type {Record<string, (store: Workspace, tx: Transaction, payload: any) => void>} */
export const presentationCommands = {
  /**
   * Set the one logical size shared by every slide, optionally scaling content.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, width: number, height: number, scaleContent?: boolean }} payload
   */
  setSlideSize(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const size = { width: Math.round(Number(p.width)), height: Math.round(Number(p.height)) };
    const errors = validateSize(size);
    if (errors.length > 0) {
      throw new CommandError(
        `slide size must be ${SIZE_LIMITS.min}–${SIZE_LIMITS.max} in each dimension`,
        "invalidSize"
      );
    }
    if (size.width === content.size.width && size.height === content.size.height) return;

    if (p.scaleContent === true) {
      const sx = size.width / content.size.width;
      const sy = size.height / content.size.height;
      for (const slide of Object.values(content.slides)) {
        for (const id of slide.objectOrder) slide.objects[id] = scaleObject(slide.objects[id], sx, sy);
        for (const animation of Object.values(slide.animations ?? {})) {
          if (!animation.path) continue;
          for (const point of [animation.path.from, animation.path.to]) {
            point.x = Math.round(point.x * sx * 100) / 100;
            point.y = Math.round(point.y * sy * 100) / 100;
          }
        }
      }
    }
    content.size = size;
    touchPage(tx, page);
  },

  /**
   * Add a slide, pre-populated from a layout.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, layout?: string, index?: number, slideId?: string }} payload
   */
  createSlide(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const layoutId = p.layout === undefined ? DEFAULT_LAYOUT : requireString(p.layout, "layout", "invalidLayout");
    const layout = getLayout(layoutId);
    if (!layout) throw new CommandError(`unknown layout: ${layoutId}`, "invalidLayout");
    const index = p.index === undefined ? content.slideOrder.length : requireInsertIndex(p.index, "index");
    if (index > content.slideOrder.length) throw new CommandError("index is out of range", "invalidIndex");

    const slide = createSlide({
      ...(p.slideId !== undefined ? { id: requireString(p.slideId, "slideId", "invalidSlide") } : {}),
      layout: layout.id,
      objects: layout.objects(content.size)
    });
    if (content.slides[slide.id]) throw new CommandError(`slide id already in use: ${slide.id}`, "duplicateSlide");
    content.slides[slide.id] = slide;
    content.slideOrder.splice(index, 0, slide.id);
    touchPage(tx, page);
    return { slideId: slide.id };
  },

  /**
   * Copy a slide (fresh object ids) to just after the original.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, newSlideId?: string }} payload
   */
  duplicateSlide(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const source = requireSlide(content, p.slideId);
    const copy = structuredClone(source);
    copy.id = p.newSlideId === undefined ? createId("slide") : requireString(p.newSlideId, "newSlideId", "invalidSlide");
    if (content.slides[copy.id]) throw new CommandError(`slide id already in use: ${copy.id}`, "duplicateSlide");
    /** @type {Record<string, SlideObject>} */
    const objects = {};
    /** @type {Map<string, string>} */
    const idMap = new Map();
    copy.objectOrder = copy.objectOrder.map((oldId) => {
      const object = copy.objects[oldId];
      object.id = createId("obj");
      idMap.set(oldId, object.id);
      objects[object.id] = object;
      return object.id;
    });
    copy.objects = objects;
    // Animations follow their objects to the new ids and get ids of their own.
    /** @type {Record<string, Animation>} */
    const animations = {};
    copy.animationOrder = (copy.animationOrder ?? []).map((oldId) => {
      const animation = copy.animations[oldId];
      animation.id = createId("anim");
      animation.objectId = /** @type {string} */ (idMap.get(animation.objectId));
      animations[animation.id] = animation;
      return animation.id;
    });
    copy.animations = animations;
    content.slides[copy.id] = copy;
    content.slideOrder.splice(content.slideOrder.indexOf(source.id) + 1, 0, copy.id);
    touchPage(tx, page);
    return { slideId: copy.id };
  },

  /**
   * Delete a slide, or several at once with `slideIds` (one command, so the sections that
   * read them see a single change). The last slide cannot be deleted. Links to it are cleared.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId?: string, slideIds?: string[] }} payload
   */
  deleteSlide(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const ids = Array.isArray(p.slideIds) ? [...new Set(p.slideIds)] : [p.slideId];
    const doomed = new Set(ids.map((id) => requireSlide(content, id).id));
    if (content.slideOrder.length - doomed.size < 1) {
      throw new CommandError("a presentation needs at least one slide", "lastSlide");
    }
    for (const id of doomed) delete content.slides[id];
    content.slideOrder = content.slideOrder.filter((id) => !doomed.has(id));
    for (const other of Object.values(content.slides)) {
      for (const object of Object.values(other.objects)) {
        if (object.link?.kind === "slide" && doomed.has(object.link.slideId)) delete object.link;
      }
    }
    touchPage(tx, page);
  },

  /**
   * Move a slide to an index (position once the slide is lifted out of the order).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, index: number }} payload
   */
  moveSlide(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    const index = requireInsertIndex(p.index, "index");
    const rest = content.slideOrder.filter((id) => id !== slide.id);
    if (index > rest.length) throw new CommandError("index is out of range", "invalidIndex");
    rest.splice(index, 0, slide.id);
    if (rest.every((id, i) => id === content.slideOrder[i])) return;
    content.slideOrder = rest;
    touchPage(tx, page);
  },

  /**
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, color: string }} payload
   */
  setSlideBackground(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    if (!isColor(p.color)) throw new CommandError("color must be a hex colour", "invalidColor");
    if (slide.background.color === p.color) return;
    slide.background = { color: /** @type {string} */ (p.color) };
    touchPage(tx, page, slide.id);
  },

  /**
   * Change some or all of a slide's transition (style, direction, duration).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, transition: Partial<import("./model.js").Transition> }} payload
   */
  setSlideTransition(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    const t = /** @type {Record<string, unknown>} */ (p.transition ?? {});
    if (t.style !== undefined && !TRANSITION_STYLES.includes(/** @type {string} */ (t.style))) {
      throw new CommandError("unknown transition style", "invalidTransition");
    }
    if (t.direction !== undefined && !TRANSITION_DIRECTIONS.includes(/** @type {string} */ (t.direction))) {
      throw new CommandError("unknown transition direction", "invalidTransition");
    }
    if (t.duration !== undefined && !(typeof t.duration === "number" && t.duration >= 0 && t.duration <= 10000)) {
      throw new CommandError("duration must be 0–10000 ms", "invalidTransition");
    }
    slide.transition = { ...slide.transition, ...t };
    touchPage(tx, page, slide.id);
  },

  /**
   * Copy one slide's transition to every slide.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string }} payload
   */
  applyTransitionToAll(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const source = requireSlide(content, p.slideId);
    for (const slide of Object.values(content.slides)) slide.transition = { ...source.transition };
    touchPage(tx, page);
  },

  /**
   * Add an object to a slide (on top unless `index` is given).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, object: SlideObject, index?: number }} payload
   */
  insertObject(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    if (typeof p.object !== "object" || p.object === null) {
      throw new CommandError("object must be an object", "invalidObject");
    }
    const index = p.index === undefined ? undefined : requireInsertIndex(p.index, "index");
    addObject(slide, structuredClone(/** @type {SlideObject} */ (p.object)), index);
    touchPage(tx, page, slide.id, /** @type {SlideObject} */ (p.object).id);
    return { objectId: /** @type {SlideObject} */ (p.object).id };
  },

  /**
   * Change fields of one object.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, objectId: string, patch: Record<string, unknown> }} payload
   */
  updateObject(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    applyPatch(requireObject(slide, p.objectId), p.patch);
    touchPage(tx, page, slide.id, /** @type {string} */ (p.objectId));
  },

  /**
   * Change several objects in one step (multi-move, multi-recolour).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, items: { objectId: string, patch: Record<string, unknown> }[] }} payload
   */
  updateObjects(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    if (!Array.isArray(p.items) || p.items.length === 0) {
      throw new CommandError("items must be a non-empty array", "invalidPatch");
    }
    for (const item of p.items) applyPatch(requireObject(slide, item?.objectId), item?.patch);
    touchPage(tx, page, slide.id, ...p.items.map((/** @type {{ objectId: string }} */ item) => item.objectId));
  },

  /**
   * Commit in-place text edits (the inline runs of a text object or a shape's label).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, objectId: string, runs: import("./model.js").TextBody["runs"] }} payload
   */
  setObjectRuns(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    const object = requireObject(slide, p.objectId);
    if (object.type !== "text" && object.type !== "shape") {
      throw new CommandError(`${object.type} objects cannot carry text`, "invalidObject");
    }
    const errors = validateRuns(p.runs);
    if (errors.length > 0) throw new CommandError(`invalid runs: ${errors.join("; ")}`, "invalidRuns");
    const runs = structuredClone(/** @type {import("./model.js").TextBody["runs"]} */ (p.runs));
    object.text = { ...(object.text ?? createTextBody({ align: "center", valign: "middle" })), runs };
    touchPage(tx, page, slide.id, object.id);
  },

  /**
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, objectIds: string[] }} payload
   */
  deleteObjects(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    const ids = new Set(requireObjectIds(slide, p.objectIds));
    for (const id of ids) delete slide.objects[id];
    slide.objectOrder = slide.objectOrder.filter((id) => !ids.has(id));
    for (const [animationId, animation] of Object.entries(slide.animations)) {
      if (ids.has(animation.objectId)) delete slide.animations[animationId];
    }
    slide.animationOrder = slide.animationOrder.filter((id) => slide.animations[id]);
    touchPage(tx, page, slide.id, ...ids);
  },

  /**
   * Copy objects on the same slide, offset, directly above the originals' stack.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, objectIds: string[], newIds?: string[], offset?: number }} payload
   */
  duplicateObjects(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    const ids = requireObjectIds(slide, p.objectIds);
    // Keep the originals' relative stacking.
    const ordered = slide.objectOrder.filter((id) => ids.includes(id));
    const copies = cloneObjects(
      ordered.map((id) => slide.objects[id]),
      p.newIds,
      typeof p.offset === "number" ? p.offset : COPY_OFFSET
    );
    for (const copy of copies) addObject(slide, copy);
    touchPage(tx, page, slide.id, ...copies.map((copy) => copy.id));
    return { objectIds: copies.map((copy) => copy.id) };
  },

  /**
   * Paste copied objects onto a slide with fresh ids (the editor's clipboard).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, objects: SlideObject[], newIds?: string[], offset?: number }} payload
   */
  pasteObjects(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    if (!Array.isArray(p.objects) || p.objects.length === 0) {
      throw new CommandError("objects must be a non-empty array", "invalidObject");
    }
    const copies = cloneObjects(
      /** @type {SlideObject[]} */ (p.objects),
      p.newIds,
      typeof p.offset === "number" ? p.offset : COPY_OFFSET
    );
    for (const copy of copies) addObject(slide, copy);
    touchPage(tx, page, slide.id, ...copies.map((copy) => copy.id));
    return { objectIds: copies.map((copy) => copy.id) };
  },

  /**
   * Add an animation to a slide (at the end of the playback order unless `index` is given).
   * Missing fields are filled from the effect's defaults.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, animation: Partial<Animation> & { objectId: string }, index?: number }} payload
   */
  addAnimation(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    if (typeof p.animation !== "object" || p.animation === null || Array.isArray(p.animation)) {
      throw new CommandError("animation must be an object", "invalidAnimation");
    }
    const input = /** @type {Partial<Animation> & { objectId: string }} */ (p.animation);
    requireObject(slide, input.objectId);
    const index = p.index === undefined ? slide.animationOrder.length : requireInsertIndex(p.index, "index");
    if (index > slide.animationOrder.length) throw new CommandError("index is out of range", "invalidIndex");
    const animation = createAnimation(input);
    const errors = validateAnimation(animation);
    if (errors.length > 0) throw new CommandError(`invalid animation: ${errors.join("; ")}`, "invalidAnimation");
    if (slide.animations[animation.id]) throw new CommandError(`animation id already in use: ${animation.id}`, "duplicateAnimation");
    slide.animations[animation.id] = animation;
    slide.animationOrder.splice(index, 0, animation.id);
    touchPage(tx, page, slide.id);
    return { animationId: animation.id };
  },

  /**
   * Change fields of one animation.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, animationId: string, patch: Record<string, unknown> }} payload
   */
  updateAnimation(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    applyAnimationPatch(requireAnimation(slide, p.animationId), p.patch);
    touchPage(tx, page, slide.id);
  },

  /**
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, animationId: string }} payload
   */
  deleteAnimation(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    const animation = requireAnimation(slide, p.animationId);
    delete slide.animations[animation.id];
    slide.animationOrder = slide.animationOrder.filter((id) => id !== animation.id);
    touchPage(tx, page, slide.id);
  },

  /**
   * Move an animation to an index (position once it is lifted out of the order).
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, animationId: string, index: number }} payload
   */
  moveAnimation(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    const animation = requireAnimation(slide, p.animationId);
    const index = requireInsertIndex(p.index, "index");
    const rest = slide.animationOrder.filter((id) => id !== animation.id);
    if (index > rest.length) throw new CommandError("index is out of range", "invalidIndex");
    rest.splice(index, 0, animation.id);
    if (rest.every((id, i) => id === slide.animationOrder[i])) return;
    slide.animationOrder = rest;
    touchPage(tx, page, slide.id);
  },

  /**
   * Restack objects: front, forward, backward or back.
   * @param {Workspace} store
   * @param {Transaction} tx
   * @param {{ pageId: string, slideId: string, objectIds: string[], op: "front" | "forward" | "backward" | "back" }} payload
   */
  reorderObjects(store, tx, payload) {
    const p = /** @type {Record<string, unknown>} */ (payload ?? {});
    const { page, content } = requirePresentationPage(store, p.pageId);
    const slide = requireSlide(content, p.slideId);
    const ids = requireObjectIds(slide, p.objectIds);
    if (!["front", "forward", "backward", "back"].includes(/** @type {string} */ (p.op))) {
      throw new CommandError("op must be front, forward, backward or back", "invalidOp");
    }
    const next = reorder(slide.objectOrder, new Set(ids), /** @type {"front"} */ (p.op));
    if (next.every((id, i) => id === slide.objectOrder[i])) return;
    slide.objectOrder = next;
    touchPage(tx, page, slide.id, ...ids);
  }
};

/** Commands that cannot add or remove structure others depend on; hooks skip their heavy checks for them. */
const PRESENTATION_HOT = new Set(["setObjectRuns", "updateObject", "updateObjects", "addAnimation", "updateAnimation", "deleteAnimation", "moveAnimation", "setSlideBackground", "setSlideTransition", "applyTransitionToAll"]);

/**
 * Wire presentation commands into a store.
 * @param {Workspace} store
 */
export function registerPresentationCommands(store) {
  for (const [type, handler] of Object.entries(presentationCommands)) {
    store.registerCommand(type, handler, { hot: PRESENTATION_HOT.has(type) });
  }
}
