/**
 * Moves the document editor's selection in and out of model terms (see `selection.js`):
 * capture it before a redraw, put it back afterwards, dropping what no longer exists.
 * State shared with the editor arrives through the `ed` kernel.
 */

import { editableFrom, placeCaret, pointAtOffset, selectionOffsets } from "./block-caret.js";
import { modelLength } from "./inline.js";
import { clampDocumentSelection, readDocumentSelection } from "./selection.js";

/** @param {any} ed Editor kernel (see `createDocumentEditor`). */
export function createBlockSelectionIo(ed) {
  const { element, owns, findEditable, unitKeys, setBlockSelection, setActive } = ed;

  /**
   * The selection as model terms (see `selection.js`), or null when this editor holds none.
   * @returns {import("./selection.js").DocumentSelection | null}
   */
  function captureSelection() {
    if (ed.sel()) return { type: "units", anchor: ed.sel().anchor, focus: ed.sel().focus };
    const range = element.ownerDocument.getSelection?.()?.rangeCount
      ? element.ownerDocument.getSelection()?.getRangeAt(0)
      : null;
    if (!range) return null;
    const el = editableFrom(range.startContainer);
    if (!el || !element.contains(el) || !owns(el)) return null;
    const blockId = el.getAttribute("data-block-id");
    if (!blockId) return null;
    const itemId = el.getAttribute("data-item-id") ?? undefined;
    const { start, end } = selectionOffsets(el);
    const point = (/** @type {number} */ offset) => (itemId ? { blockId, itemId, offset } : { blockId, offset });
    return { type: "text", anchor: point(start), focus: point(end) };
  }

  /**
   * Put a captured selection back, dropping whatever no longer exists. Without `focus` it does
   * nothing: moving the caret into the editor takes focus, which a page switch must not do.
   * @param {unknown} value
   * @param {{ focus?: boolean }} [opts]
   * @returns {boolean} Whether anything was restored.
   */
  function restoreSelection(value, opts = {}) {
    const wanted = readDocumentSelection(value);
    if (!wanted || opts.focus === false) return false;
    const clamped = clampDocumentSelection(wanted, {
      lengthOf: (blockId, itemId) => {
        const el = findEditable(blockId, itemId ?? null);
        return el ? modelLength(el) : null;
      },
      hasUnit: (key) => unitKeys().includes(key)
    });
    if (!clamped) return false;
    if (clamped.type === "units") {
      setBlockSelection(clamped.anchor, clamped.focus);
      return true;
    }
    const el = findEditable(clamped.anchor.blockId, clamped.anchor.itemId ?? null);
    if (!el) return false;
    placeCaret(el, clamped.anchor.offset);
    setActive(el.getAttribute("data-block-id"), el.getAttribute("data-item-id"));
    if (clamped.focus.offset !== clamped.anchor.offset) {
      const from = pointAtOffset(el, clamped.anchor.offset);
      const to = pointAtOffset(el, clamped.focus.offset);
      const doc = element.ownerDocument;
      if (from && to) {
        const range = doc.createRange();
        range.setStart(from.container, from.offset);
        range.setEnd(to.container, to.offset);
        const selection = doc.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    return true;
  }

  return { captureSelection, restoreSelection };
}
