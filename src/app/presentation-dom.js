/**
 * Constants and DOM helpers shared by the presentation editor modules.
 */

import { parseInlineRuns } from "./inline.js";

/** @typedef {import("../workspace/store.js").Workspace} Workspace */
/** @typedef {import("../presentation/model.js").SlideObject} SlideObject */
/** @typedef {import("../presentation/model.js").Slide} Slide */
/** @typedef {import("../presentation/model.js").Animation} Animation */
/** @typedef {import("../presentation/model.js").PresentationContent} PresentationContent */
/** @typedef {import("./marks.js").Mark} Mark */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

export const GRID_SIZE = 10;
export const NUDGE = 1;
export const NUDGE_FAST = 10;
export const DRAG_THRESHOLD = 3;
export const DEFAULT_IMAGE_BOX = { width: 480, height: 270 };
/** Starting box of a standalone reference object, by what it shows. */
export const REFERENCE_BOXES = {
  slide: { width: 480, height: 270 },
  table: { width: 480, height: 200 },
  blocks: { width: 480, height: 120 },
  expression: { width: 320, height: 80 }
};
export const ROTATE_STEP = 15;
export const STAGE_PADDING = 64;
export const MAX_STAGE_SCALE = 3;
export const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * @param {string} tag
 * @param {Record<string, string | number>} attrs
 * @returns {SVGElement}
 */
export function svgNode(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return /** @type {SVGElement} */ (el);
}

/** @param {SlideObject} o */
export const textCapable = (o) => o.type === "text" || o.type === "shape";
/** @param {SlideObject} o */
export const fillCapable = (o) => o.type === "text" || o.type === "shape";
/** @param {SlideObject} o */
export const strokeCapable = (o) => o.type !== "image" && o.type !== "reference";

/** @param {Element | EventTarget | null} node */
export function closest(node, selector) {
  return node instanceof Element ? node.closest(selector) : null;
}

/**
 * Handles shown on a selected object. Lines only get their two end points.
 * @param {SlideObject} object
 * @returns {{ name: string, left: number, top: number }[]}
 */
export function handlePoints(object) {
  const all = [
    { name: "nw", left: 0, top: 0 },
    { name: "n", left: 50, top: 0 },
    { name: "ne", left: 100, top: 0 },
    { name: "e", left: 100, top: 50 },
    { name: "se", left: 100, top: 100 },
    { name: "s", left: 50, top: 100 },
    { name: "sw", left: 0, top: 100 },
    { name: "w", left: 0, top: 50 }
  ];
  if (object.type !== "line") return all;
  const ends = object.flipV ? ["ne", "sw"] : ["nw", "se"];
  return all.filter((p) => ends.includes(p.name));
}

/**
 * Put `node` at the caret inside `host` (or at its end when there is no caret there).
 * @param {HTMLElement} host
 * @param {Node} node
 * @returns {Range | null}
 */
export function insertNodeAtCaret(host, node) {
  const doc = host.ownerDocument;
  const selection = doc.getSelection?.();
  let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (!range || !host.contains(range.commonAncestorContainer)) {
    range = doc.createRange();
    range.selectNodeContents(host);
    range.collapse(false);
  }
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return range;
}

/**
 * @param {HTMLElement} host
 * @param {string} text
 */
export function insertTextAtCaret(host, text) {
  const doc = host.ownerDocument;
  if (typeof doc.execCommand === "function") {
    try {
      if (doc.execCommand("insertText", false, text)) return;
    } catch {
      // fall through to the manual path
    }
  }
  insertNodeAtCaret(host, doc.createTextNode(text));
}

/**
 * Enter inside an edited text: a `<br>`, plus a trailing sentinel so a final empty
 * line is visible. Sentinels are stripped before the DOM is parsed back into runs.
 * @param {HTMLElement} host
 */
export function insertLineBreak(host) {
  const doc = host.ownerDocument;
  const br = doc.createElement("br");
  insertNodeAtCaret(host, br);
  if (!br.nextSibling) {
    const sentinel = doc.createElement("br");
    sentinel.setAttribute("data-sentinel", "true");
    host.append(sentinel);
  }
}

/**
 * @param {HTMLElement} host
 * @returns {import("../document/model.js").InlineRun[]}
 */
export function runsFromHost(host) {
  const copy = /** @type {HTMLElement} */ (host.cloneNode(true));
  for (const sentinel of copy.querySelectorAll("br[data-sentinel]")) sentinel.remove();
  return parseInlineRuns(copy);
}
