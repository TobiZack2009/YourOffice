/**
 * Gesture scope: the document-level listeners of one editor, owned in one place.
 *
 * A drag needs `mousemove` / `mouseup` on the document because the pointer leaves the element it
 * started on. Whoever registers those must also take them back, including when the editor is
 * destroyed halfway through (page switch, undo remount). A scope records what it registered, so
 * `abort()` removes all of it and runs the cancel hooks that clear previews.
 */

/**
 * @typedef {object} GestureScope
 * @property {(type: string, handler: (event: any) => void, capture?: boolean) => () => void} listen
 *   Register a listener on the scope's document; returns a function that removes just that one.
 * @property {(cleanup: () => void) => void} onAbort Run `cleanup` when the scope is aborted.
 * @property {() => void} abort Remove every listener and run the cancel hooks. The scope stays usable.
 * @property {() => number} size Listeners currently registered.
 */

/**
 * @param {Document} [doc]
 * @returns {GestureScope}
 */
export function createGestureScope(doc = document) {
  /** @type {Set<{ type: string, handler: (event: any) => void, capture: boolean }>} */
  const entries = new Set();
  /** @type {Set<() => void>} */
  const cancels = new Set();

  return {
    listen(type, handler, capture = false) {
      const entry = { type, handler, capture };
      entries.add(entry);
      doc.addEventListener(type, handler, capture);
      return () => {
        if (!entries.delete(entry)) return;
        doc.removeEventListener(type, handler, capture);
      };
    },

    onAbort(cleanup) {
      cancels.add(cleanup);
    },

    abort() {
      for (const { type, handler, capture } of entries) doc.removeEventListener(type, handler, capture);
      entries.clear();
      for (const cleanup of [...cancels]) cleanup();
    },

    size: () => entries.size
  };
}
