/**
 * Inline mark editing inside a contenteditable host, for editors that own a
 * single text element (the presentation editor's in-place text).
 *
 * Marks use `document.execCommand` when the browser offers it and fall back to a
 * manual Range wrap (the jsdom path). The caller parses the DOM back into runs.
 */

/** @typedef {"bold" | "italic" | "underline" | "strike" | "code"} Mark */

const TAGS = { bold: "strong", italic: "em", underline: "u", strike: "s", code: "code" };
const COMMANDS = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" };

/**
 * @param {Node} node
 * @param {string} tag
 * @param {Element} boundary
 * @returns {Element | null}
 */
function closestTag(node, tag, boundary) {
  let current = node instanceof Element ? node : node.parentElement;
  while (current && current !== boundary) {
    const name = current.tagName.toLowerCase();
    if (name === tag || (tag === "strong" && name === "b") || (tag === "em" && name === "i") || (tag === "s" && (name === "strike" || name === "del"))) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/** @param {Element} element */
function unwrap(element) {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

/**
 * @param {Range} range
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 */
function wrapRange(range, tag, attrs = {}) {
  const doc = range.startContainer.ownerDocument ?? document;
  const wrapper = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) wrapper.setAttribute(name, value);
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

/**
 * The live, non-empty selection range inside `host`, if any.
 * @param {HTMLElement} host
 * @returns {Range | null}
 */
function rangeIn(host) {
  const selection = host.ownerDocument.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return host.contains(range.commonAncestorContainer) ? range : null;
}

/**
 * Whether the selection (or caret) inside `host` sits within the mark's tag.
 * @param {HTMLElement} host
 * @param {Mark} mark
 * @returns {boolean}
 */
export function markStateIn(host, mark) {
  const range = rangeIn(host);
  if (!range) return false;
  return closestTag(range.commonAncestorContainer, TAGS[mark], host) !== null;
}

/**
 * Toggle a mark on the selection inside `host`.
 * @param {HTMLElement} host
 * @param {Mark} mark
 * @returns {boolean} true when the DOM changed
 */
export function toggleMarkIn(host, mark) {
  const range = rangeIn(host);
  if (!range || range.collapsed) return false;
  const tag = TAGS[mark];
  const existing = closestTag(range.commonAncestorContainer, tag, host);
  if (existing) {
    unwrap(existing);
    return true;
  }
  const doc = host.ownerDocument;
  const command = /** @type {Record<string, string>} */ (COMMANDS)[mark];
  if (typeof doc.execCommand === "function" && command) {
    let ok = false;
    try {
      ok = doc.execCommand(command, false);
    } catch {
      ok = false;
    }
    if (ok) return true;
  }
  wrapRange(range, tag);
  return true;
}

/**
 * Set or clear a link on the selection inside `host`.
 * @param {HTMLElement} host
 * @param {string} url Empty string removes the link.
 * @returns {boolean} true when the DOM changed
 */
export function setLinkIn(host, url) {
  const range = rangeIn(host);
  if (!range) return false;
  const existing = closestTag(range.commonAncestorContainer, "a", host);
  if (!url) {
    if (!existing) return false;
    unwrap(existing);
    return true;
  }
  if (existing) {
    existing.setAttribute("href", url);
    return true;
  }
  if (range.collapsed) return false;
  wrapRange(range, "a", { href: url });
  return true;
}
