/**
 * The one place a refused command is reported. A command that throws `CommandError`
 * (a merge in the way, an embed that would loop, a bad reference) leaves the model
 * untouched; the editors turn that into a short message instead of a crash or silence.
 *
 * One notice at a time, mounted on the document body so view zoom and clipping
 * containers never move it.
 */

import { CommandError } from "../core/errors.js";
import { h } from "./dom.js";

const SHOWN_FOR = 4500;

/** @type {HTMLElement | null} */
let current = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;

/** Remove the notice that is showing, if any. */
export function clearNotice() {
  if (timer) clearTimeout(timer);
  timer = null;
  current?.remove();
  current = null;
}

/**
 * Show a message for a few seconds, replacing any earlier one.
 * @param {string} message
 * @param {{ kind?: "error" | "info" }} [options]
 * @returns {HTMLElement}
 */
export function showNotice(message, options = {}) {
  clearNotice();
  const element = h("div", {
    class: `app-notice${options.kind === "info" ? " is-info" : ""}`,
    role: "status",
    "aria-live": "polite",
    text: message
  });
  document.body.append(element);
  current = element;
  timer = setTimeout(clearNotice, SHOWN_FOR);
  return element;
}

/**
 * Run a model mutation. A refused command becomes a notice and `false`; anything else
 * is a bug and propagates.
 * @param {() => void} action
 * @param {() => void} [onRefused] Called after the notice, e.g. to redraw over a stale preview.
 * @returns {boolean} Whether the action completed.
 */
export function guard(action, onRefused) {
  try {
    action();
    return true;
  } catch (error) {
    if (error instanceof CommandError) {
      showNotice(error.message);
      onRefused?.();
      return false;
    }
    throw error;
  }
}
