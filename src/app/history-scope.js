/**
 * Which undo applies to a keystroke. The model history (the workspace's undo stack) owns Cmd+Z
 * on the editing surfaces; everywhere a person edits plain text (page title, quick find,
 * sidebar rename, link form, inspector and formula fields, the in-cell input) the browser's own
 * text undo must be left alone.
 *
 * A surface that opts in carries `data-history="model"`: document block hosts, the sheet grid,
 * the slide stage, the slide strip and the slide text editor.
 */

/** Native text fields: their undo is the browser's. */
const TEXT_FIELD = "input, textarea, select";
const EDITABLE_TEXT = '[contenteditable="true"], [contenteditable=""]';
const MODEL_SURFACE = '[data-history="model"]';

/** @param {Element} element Mark an element as an editing surface owned by the model history. */
export function markModelHistory(element) {
  element.setAttribute("data-history", "model");
}

/**
 * Whether Cmd+Z / Cmd+Shift+Z / Cmd+Y typed on `target` should run the model's undo/redo.
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function usesModelHistory(target) {
  const element = target instanceof Element ? target : null;
  // Nothing focused (the body, the page) or a non-text control: the model's history applies.
  if (!element) return true;
  if (element.closest(TEXT_FIELD)) return false;
  if (element.closest(EDITABLE_TEXT)) return element.closest(MODEL_SURFACE) !== null;
  return true;
}
