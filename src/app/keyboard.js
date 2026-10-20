/**
 * Keyboard dispatcher for the shortcuts that belong to the whole app.
 *
 * One `keydown` listener on the document looks a key chord up in a table of shortcuts
 * `{ keys, scope, when, run }` instead of every module deciding for itself. A scope stack says
 * which table rows apply: `global` is always at the bottom, and a modal scope pushed above it
 * (a slide show, say) hides every scope beneath it. Editors keep their own element-level
 * handlers for typing and navigation; this is for chords that act on the app: undo, save,
 * find, start the show.
 *
 * Chords are written `mod+shift+z`: `mod` is Cmd on macOS and Ctrl elsewhere (either is
 * accepted), the last part is `event.key` lower-cased.
 */

/**
 * @typedef {object} Shortcut
 * @property {string} keys Chord, e.g. `mod+k`, `mod+shift+z`. Several alternatives: `mod+shift+z|mod+y`.
 * @property {string} [scope] Defaults to `global`.
 * @property {(event: KeyboardEvent) => boolean} [when] Whether the shortcut applies to this event (target checks).
 * @property {(event: KeyboardEvent) => void} run Called after `preventDefault`.
 */

/**
 * @typedef {object} Keyboard
 * @property {(shortcuts: Shortcut[]) => () => void} define Add shortcuts; returns a function that removes them.
 * @property {(scope: string, options?: { modal?: boolean }) => () => void} push Make `scope` active; returns its pop.
 * @property {() => string[]} scopes Active scopes, bottom first.
 * @property {() => void} destroy
 */

/**
 * @param {string} chord
 * @returns {{ key: string, mod: boolean, shift: boolean, alt: boolean }}
 */
function parseChord(chord) {
  const parts = chord.toLowerCase().split("+");
  const key = /** @type {string} */ (parts.pop());
  return { key, mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt") };
}

/**
 * @param {string} keys
 * @param {KeyboardEvent} event
 */
function matches(keys, event) {
  const key = event.key.toLowerCase();
  const mod = event.metaKey || event.ctrlKey;
  return keys.split("|").some((alternative) => {
    const chord = parseChord(alternative);
    return chord.key === key && chord.mod === mod && chord.shift === event.shiftKey && chord.alt === event.altKey;
  });
}

/**
 * @param {Document} doc
 * @returns {Keyboard}
 */
export function createKeyboard(doc = document) {
  /** @type {Set<Shortcut>} */
  const table = new Set();
  /** @type {Array<{ name: string, modal: boolean }>} */
  const stack = [{ name: "global", modal: false }];

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (!(event.metaKey || event.ctrlKey)) return;
    for (let index = stack.length - 1; index >= 0; index--) {
      const { name, modal } = stack[index];
      for (const shortcut of table) {
        if ((shortcut.scope ?? "global") !== name) continue;
        if (!matches(shortcut.keys, event)) continue;
        if (shortcut.when && !shortcut.when(event)) continue;
        event.preventDefault();
        shortcut.run(event);
        return;
      }
      if (modal) return;
    }
  }

  doc.addEventListener("keydown", onKeydown);

  return {
    define(shortcuts) {
      for (const shortcut of shortcuts) table.add(shortcut);
      return () => {
        for (const shortcut of shortcuts) table.delete(shortcut);
      };
    },
    push(scope, options = {}) {
      const entry = { name: scope, modal: options.modal === true };
      stack.push(entry);
      return () => {
        const at = stack.indexOf(entry);
        if (at > 0) stack.splice(at, 1);
      };
    },
    scopes: () => stack.map((entry) => entry.name),
    destroy() {
      doc.removeEventListener("keydown", onKeydown);
      table.clear();
      stack.length = 1;
    }
  };
}
