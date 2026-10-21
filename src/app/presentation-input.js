/**
 * Double click, context menu and keyboard of the presentation editor.
 * State shared with the editor arrives through the `ed` kernel; the mutable parts live on `ed.st`.
 */

import { buildMenu } from "./popover.js";
import { icon } from "./icons.js";
import { round } from "../presentation/geometry.js";
import { NUDGE, NUDGE_FAST, closest, insertTextAtCaret, textCapable } from "./presentation-dom.js";

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
export function createPresentationInput(ed) {
  const { afterStateChange, arrange, canPaste, cancelGesture, copySelected, createLinkForm, cutSelected, deleteSelected, duplicateSelected, editExpression, editableId, finishEdit, getContent, getSelectedObjects, getSlide, pasteObjects, patchObjects, popovers, selectAll, selectObjects, selectSlide, setTool, st, startEdit, stopPreview, toggleMark } = ed;

  /** @param {MouseEvent} event */
  function onDoubleClick(event) {
    const objectEl = closest(event.target, ".slide-object");
    if (!objectEl || st.editing) return;
    const id = /** @type {HTMLElement} */ (objectEl).dataset.objectId;
    const object = id ? getSlide()?.objects[id] : null;
    if (object?.type === "reference" && object.kind === "expression") {
      event.preventDefault();
      st.selectedIds = [object.id];
      afterStateChange();
      editExpression(object, /** @type {HTMLElement} */ (objectEl));
      return;
    }
    if (!object || !textCapable(object)) return;
    event.preventDefault();
    if (!(st.selectedIds.length === 1 && st.selectedIds[0] === id)) {
      st.selectedIds = [object.id];
      afterStateChange();
    }
    startEdit(object.id);
  }

  /** @param {{ x: number, y: number }} point @param {import("./popover.js").MenuItem[]} items */
  function showMenu(point, items) {
    popovers.showAt(point, buildMenu(items, popovers.close, (name) => icon(name, { size: 16 })));
  }

  /** @param {MouseEvent} event */
  function onContextMenu(event) {
    if (st.editing && st.editing.host.contains(/** @type {Node} */ (event.target))) return;
    event.preventDefault();
    if (st.editing) finishEdit(true);
    if (st.gesture) return;
    const point = { x: event.clientX, y: event.clientY };
    const objectEl = closest(event.target, ".slide-object");
    const id = objectEl ? /** @type {HTMLElement} */ (objectEl).dataset.objectId : undefined;
    const slide = getSlide();
    if (!slide) return;

    if (id && slide.objects[id]) {
      if (!st.selectedIds.includes(id)) {
        st.selectedIds = [id];
        afterStateChange();
      }
      const single = st.selectedIds.length === 1;
      const canText = single && textCapable(slide.objects[id]);
      /** @type {import("./popover.js").MenuItem[]} */
      const items = [
        { label: "Cut", icon: "cut", attrs: { "data-action": "cut" }, action: cutSelected },
        { label: "Copy", icon: "copy", attrs: { "data-action": "copy" }, action: () => void copySelected() },
        { label: "Paste", icon: "paste", attrs: { "data-action": "paste" }, disabled: !canPaste(), action: pasteObjects },
        { separator: true },
        { label: "Duplicate", icon: "duplicate", attrs: { "data-action": "duplicate" }, action: duplicateSelected },
        { label: "Delete", icon: "trash", danger: true, attrs: { "data-action": "delete" }, action: deleteSelected },
        { separator: true },
        {
          label: "Arrange",
          icon: "bring-front",
          attrs: { "data-action": "arrange" },
          submenu: [
            { label: "Bring to front", icon: "bring-front", attrs: { "data-action": "arrange-front" }, action: () => arrange("front") },
            { label: "Bring forward", icon: "bring-forward", attrs: { "data-action": "arrange-forward" }, action: () => arrange("forward") },
            { label: "Send backward", icon: "send-backward", attrs: { "data-action": "arrange-backward" }, action: () => arrange("backward") },
            { label: "Send to back", icon: "send-back", attrs: { "data-action": "arrange-back" }, action: () => arrange("back") }
          ]
        }
      ];
      if (single) items.push({ label: "Link…", icon: "link", attrs: { "data-action": "link" }, action: () => openLinkPopover(point) });
      if (canText) items.push({ label: "Edit text", icon: "textbox", attrs: { "data-action": "edit-text" }, action: () => void startEdit() });
      showMenu(point, items);
      return;
    }

    showMenu(point, [
      { label: "Paste", icon: "paste", attrs: { "data-action": "paste" }, disabled: !canPaste(), action: pasteObjects },
      { label: "Select all", attrs: { "data-action": "select-all" }, action: selectAll }
    ]);
  }

  /** @param {{ x: number, y: number }} point */
  function openLinkPopover(point) {
    const form = createLinkForm(() => popovers.close());
    popovers.showAt(point, form, { class: "popover-dialog" });
    form.querySelector("input")?.focus();
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    const target = /** @type {Element} */ (event.target);
    if (event.key === "Escape" && st.previewHandle) {
      event.preventDefault();
      stopPreview();
      return;
    }
    if (closest(target, "input, select, textarea, [contenteditable='true'], .slide-strip, .inspector, .animation-timeline, .popover")) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;

    if (key === "Escape") {
      if (st.gesture) {
        cancelGesture();
      } else if (st.tool) {
        setTool(null);
      } else if (st.selectedIds.length > 0) {
        selectObjects([]);
      }
      return;
    }
    if (st.gesture) return;

    if (mod && !event.altKey) {
      const lower = key.toLowerCase();
      if (lower === "a") { event.preventDefault(); selectAll(); }
      else if (lower === "c") { event.preventDefault(); copySelected(); }
      else if (lower === "x") { event.preventDefault(); cutSelected(); }
      else if (lower === "v") { event.preventDefault(); pasteObjects(); }
      else if (lower === "d") { event.preventDefault(); duplicateSelected(); }
      else if (lower === "b" || lower === "i" || lower === "u") {
        event.preventDefault();
        toggleMark(/** @type {Mark} */ ({ b: "bold", i: "italic", u: "underline" }[lower]));
      }
      return;
    }

    if (key === "Delete" || key === "Backspace") {
      if (st.selectedIds.length > 0) {
        event.preventDefault();
        deleteSelected();
      }
    } else if (key.startsWith("Arrow") && st.selectedIds.length > 0) {
      event.preventDefault();
      const step = event.shiftKey ? NUDGE_FAST : NUDGE;
      const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
      const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
      patchObjects(getSelectedObjects().map((o) => ({ objectId: o.id, patch: { x: round(o.x + dx), y: round(o.y + dy) } })));
    } else if (key === "F2" || key === "Enter") {
      if (editableId()) {
        event.preventDefault();
        startEdit();
      }
    } else if (key === "PageDown" || key === "PageUp") {
      const order = getContent().slideOrder;
      const next = order[order.indexOf(st.currentSlideId ?? "") + (key === "PageDown" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        selectSlide(next);
      }
    } else if (key.length === 1 && !event.altKey && editableId()) {
      // Typing on a selected text object starts editing; the character lands in the text.
      event.preventDefault();
      if (startEdit() && st.editing) insertTextAtCaret(st.editing.host, key);
    }
  }

  return { onDoubleClick, showMenu, onContextMenu, openLinkPopover, onKeydown };
}
