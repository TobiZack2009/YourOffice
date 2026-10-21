/**
 * Inline rich-text bridge between contenteditable DOM and the run model.
 *
 * The model stays authoritative: the editor parses its DOM into runs and
 * dispatches `setBlockRuns`; rendering goes through `renderRuns` in
 * `document/render.js`. This module is the only place that knows which HTML
 * elements correspond to which marks.
 */

import { isSafeUrl } from "../core/url.js";
import { REF_CHAR } from "../document/model.js";

/** @typedef {import("../document/model.js").InlineRun} InlineRun */

/** Element tag → model mark. */
const MARK_TAGS = {
  B: "bold",
  STRONG: "bold",
  I: "italic",
  EM: "italic",
  U: "underline",
  S: "strike",
  STRIKE: "strike",
  DEL: "strike",
  CODE: "code"
};

/**
 * Normalise contenteditable text: non-breaking spaces become ordinary spaces.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return text.replace(/\u00a0/g, " ");
}

/**
 * Canonical, comparable form of a marks object (only true flags and links).
 * @param {InlineRun["marks"]} [marks]
 * @returns {{ key: string, marks: InlineRun["marks"] | undefined }}
 */
function canonicalMarks(marks) {
  if (!marks) return { key: "", marks: undefined };
  /** @type {Record<string, unknown>} */
  const canonical = {};
  for (const key of ["bold", "italic", "underline", "strike", "code"]) {
    if (marks[/** @type {keyof typeof marks} */ (key)]) canonical[key] = true;
  }
  if (marks.link) canonical.link = marks.link;
  const keys = Object.keys(canonical).sort();
  return { key: JSON.stringify(keys.map((k) => [k, canonical[k]])), marks: canonical };
}

/**
 * Merge adjacent runs that share identical marks and drop empty text.
 * @param {InlineRun[]} runs
 * @returns {InlineRun[]}
 */
export function mergeRuns(runs) {
  /** @type {InlineRun[]} */
  const merged = [];
  for (const run of runs) {
    if (run.ref) {
      // A reference is atomic: it never merges with its neighbours.
      merged.push({ text: REF_CHAR, ref: run.ref });
      continue;
    }
    const text = normalizeText(run.text);
    if (text.length === 0) continue;
    const { key } = canonicalMarks(run.marks);
    const last = merged[merged.length - 1];
    if (last && !last.ref && canonicalMarks(last.marks).key === key) {
      last.text += text;
    } else {
      merged.push(run.marks ? { text, marks: run.marks } : { text });
    }
  }
  return merged;
}

/**
 * @param {Element} element An inline reference element.
 * @returns {InlineRun["ref"] | null}
 */
function readRef(element) {
  try {
    const ref = JSON.parse(element.getAttribute("data-ref") ?? "");
    return ref && typeof ref.id === "string" ? ref : null;
  } catch {
    return null;
  }
}

/**
 * Parse the contents of a contenteditable element into model runs.
 * @param {Element} root
 * @returns {InlineRun[]}
 */
export function parseInlineRuns(root) {
  /** @type {InlineRun[]} */
  const runs = [];

  const walk = (node, /** @type {InlineRun["marks"]} */ marks) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? "";
        if (text.length > 0) {
          runs.push(marks && Object.keys(marks).length > 0 ? { text, marks: { ...marks } } : { text });
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = /** @type {Element} */ (child);
      if (element.hasAttribute("data-ref-id")) {
        const ref = readRef(element);
        if (ref) runs.push({ text: REF_CHAR, ref });
        continue;
      }
      if (element.tagName === "BR") {
        runs.push(marks && Object.keys(marks).length > 0 ? { text: "\n", marks: { ...marks } } : { text: "\n" });
        continue;
      }
      /** @type {InlineRun["marks"]} */
      const next = { ...marks };
      const mark = MARK_TAGS[/** @type {keyof typeof MARK_TAGS} */ (element.tagName)];
      if (mark) /** @type {Record<string, unknown>} */ (next)[mark] = true;
      if (element.tagName === "A") {
        const href = element.getAttribute("href");
        if (href && isSafeUrl(href)) next.link = href;
      }
      walk(element, next);
    }
  };

  walk(root, {});
  return mergeRuns(runs);
}

/**
 * @param {InlineRun[]} a
 * @param {InlineRun[]} b
 * @returns {boolean} True when the runs have identical text and marks.
 */
export function runsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].text !== b[i].text) return false;
    if (a[i].ref || b[i].ref) {
      if (JSON.stringify(a[i].ref ?? null) !== JSON.stringify(b[i].ref ?? null)) return false;
      continue;
    }
    if (canonicalMarks(a[i].marks).key !== canonicalMarks(b[i].marks).key) return false;
  }
  return true;
}

/**
 * @param {InlineRun[]} runs
 * @returns {string}
 */
export function runsToPlainText(runs) {
  return runs.map((run) => (run.ref ? "" : run.text)).join("");
}

/**
 * Length of an element's content as the model counts it: an inline reference is one
 * character however much it draws.
 * @param {Node} node An element or fragment.
 * @returns {number}
 */
export function modelLength(node) {
  let total = 0;
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) total += (child.textContent ?? "").length;
    else if (child.nodeType === Node.ELEMENT_NODE) {
      total += /** @type {Element} */ (child).hasAttribute("data-ref-id") ? 1 : modelLength(child);
    }
  }
  return total;
}

/**
 * @param {Element} element
 * @returns {number} Caret offset in model characters from the element start (the end when the caret is elsewhere).
 */
export function caretOffset(element) {
  const doc = element.ownerDocument;
  const selection = doc.getSelection?.();
  if (!selection || selection.rangeCount === 0) return modelLength(element);
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return modelLength(element);
  const probe = doc.createRange();
  probe.selectNodeContents(element);
  try {
    probe.setEnd(range.startContainer, range.startOffset);
  } catch {
    return modelLength(element);
  }
  return modelLength(probe.cloneContents());
}
