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

/**
 * @typedef {object} Notice
 * @property {(message: string, options?: { kind?: "error" | "info" }) => HTMLElement} show
 *   Show a message for a few seconds, replacing any earlier one.
 * @property {() => void} clear Remove the notice that is showing, if any.
 * @property {(action: () => void, onRefused?: () => void) => boolean} guard
 *   Run a model mutation. A refused command (`CommandError`) becomes a notice and `false`;
 *   anything else is a bug and propagates. `onRefused` runs after the notice, e.g. to redraw
 *   over a stale preview.
 */

/**
 * One notice host. An app creates its own, so two mounted apps never share a message or a timer.
 * @param {() => HTMLElement} [getContainer] Where notices mount (default: the document body).
 * @returns {Notice}
 */
export function createNotice(getContainer = () => document.body) {
  /** @type {HTMLElement | null} */
  let current = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  function clear() {
    if (timer) clearTimeout(timer);
    timer = null;
    current?.remove();
    current = null;
  }

  /** @type {Notice["show"]} */
  function show(message, options = {}) {
    clear();
    const element = h("div", {
      class: `app-notice${options.kind === "info" ? " is-info" : ""}`,
      role: "status",
      "aria-live": "polite",
      text: message
    });
    getContainer().append(element);
    current = element;
    timer = setTimeout(clear, SHOWN_FOR);
    return element;
  }

  /** @type {Notice["guard"]} */
  function guard(action, onRefused) {
    try {
      action();
      return true;
    } catch (error) {
      if (error instanceof CommandError) {
        show(error.message);
        onRefused?.();
        return false;
      }
      throw error;
    }
  }

  return { show, clear, guard };
}

/** The notice used when an editor is built without one (tests, standalone use). */
export const defaultNotice = createNotice();
export const { show: showNotice, clear: clearNotice, guard } = defaultNotice;
