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
  let current = node instanceof Element ? node : node?.parentElement ?? null;
  while (current) {
    if (isEditable(current)) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Start and end of the current selection as character offsets in an element.
 * @param {Element} element
 * @returns {{ start: number, end: number }}
 */
export function selectionOffsets(element) {
  const doc = element.ownerDocument;
  const length = modelLength(element);
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) return { start: length, end: length };
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    return { start: length, end: length };
  }
  const measure = (container, offset) => {
    const probe = doc.createRange();
    probe.selectNodeContents(element);
    try {
      probe.setEnd(container, offset);
    } catch {
      return length;
    }
    return modelLength(probe.cloneContents());
  };
  return {
    start: measure(range.startContainer, range.startOffset),
    end: measure(range.endContainer, range.endOffset)
  };
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
