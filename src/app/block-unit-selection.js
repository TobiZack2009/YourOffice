/**
 * Block selection: the explicit, logical selection of whole units (blocks and list items) that
 * a browser selection cannot express because each unit is its own contenteditable.
 *
 * The state is `{ anchor, focus }` unit keys plus, optionally, a text offset in the anchor unit
 * and in the focus unit. Offsets make the two end units partial, so a selection can start in the
 * middle of one paragraph and end in the middle of another; units between them are whole. Units
 * that hold no text are always whole. Partial text is painted with the CSS Custom Highlight API
 * where the browser has it, and falls back to marking the whole unit.
 */

import { pointAtOffset } from "./block-caret.js";
import { modelLength } from "./inline.js";

const HIGHLIGHT = "block-selection";

/**
 * @typedef {object} UnitSelection
 * @property {string} anchor
 * @property {string} focus
 * @property {number} [anchorOffset]
 * @property {number} [focusOffset]
 */
/** @typedef {{ key: string, start: number, end: number, length: number | null, whole: boolean }} UnitSpan What a selection covers of one unit; `length` is null for a unit without text. */

/** @param {any} ed Editor kernel: the unit lookups and `setActive`/`notifyActiveChange` are used. */
export function createUnitSelection(ed) {
  const { element, unitKeys, unitElement, editableOfUnit, parseKey } = ed;

  /** @type {UnitSelection | null} */
  let sel = null;
  let painted = false;

  /** @returns {string[]} Selected unit keys, in reading order. */
  function selectedKeys() {
    if (!sel) return [];
    const keys = unitKeys();
    const a = keys.indexOf(sel.anchor);
    const f = keys.indexOf(sel.focus);
    if (a === -1 || f === -1) return [];
    return keys.slice(Math.min(a, f), Math.max(a, f) + 1);
  }

  /** @returns {UnitSpan[]} The covered text of every selected unit, in reading order. */
  function spans() {
    const keys = selectedKeys();
    if (!sel || keys.length === 0) return [];
    const order = unitKeys();
    const forward = order.indexOf(sel.anchor) <= order.indexOf(sel.focus);
    const firstOffset = forward ? sel.anchorOffset : sel.focusOffset;
    const lastOffset = forward ? sel.focusOffset : sel.anchorOffset;
    return keys.map((key, index) => {
      const el = editableOfUnit(unitElement(key));
      if (!el) return { key, start: 0, end: 0, length: null, whole: true };
      const length = modelLength(el);
      let start = 0;
      let end = length;
      if (keys.length === 1) {
        if (sel?.anchorOffset !== undefined && sel.focusOffset !== undefined) {
          start = Math.min(sel.anchorOffset, sel.focusOffset);
          end = Math.max(sel.anchorOffset, sel.focusOffset);
        }
      } else {
        if (index === 0 && firstOffset !== undefined) start = firstOffset;
        if (index === keys.length - 1 && lastOffset !== undefined) end = lastOffset;
      }
      start = Math.min(start, length);
      end = Math.min(Math.max(end, start), length);
      return { key, start, end, length, whole: start === 0 && end === length };
    });
  }

  function highlights() {
    const view = element.ownerDocument.defaultView;
    const registry = view?.CSS?.highlights;
    return registry && view?.Highlight ? { registry, Highlight: view.Highlight } : null;
  }

  /** @param {Range[]} ranges */
  function paint(ranges) {
    const api = highlights();
    if (!api) return;
    if (ranges.length > 0) {
      api.registry.set(HIGHLIGHT, new api.Highlight(...ranges));
      painted = true;
    } else if (painted) {
      api.registry.delete(HIGHLIGHT);
      painted = false;
    }
  }

  /** Show the selection: whole units get a class, partial ends get the text highlight. */
  function apply() {
    for (const el of element.querySelectorAll(".is-block-selected")) el.classList.remove("is-block-selected");
    const covered = spans();
    if (covered.length === 0) sel = null;
    element.classList.toggle("is-block-selecting", sel !== null);
    const canHighlight = highlights() !== null;
    /** @type {Range[]} */
    const ranges = [];
    for (const span of covered) {
      const unit = unitElement(span.key);
      const el = editableOfUnit(unit);
      if (!unit) continue;
      if (span.whole || !canHighlight || !el) {
        unit.classList.add("is-block-selected");
        continue;
      }
      const from = pointAtOffset(el, span.start);
      const to = pointAtOffset(el, span.end);
      if (!from || !to) {
        unit.classList.add("is-block-selected");
        continue;
      }
      const range = element.ownerDocument.createRange();
      range.setStart(from.container, from.offset);
      range.setEnd(to.container, to.offset);
      ranges.push(range);
    }
    paint(ranges);
  }

  /**
   * Enter block-selection mode over the units between two keys. Offsets (in model characters)
   * make the anchor and focus units partial.
   * @param {string} anchor
   * @param {string} focus
   * @param {{ anchorOffset?: number, focusOffset?: number }} [offsets]
   */
  function setBlockSelection(anchor, focus, offsets = {}) {
    sel = { anchor, focus };
    if (offsets.anchorOffset !== undefined) sel.anchorOffset = offsets.anchorOffset;
    if (offsets.focusOffset !== undefined) sel.focusOffset = offsets.focusOffset;
    const doc = element.ownerDocument;
    doc.getSelection?.()?.removeAllRanges();
    const current = doc.activeElement;
    if (current && current !== element && element.contains(current)) /** @type {HTMLElement} */ (current).blur();
    element.focus({ preventScroll: true });
    apply();
    const { blockId, itemId } = parseKey(focus);
    ed.setActive(blockId, itemId);
  }

  /** Leave block-selection mode without moving the caret. */
  function clearBlockSelection() {
    if (!sel) return;
    sel = null;
    apply();
    ed.notifyActiveChange();
  }

  /** Forget the selection (the units are about to be redrawn or removed). */
  function drop() {
    sel = null;
    paint([]);
  }

  function selectAllUnits() {
    const keys = unitKeys();
    if (keys.length > 0) setBlockSelection(keys[0], keys[keys.length - 1]);
  }

  return {
    get: () => sel,
    selectedKeys,
    spans,
    apply,
    setBlockSelection,
    clearBlockSelection,
    selectAllUnits,
    drop,
    destroy: drop
  };
}
