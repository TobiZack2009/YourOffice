/**
 * Object commands of the presentation editor: geometry and style patches, arrange, copy and paste, the insert tool and images.
 * State shared with the editor arrives through the `ed` kernel; the mutable parts live on `ed.st`.
 */

import { OBJECT_DEFAULTS, createObject } from "../presentation/model.js";
import { createId } from "../core/ids.js";
import { round } from "../presentation/geometry.js";
import { readImageFile } from "./image-file.js";
import { DEFAULT_IMAGE_BOX, fillCapable, strokeCapable, textCapable } from "./presentation-dom.js";

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
export function createPresentationObjects(ed) {
  const { afterStateChange, finishEdit, getSelectedObjects, getSelectionBounds, getSize, imageInput, notify, options, run, send, st, startEdit } = ed;

  /** @param {{ objects: SlideObject[], pastes: number }} next */
  function setClipboard(next) {
    st.clipboard = next;
    options.onClipboardChange?.(structuredClone(next));
  }

  /**
   * @param {{ objectId: string, patch: Record<string, unknown> }[]} items
   */
  function patchObjects(items) {
    if (!st.currentSlideId || items.length === 0) return;
    finishEdit(true);
    if (items.length === 1) {
      const [item] = items;
      run(() => send("updateObject", { slideId: st.currentSlideId, ...item }));
    } else {
      run(() => send("updateObjects", { slideId: st.currentSlideId, items }));
    }
  }

  /** @param {Record<string, number>} patch x/y/width/height/rotation */
  function setGeometry(patch) {
    const objects = getSelectedObjects();
    if (objects.length === 0) return;
    if (objects.length === 1) {
      /** @type {Record<string, number>} */
      const clean = {};
      for (const key of ["x", "y", "width", "height", "rotation"]) {
        if (typeof patch[key] === "number" && Number.isFinite(patch[key])) clean[key] = round(patch[key]);
      }
      if (Object.keys(clean).length > 0) patchObjects([{ objectId: objects[0].id, patch: clean }]);
      return;
    }
    // Several objects move together; the union's top-left is what X/Y mean.
    const bounds = getSelectionBounds();
    if (!bounds) return;
    const dx = typeof patch.x === "number" ? patch.x - bounds.x : 0;
    const dy = typeof patch.y === "number" ? patch.y - bounds.y : 0;
    if (dx === 0 && dy === 0) return;
    patchObjects(objects.map((o) => ({ objectId: o.id, patch: { x: round(o.x + dx), y: round(o.y + dy) } })));
  }

  /** @param {string | null} color */
  function setFill(color) {
    patchObjects(getSelectedObjects().filter(fillCapable).map((o) => ({ objectId: o.id, patch: { fill: color } })));
  }

  /** @param {{ color?: string, width?: number } | null} spec */
  function setStroke(spec) {
    patchObjects(
      getSelectedObjects().filter(strokeCapable).map((o) => {
        if (spec === null) return { objectId: o.id, patch: { stroke: null } };
        const base = o.stroke ?? (o.type === "line" ? OBJECT_DEFAULTS.lineStroke : OBJECT_DEFAULTS.stroke);
        return { objectId: o.id, patch: { stroke: { ...base, ...spec } } };
      })
    );
  }

  /** @param {Record<string, unknown>} style fontSize / color / align / valign */
  function setTextStyle(style) {
    patchObjects(getSelectedObjects().filter(textCapable).map((o) => ({ objectId: o.id, patch: { text: style } })));
  }

  /** @param {"left" | "center" | "right"} align */
  function setAlign(align) {
    setTextStyle({ align });
  }

  /** @param {import("../presentation/model.js").ObjectLink | null} link */
  function setObjectLink(link) {
    patchObjects(getSelectedObjects().map((o) => ({ objectId: o.id, patch: { link } })));
  }

  /** @param {"front" | "forward" | "backward" | "back"} op */
  function arrange(op) {
    if (!st.currentSlideId || st.selectedIds.length === 0) return;
    finishEdit(true);
    run(() => send("reorderObjects", { slideId: st.currentSlideId, objectIds: [...st.selectedIds], op }));
  }

  function deleteSelected() {
    if (!st.currentSlideId || st.selectedIds.length === 0) return;
    finishEdit(false);
    const ids = [...st.selectedIds];
    st.selectedIds = [];
    run(() => send("deleteObjects", { slideId: st.currentSlideId, objectIds: ids }));
  }

  function duplicateSelected() {
    if (!st.currentSlideId || st.selectedIds.length === 0) return;
    finishEdit(true);
    const ordered = getSelectedObjects();
    const newIds = ordered.map(() => createId("obj"));
    st.selectedIds = [...newIds];
    run(() => send("duplicateObjects", { slideId: st.currentSlideId, objectIds: ordered.map((o) => o.id), newIds }));
  }

  function copySelected() {
    const objects = getSelectedObjects();
    if (objects.length === 0) return false;
    setClipboard({ objects: structuredClone(objects), pastes: 0 });
    options.onSelectionChange?.();
    return true;
  }

  function cutSelected() {
    if (copySelected()) deleteSelected();
  }

  const canPaste = () => st.clipboard.objects.length > 0;

  function pasteObjects() {
    if (!st.currentSlideId || !canPaste()) return;
    finishEdit(true);
    setClipboard({ objects: st.clipboard.objects, pastes: st.clipboard.pastes + 1 });
    const newIds = st.clipboard.objects.map(() => createId("obj"));
    st.selectedIds = [...newIds];
    run(() => send("pasteObjects", {
      slideId: st.currentSlideId,
      objects: structuredClone(st.clipboard.objects),
      newIds,
      offset: 24 * st.clipboard.pastes
    }));
  }

  /** @param {Tool | null} next */
  function setTool(next) {
    if (next && !st.currentSlideId) return;
    finishEdit(true);
    st.tool = next;
    afterStateChange();
  }

  const getTool = () => st.tool;

  /**
   * Insert a finished object, select it and drop the tool.
   * @param {SlideObject} object
   * @param {{ edit?: boolean }} [opts]
   */
  function insertObject(object, opts = {}) {
    if (!st.currentSlideId) return;
    finishEdit(true);
    st.selectedIds = [object.id];
    st.tool = null;
    const ok = run(() => send("insertObject", { slideId: st.currentSlideId, object }));
    if (ok && opts.edit) startEdit(object.id);
  }

  /**
   * @param {Tool} drawTool
   * @param {Rect} rect
   * @param {boolean} flipV
   */
  function createFromTool(drawTool, rect, flipV) {
    const size = getSize();
    /** @type {SlideObject} */
    let object;
    if (drawTool.type === "line") {
      object = createObject("line", { x: rect.x, y: rect.y, width: rect.width, height: rect.height, flipV });
    } else if (drawTool.type === "text") {
      object = createObject("text", { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    } else {
      object = createObject("shape", { x: rect.x, y: rect.y, width: rect.width, height: rect.height, shape: /** @type {any} */ (drawTool.shape) });
    }
    object.x = Math.max(0, Math.min(size.width - 1, object.x));
    object.y = Math.max(0, Math.min(size.height - 1, object.y));
    insertObject(object, { edit: drawTool.type === "text" });
  }

  /** The default box for a click (no drag), centred on the click and kept on the slide. */
  function defaultBox(/** @type {Tool} */ drawTool, /** @type {{ x: number, y: number }} */ at) {
    const size = getSize();
    const base = createObject(drawTool.type === "line" ? "line" : drawTool.type === "text" ? "text" : "shape");
    const width = base.width;
    const height = base.height;
    return {
      x: round(Math.max(0, Math.min(size.width - width, at.x - width / 2)), 0),
      y: round(Math.max(0, Math.min(size.height - height, at.y - height / 2)), 0),
      width,
      height
    };
  }

  /**
   * Store an image in the asset registry and add it to the slide, fitted inside it and centred.
   * Both happen in one transaction, so one undo removes the image.
   * @param {{ mimeType: string, name: string, data: string }} image
   * @param {{ width?: number, height?: number }} [natural]
   */
  function insertImage(image, natural = {}) {
    if (!st.currentSlideId) return;
    const size = getSize();
    const nw = natural.width && natural.width > 0 ? natural.width : DEFAULT_IMAGE_BOX.width;
    const nh = natural.height && natural.height > 0 ? natural.height : DEFAULT_IMAGE_BOX.height;
    const fit = Math.min(1, (size.width * 0.6) / nw, (size.height * 0.6) / nh);
    const width = Math.max(8, Math.round(nw * fit));
    const height = Math.max(8, Math.round(nh * fit));
    run(() => ed.workspace.transact("Insert image", () => {
      const { assetId } = /** @type {{ assetId: string }} */ (ed.workspace.dispatch("addAsset", image));
      insertObject(createObject("image", {
        assetId,
        width,
        height,
        x: Math.round((size.width - width) / 2),
        y: Math.round((size.height - height) / 2)
      }));
    }));
  }

  function pickImage() {
    if (!st.currentSlideId) return;
    imageInput.value = "";
    imageInput.click();
  }

  imageInput.addEventListener("change", () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    readImageFile(file).then(
      (image) => insertImage(image, { width: image.width, height: image.height }),
      (error) => notify(error.message)
    );
  });

  return { setClipboard, patchObjects, setGeometry, setFill, setStroke, setTextStyle, setAlign, setObjectLink, arrange, deleteSelected, duplicateSelected, copySelected, cutSelected, canPaste, pasteObjects, setTool, getTool, insertObject, createFromTool, defaultBox, insertImage, pickImage };
}
