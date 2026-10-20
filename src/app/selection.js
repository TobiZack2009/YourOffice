/**
 * Logical selections: where the user is, in terms of the model rather than the DOM.
 *
 * An editor that is rebuilt (page switch, undo, import) hands its selection to the session as one
 * of these values and takes it back afterwards. Each kind is plain JSON, so it can sit in the
 * session and be saved. Readers never trust a stored value: `read*` checks the shape and `clamp*`
 * drops whatever no longer exists.
 *
 *   document      { type: "text", anchor: DocPoint, focus: DocPoint }   caret or range in one block/item
 *                 { type: "units", anchor: string, focus: string }      whole blocks/items, by unit key
 *   sheet         { tableId, anchor: Position, focus: Position, others: Rect[] }
 *   presentation  { slideId, objectIds: string[] }
 *
 * Capturing and applying a document selection needs the DOM, so those adapters live with the
 * block editor (`captureSelection` / `restoreSelection` on its handle).
 */

/** @typedef {{ blockId: string, itemId?: string, offset: number }} DocPoint */
/** @typedef {{ type: "text", anchor: DocPoint, focus: DocPoint } | { type: "units", anchor: string, focus: string }} DocumentSelection */
/** @typedef {{ col: number, row: number }} Position */
/** @typedef {{ start: Position, end: Position }} Rect */
/** @typedef {{ tableId: string, anchor: Position, focus: Position, others: Rect[] }} SheetSelection */
/** @typedef {{ slideId: string | null, objectIds: string[] }} PresentationSelection */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const isIndex = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;
/** @param {unknown} value @returns {value is Position} */
const isPosition = (value) => isObject(value) && isIndex(value.col) && isIndex(value.row);
/** @param {unknown} value */
const isString = (value) => typeof value === "string" && value.length > 0;

/**
 * @param {unknown} value
 * @returns {value is DocPoint}
 */
function isDocPoint(value) {
  return (
    isObject(value) &&
    isString(value.blockId) &&
    (value.itemId === undefined || isString(value.itemId)) &&
    isIndex(value.offset)
  );
}

/**
 * @param {unknown} value
 * @returns {DocumentSelection | null}
 */
export function readDocumentSelection(value) {
  if (!isObject(value)) return null;
  if (value.type === "text" && isDocPoint(value.anchor) && isDocPoint(value.focus)) {
    return { type: "text", anchor: { ...value.anchor }, focus: { ...value.focus } };
  }
  if (value.type === "units" && isString(value.anchor) && isString(value.focus)) {
    return { type: "units", anchor: value.anchor, focus: value.focus };
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {SheetSelection | null}
 */
export function readSheetSelection(value) {
  if (!isObject(value) || !isString(value.tableId)) return null;
  if (!isPosition(value.anchor) || !isPosition(value.focus)) return null;
  const others = Array.isArray(value.others)
    ? value.others
        .filter((rect) => isObject(rect) && isPosition(rect.start) && isPosition(rect.end))
        .map((rect) => ({ start: { ...rect.start }, end: { ...rect.end } }))
    : [];
  return { tableId: value.tableId, anchor: { ...value.anchor }, focus: { ...value.focus }, others };
}

/**
 * @param {unknown} value
 * @returns {PresentationSelection | null}
 */
export function readPresentationSelection(value) {
  if (!isObject(value)) return null;
  if (value.slideId !== null && !isString(value.slideId)) return null;
  if (!Array.isArray(value.objectIds) || !value.objectIds.every(isString)) return null;
  return { slideId: value.slideId, objectIds: [...value.objectIds] };
}

/**
 * Keep only the part of a presentation selection that still exists.
 * @param {PresentationSelection} selection
 * @param {{ slides: Record<string, { objects: Record<string, unknown> }> }} content
 * @returns {PresentationSelection | null} null when the slide is gone.
 */
export function clampPresentationSelection(selection, content) {
  const slide = selection.slideId ? content.slides[selection.slideId] : undefined;
  if (!slide || !selection.slideId) return null;
  return { slideId: selection.slideId, objectIds: selection.objectIds.filter((id) => slide.objects[id]) };
}

/**
 * Keep a document selection only where its blocks (and list items) still exist, and pull a
 * text offset back inside the text.
 * @param {DocumentSelection} selection
 * @param {{ lengthOf: (blockId: string, itemId?: string) => number | null, hasUnit: (key: string) => boolean }} probe
 *   `lengthOf` returns the text length of a block or item, or null when it does not exist.
 * @returns {DocumentSelection | null}
 */
export function clampDocumentSelection(selection, probe) {
  if (selection.type === "units") {
    return probe.hasUnit(selection.anchor) && probe.hasUnit(selection.focus) ? selection : null;
  }
  /** @param {DocPoint} point @returns {DocPoint | null} */
  const clampPoint = (point) => {
    const length = probe.lengthOf(point.blockId, point.itemId);
    if (length === null) return null;
    return { ...point, offset: Math.min(point.offset, length) };
  };
  const anchor = clampPoint(selection.anchor);
  const focus = clampPoint(selection.focus);
  return anchor && focus ? { type: "text", anchor, focus } : null;
}
