/**
 * Slide geometry: pure functions in logical slide pixels, no DOM.
 *
 * Rotation is in degrees, clockwise, about the object's centre (the same as CSS
 * `rotate`), and y grows downward.
 */

import { MAX_FONT_SIZE, MIN_FONT_SIZE } from "./model.js";

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {"n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"} Handle */

export const HANDLES = /** @type {Handle[]} */ (["nw", "n", "ne", "e", "se", "s", "sw", "w"]);

export const SIZE_PRESETS = [
  { id: "16:9", label: "Widescreen (16:9)", width: 1280, height: 720 },
  { id: "4:3", label: "Standard (4:3)", width: 1024, height: 768 },
  { id: "16:10", label: "Widescreen (16:10)", width: 1280, height: 800 }
];

/** @param {number} value @param {number} [digits] */
export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * @param {number} degrees
 * @returns {number} the angle in [0, 360)
 */
export function normalizeAngle(degrees) {
  const wrapped = degrees % 360;
  return round(wrapped < 0 ? wrapped + 360 : wrapped);
}

/**
 * @param {Rect} rect
 * @returns {{ x: number, y: number }}
 */
export function centerOf(rect) {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/**
 * The four corners of a (possibly rotated) rectangle, clockwise from top-left.
 * @param {Rect & { rotation?: number }} object
 * @returns {{ x: number, y: number }[]}
 */
export function rectCorners(object) {
  const c = centerOf(object);
  const angle = ((object.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hw = object.width / 2;
  const hh = object.height / 2;
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh]
  ].map(([lx, ly]) => ({ x: c.x + lx * cos - ly * sin, y: c.y + lx * sin + ly * cos }));
}

/**
 * Axis-aligned bounds of a rotated rectangle.
 * @param {Rect & { rotation?: number }} object
 * @returns {Rect}
 */
export function rotatedBounds(object) {
  if (!object.rotation) {
    return { x: object.x, y: object.y, width: object.width, height: object.height };
  }
  const corners = rectCorners(object);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Smallest rectangle containing every rect.
 * @param {Rect[]} rects
 * @returns {Rect | null}
 */
export function unionBounds(rects) {
  if (rects.length === 0) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.width));
  const y2 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Rectangle spanned by two points, in any drag direction.
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 * @returns {Rect}
 */
export function rectFromPoints(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

/**
 * @param {Rect} a
 * @param {Rect} b
 * @returns {boolean}
 */
export function rectsIntersect(a, b) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

/**
 * Resize a rectangle by dragging one of its handles, in the object's own
 * (rotated) axes. The edge opposite the handle stays where it is on the slide.
 *
 * @param {Rect} rect
 * @param {number} rotation Degrees.
 * @param {Handle} handle
 * @param {{ x: number, y: number }} delta Pointer movement in slide pixels.
 * @param {{ keepAspect?: boolean, fromCenter?: boolean, minWidth?: number, minHeight?: number }} [options]
 * @returns {Rect}
 */
export function resizeRect(rect, rotation, handle, delta, options = {}) {
  const minWidth = options.minWidth ?? 4;
  const minHeight = options.minHeight ?? 4;
  const angle = (rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Pointer movement expressed along the object's own axes.
  const dx = delta.x * cos + delta.y * sin;
  const dy = -delta.x * sin + delta.y * cos;

  const movesE = handle.includes("e");
  const movesW = handle.includes("w");
  const movesS = handle.includes("s");
  const movesN = handle.includes("n");

  const hw = rect.width / 2;
  const hh = rect.height / 2;
  let left = -hw;
  let right = hw;
  let top = -hh;
  let bottom = hh;

  if (options.fromCenter) {
    if (movesE) { right += dx; left -= dx; }
    if (movesW) { left += dx; right -= dx; }
    if (movesS) { bottom += dy; top -= dy; }
    if (movesN) { top += dy; bottom -= dy; }
  } else {
    if (movesE) right += dx;
    if (movesW) left += dx;
    if (movesS) bottom += dy;
    if (movesN) top += dy;
  }

  let width = Math.max(minWidth, right - left);
  let height = Math.max(minHeight, bottom - top);

  if (options.keepAspect && rect.width > 0 && rect.height > 0) {
    const ratio = rect.width / rect.height;
    const corner = (movesE || movesW) && (movesS || movesN);
    if (corner) {
      // The dominant relative change wins, so the corner follows the pointer.
      const scaleW = width / rect.width;
      const scaleH = height / rect.height;
      const scale = Math.abs(scaleW - 1) >= Math.abs(scaleH - 1) ? scaleW : scaleH;
      width = Math.max(minWidth, rect.width * scale);
      height = Math.max(minHeight, width / ratio);
      width = height * ratio;
    } else if (movesE || movesW) {
      height = Math.max(minHeight, width / ratio);
    } else {
      width = Math.max(minWidth, height * ratio);
    }
  }

  // Place the box so the fixed edge stays put (or the centre, when fromCenter).
  let cx = 0;
  let cy = 0;
  if (!options.fromCenter) {
    if (movesE) cx = -hw + width / 2;
    else if (movesW) cx = hw - width / 2;
    if (movesS) cy = -hh + height / 2;
    else if (movesN) cy = hh - height / 2;
    // A purely horizontal handle keeps the vertical centre (and vice versa) unless aspect locked.
    if (options.keepAspect) {
      if (!movesS && !movesN) cy = 0;
      if (!movesE && !movesW) cx = 0;
    }
  }

  const center = centerOf(rect);
  const gx = center.x + cx * cos - cy * sin;
  const gy = center.y + cx * sin + cy * cos;
  return {
    x: round(gx - width / 2),
    y: round(gy - height / 2),
    width: round(width),
    height: round(height)
  };
}

/**
 * Rotation for a pointer dragging the rotate handle (which sits straight above
 * the object, so a pointer directly above the centre is 0 degrees).
 * @param {{ x: number, y: number }} center
 * @param {{ x: number, y: number }} pointer
 * @param {{ snap?: boolean, step?: number }} [options]
 * @returns {number} degrees in [0, 360)
 */
export function rotationFrom(center, pointer, options = {}) {
  let degrees = (Math.atan2(pointer.y - center.y, pointer.x - center.x) * 180) / Math.PI + 90;
  if (options.snap) {
    const step = options.step ?? 15;
    degrees = Math.round(degrees / step) * step;
  }
  return normalizeAngle(degrees);
}

/**
 * @typedef {object} Guide
 * @property {"x" | "y"} axis "x": a vertical line at x = position.
 * @property {number} position
 * @property {number} start Extent of the line along the other axis.
 * @property {number} end
 */

/**
 * Snap a moving rectangle to the slide's edges and centre, to other objects'
 * edges and centres, and optionally to a grid.
 *
 * @param {Rect} moving Bounds of what is being dragged (before snapping).
 * @param {Rect[]} others Bounds of the objects to snap against.
 * @param {{ width: number, height: number }} slide
 * @param {{ threshold?: number, grid?: number }} [options] `grid`: spacing in px, 0 or absent for none.
 * @returns {{ dx: number, dy: number, guides: Guide[] }}
 */
export function snapMove(moving, others, slide, options = {}) {
  const threshold = options.threshold ?? 6;
  const grid = options.grid ?? 0;

  /** @type {Rect[]} */
  const targets = [{ x: 0, y: 0, width: slide.width, height: slide.height }, ...others];

  /**
   * Best offset along one axis.
   * @param {"x" | "y"} axis
   */
  function solve(axis) {
    const pos = axis === "x" ? moving.x : moving.y;
    const size = axis === "x" ? moving.width : moving.height;
    const candidates = [pos, pos + size / 2, pos + size];
    let best = null;
    for (const target of targets) {
      const tPos = axis === "x" ? target.x : target.y;
      const tSize = axis === "x" ? target.width : target.height;
      for (const t of [tPos, tPos + tSize / 2, tPos + tSize]) {
        for (const c of candidates) {
          const d = t - c;
          if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
        }
      }
    }
    if (best === null && grid > 0) {
      const snapped = Math.round(pos / grid) * grid;
      if (Math.abs(snapped - pos) <= threshold) best = snapped - pos;
    }
    return best ?? 0;
  }

  const dx = round(solve("x"));
  const dy = round(solve("y"));
  const snapped = { x: moving.x + dx, y: moving.y + dy, width: moving.width, height: moving.height };

  /** @type {Guide[]} */
  const guides = [];
  const eps = 0.01;
  for (const axis of /** @type {const} */ (["x", "y"])) {
    const size = axis === "x" ? snapped.width : snapped.height;
    const pos = axis === "x" ? snapped.x : snapped.y;
    const own = [pos, pos + size / 2, pos + size];
    const crossPos = axis === "x" ? snapped.y : snapped.x;
    const crossSize = axis === "x" ? snapped.height : snapped.width;
    const seen = new Set();
    for (const target of targets) {
      const tPos = axis === "x" ? target.x : target.y;
      const tSize = axis === "x" ? target.width : target.height;
      const tCrossPos = axis === "x" ? target.y : target.x;
      const tCrossSize = axis === "x" ? target.height : target.width;
      for (const t of [tPos, tPos + tSize / 2, tPos + tSize]) {
        if (!own.some((o) => Math.abs(o - t) < eps)) continue;
        const key = `${round(t)}`;
        const start = Math.min(crossPos, tCrossPos);
        const end = Math.max(crossPos + crossSize, tCrossPos + tCrossSize);
        if (seen.has(key)) {
          const existing = guides.find((g) => g.axis === axis && round(g.position) === round(t));
          if (existing) {
            existing.start = Math.min(existing.start, start);
            existing.end = Math.max(existing.end, end);
          }
          continue;
        }
        seen.add(key);
        guides.push({ axis, position: round(t), start, end });
      }
    }
  }
  return { dx, dy, guides };
}

/**
 * Ids of the objects a marquee rectangle touches, bottom to top.
 * @param {{ objectOrder: string[], objects: Record<string, Rect & { rotation?: number }> }} slide
 * @param {Rect} rect
 * @returns {string[]}
 */
export function objectsInMarquee(slide, rect) {
  return slide.objectOrder.filter((id) => {
    const object = slide.objects[id];
    return object ? rectsIntersect(rotatedBounds(object), rect) : false;
  });
}

/**
 * Where a dragged slide lands.
 * @param {string[]} order Current slide order.
 * @param {string} dragId
 * @param {{ type: "before" | "after", id: string }} target
 * @returns {{ index: number } | null} index in the order once the slide is lifted out
 *   (what `moveSlide` takes), or null when nothing would change or the input is invalid.
 */
export function planSlideReorder(order, dragId, target) {
  const from = order.indexOf(dragId);
  if (from === -1 || target.id === dragId) return null;
  const rest = order.filter((id) => id !== dragId);
  const at = rest.indexOf(target.id);
  if (at === -1) return null;
  const index = target.type === "before" ? at : at + 1;
  return index === from ? null : { index };
}

/**
 * Scale at which a slide fits inside an area.
 * @param {{ width: number, height: number }} available
 * @param {{ width: number, height: number }} slideSize
 * @returns {number}
 */
export function fitScale(available, slideSize) {
  if (!(available.width > 0) || !(available.height > 0)) return 1;
  return Math.min(available.width / slideSize.width, available.height / slideSize.height);
}

/**
 * Scale an object's geometry for a slide size change. Positions and sizes follow
 * the per-axis ratios; font size follows the smaller ratio so text never overflows
 * what it used to fit in. Rotation and stroke width are unchanged.
 * @param {import("./model.js").SlideObject} object
 * @param {number} sx
 * @param {number} sy
 * @returns {import("./model.js").SlideObject} a scaled deep copy
 */
export function scaleObject(object, sx, sy) {
  const copy = structuredClone(object);
  copy.x = round(copy.x * sx);
  copy.y = round(copy.y * sy);
  copy.width = round(copy.width * sx);
  copy.height = round(copy.height * sy);
  if (copy.text) {
    const scaled = round(copy.text.fontSize * Math.min(sx, sy), 1);
    copy.text.fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, scaled));
  }
  return copy;
}
