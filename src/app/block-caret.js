/** DOM caret and selection helpers for contenteditable blocks (input boundary only). */

import { modelLength } from "./inline.js";

/**
 * @param {Element} element
 * @returns {boolean}
 */
export function isEditable(element) {
  return element.getAttribute("contenteditable") === "true";
}

/**
 * @param {Node | null} node
 * @returns {HTMLElement | null}
 */
export function editableFrom(node) {
  let current = /** @type {HTMLElement | null} */ (node instanceof Element ? node : node?.parentElement ?? null);
  while (current) {
    if (isEditable(current)) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * A DOM position as a character offset in an element, counting an inline reference as one.
 * @param {Element} element
 * @param {Node} container
 * @param {number} offset
 * @returns {number}
 */
export function offsetInElement(element, container, offset) {
  const length = modelLength(element);
  if (!element.contains(container)) return length;
  const probe = element.ownerDocument.createRange();
  probe.selectNodeContents(element);
  try {
    probe.setEnd(container, offset);
  } catch {
    return length;
  }
  return modelLength(probe.cloneContents());
}

/**
 * Start and end of the current selection as character offsets in an element.
 * @param {Element} element
 * @returns {{ start: number, end: number }}
 */
export function selectionOffsets(element) {
  const length = modelLength(element);
  const selection = element.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0) return { start: length, end: length };
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return { start: length, end: length };
  }
  return {
    start: offsetInElement(element, range.startContainer, range.startOffset),
    end: offsetInElement(element, range.endContainer, range.endOffset)
  };
}

/**
 * The text offset in an editable that a screen point lands on, or null when the browser cannot
 * say (no caret-from-point support). A point outside the text snaps to the nearer end by height.
 * @param {HTMLElement} editable
 * @param {number} x
 * @param {number} y
 * @returns {number | null}
 */
export function offsetAtPoint(editable, x, y) {
  const doc = editable.ownerDocument;
  /** @type {{ node: Node, offset: number } | null} */
  let caret = null;
  if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) caret = { node: position.offsetNode, offset: position.offset };
  } else if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) caret = { node: range.startContainer, offset: range.startOffset };
  } else {
    return null;
  }
  if (caret && editable.contains(caret.node)) return offsetInElement(editable, caret.node, caret.offset);
  const rect = editable.getBoundingClientRect();
  return y < rect.top + rect.height / 2 ? 0 : modelLength(editable);
}

/**
 * The DOM position of a character offset, counting an inline reference as one character
 * and never entering it.
 * @param {Node} root
 * @param {number} target
 * @returns {{ container: Node, offset: number } | null}
 */
export function pointAtOffset(root, target) {
  let remaining = target;
  /** @param {Node} node @returns {{ container: Node, offset: number } | null} */
  const visit = (node) => {
    const children = Array.from(node.childNodes);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === Node.TEXT_NODE) {
        const length = (child.textContent ?? "").length;
        if (remaining <= length) return { container: child, offset: remaining };
        remaining -= length;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (/** @type {Element} */ (child).hasAttribute("data-ref-id")) {
          if (remaining === 0) return { container: node, offset: i };
          remaining -= 1;
          if (remaining === 0) return { container: node, offset: i + 1 };
        } else {
          const found = visit(child);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return visit(root);
}

/**
 * Place the caret at an offset within an element.
 * @param {HTMLElement} element
 * @param {"start" | "end" | number} where
 */
export function placeCaret(element, where = "end") {
  if (!element) return;
  const doc = element.ownerDocument;
  element.focus();
  const selection = doc.getSelection?.();
  if (!selection) return;
  const range = doc.createRange();

  if (where === "end") {
    range.selectNodeContents(element);
    range.collapse(false);
  } else if (where === "start") {
    range.setStart(element, 0);
    range.collapse(true);
  } else {
    const point = pointAtOffset(element, where);
    if (point) {
      range.setStart(point.container, point.offset);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    range.selectNodeContents(element);
    range.collapse(false);
  }

  selection.removeAllRanges();
  selection.addRange(range);
}
