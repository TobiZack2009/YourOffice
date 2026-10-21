/** DOM helpers for inline marks and links inside one contenteditable block. */

/**
 * @param {HTMLElement} el
 * @returns {Range | null} The live selection range when it sits inside `el`.
 */
export function rangeInside(el) {
  const selection = el.ownerDocument.getSelection?.();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  return range && el.contains(range.commonAncestorContainer) ? range : null;
}

/** @param {HTMLElement} el @returns {boolean} Whether links can live in this host. */
export const linkable = (el) => !el.matches("code[data-block-id]");

/**
 * @param {Node} node
 * @param {string} tag
 * @param {Element} boundary
 * @returns {Element | null}
 */
export function closestMark(node, tag, boundary) {
  let current = node instanceof Element ? node : node.parentElement;
  while (current && current !== boundary) {
    if (current.tagName.toLowerCase() === tag) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * @param {Element} element_
 */
export function unwrap(element_) {
  const parent = element_.parentNode;
  if (!parent) return;
  while (element_.firstChild) parent.insertBefore(element_.firstChild, element_);
  parent.removeChild(element_);
}

/**
 * @param {Range} range
 * @param {string} tag
 */
export function wrapRange(range, tag) {
  const doc = range.startContainer.ownerDocument ?? document;
  const wrapper = doc.createElement(tag);
  try {
    wrapper.append(range.extractContents());
    range.insertNode(wrapper);
  } catch {
    return;
  }
  const selection = doc.getSelection?.();
  if (selection) {
    const next = doc.createRange();
    next.selectNodeContents(wrapper);
    selection.removeAllRanges();
    selection.addRange(next);
  }
}
