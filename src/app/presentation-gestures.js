/**
 * Mouse gestures on the stage (move, resize, rotate, marquee, draw, motion path): each previews on the live DOM and dispatches one command on release.
 * State shared with the editor arrives through the `ed` kernel; the mutable parts live on `ed.st`.
 */

import { ANIM_MAX_OFFSET } from "../presentation/model.js";
import { centerOf, normalizeAngle, objectsInMarquee, rectFromPoints, resizeRect, rotatedBounds, rotationFrom, round, snapMove, unionBounds } from "../presentation/geometry.js";
import { DRAG_THRESHOLD, GRID_SIZE, ROTATE_STEP, closest } from "./presentation-dom.js";

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
export function createPresentationGestures(ed) {
  const { afterStateChange, clearPreview, createFromTool, defaultBox, finishEdit, gestureScope, getSelectedObjects, getSize, getSlide, inspector, patchObjects, popovers, preview, previewObject, renderOverlay, renderStage, selectObjects, st, stageArea, stopPreview, updateAnimation, view } = ed;

  /**
   * Convert viewport coordinates into slide coordinates.
   * @param {number} clientX
   * @param {number} clientY
   */
  function toSlide(clientX, clientY) {
    const size = getSize();
    const rect = st.stage ? st.stage.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const sx = rect.width / size.width || 1;
    const sy = rect.height / size.height || 1;
    return { x: (clientX - rect.left) / sx, y: (clientY - rect.top) / sy };
  }

  /** @param {MouseEvent} event */
  function onMouseDown(event) {
    if (event.button !== 0) return;
    const target = /** @type {Element} */ (event.target);
    if (st.editing && st.editing.host.contains(target)) return;
    if (closest(target, ".stage-empty")) return;
    if (st.previewHandle) {
      event.preventDefault();
      stopPreview();
      return;
    }
    if (closest(target, "[data-role=reference-handle]")) return;
    if (st.editing) finishEdit(true);

    // Pointer-down on the stage never starts a native text selection or drag.
    event.preventDefault();
    stageArea.focus();
    popovers.close();

    const point = toSlide(event.clientX, event.clientY);
    const slide = getSlide();
    if (!slide || !st.stage) return;

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
    if (st.tool && inStage) {
      st.gesture = { type: "draw", tool: st.tool, start: point, startClient: { x: event.clientX, y: event.clientY } };
      startDocumentListeners();
      return;
    }

    const objectEl = closest(target, ".slide-object");
    const id = objectEl ? /** @type {HTMLElement} */ (objectEl).dataset.objectId : undefined;
    if (id && slide.objects[id]) {
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      let collapseTo = null;
      if (additive) {
        st.selectedIds = st.selectedIds.includes(id) ? st.selectedIds.filter((s) => s !== id) : [...st.selectedIds, id];
        afterStateChange();
        if (!st.selectedIds.includes(id)) return;
      } else if (!st.selectedIds.includes(id)) {
        st.selectedIds = [id];
        afterStateChange();
      } else if (st.selectedIds.length > 1) {
        collapseTo = id;
      }
      beginMove(point, event, collapseTo);
      return;
    }

    if (inStage) {
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const base = additive ? [...st.selectedIds] : [];
      if (!additive && st.selectedIds.length > 0) {
        st.selectedIds = [];
        afterStateChange();
      }
      st.gesture = { type: "marquee", start: point, base, moved: false, startClient: { x: event.clientX, y: event.clientY } };
      startDocumentListeners();
      return;
    }

    if (st.selectedIds.length > 0) {
      st.selectedIds = [];
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
    st.gesture = {
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
    if (!object || st.selectedIds.length !== 1) return;
    const common = { start: point, startClient: { x: event.clientX, y: event.clientY }, id: object.id, object: { ...object }, moved: false, hideHandles: false };
    if (name === "rotate") {
      const center = centerOf(object);
      const offset = object.rotation - rotationFrom(center, point);
      st.gesture = { type: "rotate", ...common, center, offset };
    } else {
      st.gesture = { type: "resize", ...common, handle: name };
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
    st.gesture = {
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
    stopDocumentListeners();
    st.gestureStops = [gestureScope.listen("mousemove", onMouseMove), gestureScope.listen("mouseup", onMouseUp)];
  }

  function stopDocumentListeners() {
    for (const stop of st.gestureStops) stop();
    st.gestureStops = [];
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
    if (!st.gesture) return;
    const slide = getSlide();
    if (!slide) return;
    const point = toSlide(event.clientX, event.clientY);
    const size = getSize();

    if (st.gesture.type === "move") {
      if (!st.gesture.moved && !pastThreshold(st.gesture.startClient, event)) return;
      st.gesture.moved = true;
      let dx = point.x - st.gesture.start.x;
      let dy = point.y - st.gesture.start.y;
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      let guides = [];
      if (!event.altKey && (view.snap || view.grid)) {
        const moving = { x: st.gesture.bounds.x + dx, y: st.gesture.bounds.y + dy, width: st.gesture.bounds.width, height: st.gesture.bounds.height };
        const others = view.snap
          ? slide.objectOrder.filter((id) => !st.gesture.ids.includes(id)).map((id) => rotatedBounds(slide.objects[id]))
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
      for (const id of st.gesture.ids) {
        const origin = st.gesture.origin.get(id);
        previewObject(id, { x: round(origin.x + dx, 0), y: round(origin.y + dy, 0) });
      }
      st.gesture.hideHandles = true;
      renderOverlay();
    } else if (st.gesture.type === "resize") {
      if (!st.gesture.moved && !pastThreshold(st.gesture.startClient, event)) return;
      st.gesture.moved = true;
      const object = st.gesture.object;
      const rect = resizeRect(object, object.rotation, st.gesture.handle, { x: point.x - st.gesture.start.x, y: point.y - st.gesture.start.y }, {
        keepAspect: event.shiftKey || object.type === "image",
        fromCenter: event.altKey,
        minWidth: object.type === "line" ? 0 : 8,
        minHeight: object.type === "line" ? 0 : 8
      });
      previewObject(st.gesture.id, whole(rect));
      renderOverlay();
    } else if (st.gesture.type === "rotate") {
      if (!st.gesture.moved && !pastThreshold(st.gesture.startClient, event)) return;
      st.gesture.moved = true;
      let degrees = normalizeAngle(rotationFrom(st.gesture.center, point) + st.gesture.offset);
      if (event.shiftKey) degrees = normalizeAngle(Math.round(degrees / ROTATE_STEP) * ROTATE_STEP);
      previewObject(st.gesture.id, { rotation: Math.round(degrees) % 360 });
      renderOverlay();
    } else if (st.gesture.type === "path") {
      if (!st.gesture.moved && !pastThreshold(st.gesture.startClient, event)) return;
      st.gesture.moved = true;
      const clampOffset = (/** @type {number} */ n) => Math.max(-ANIM_MAX_OFFSET, Math.min(ANIM_MAX_OFFSET, round(n, 0)));
      const origin = st.gesture.path[st.gesture.which];
      const next = { ...st.gesture.path, [st.gesture.which]: { x: clampOffset(origin.x + point.x - st.gesture.start.x), y: clampOffset(origin.y + point.y - st.gesture.start.y) } };
      preview.path = { animationId: st.gesture.animationId, from: next.from, to: next.to };
      renderOverlay();
    } else if (st.gesture.type === "marquee") {
      if (!st.gesture.moved && !pastThreshold(st.gesture.startClient, event)) return;
      st.gesture.moved = true;
      const rect = rectFromPoints(st.gesture.start, point);
      preview.marquee = rect;
      const hit = objectsInMarquee(slide, rect);
      st.selectedIds = slide.objectOrder.filter((id) => st.gesture.base.includes(id) || hit.includes(id));
      renderOverlay();
      inspector.render();
    } else if (st.gesture.type === "draw") {
      const clamp = (/** @type {{ x: number, y: number }} */ p) => ({
        x: Math.max(0, Math.min(size.width, p.x)),
        y: Math.max(0, Math.min(size.height, p.y))
      });
      st.gesture.end = clamp(point);
      if (!st.gesture.moved && !pastThreshold(st.gesture.startClient, event)) return;
      st.gesture.moved = true;
      preview.draw = { tool: st.gesture.tool, rect: whole(rectFromPoints(clamp(st.gesture.start), st.gesture.end)) };
      renderOverlay();
    }
  }

  /** @param {MouseEvent} _event */
  function onMouseUp(_event) {
    const active = st.gesture;
    if (!active) return;
    stopDocumentListeners();
    st.gesture = null;
    const slideId = st.currentSlideId;
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
    if (!st.gesture) return;
    stopDocumentListeners();
    const wasMarquee = st.gesture.type === "marquee";
    st.gesture = null;
    clearPreview();
    renderStage();
    if (wasMarquee) st.selectedIds = [];
    afterStateChange();
  }

  return { toSlide, onMouseDown, beginMove, beginHandleGesture, beginPathGesture, startDocumentListeners, stopDocumentListeners, pastThreshold, whole, onMouseMove, onMouseUp, cancelGesture };
}
