/**
 * Session: what the user is doing, as opposed to what is true.
 *
 * The workspace says what exists; the session says which page is open, how far it is zoomed,
 * which sidebar branches are folded, which ribbon tab each page type shows, the presentation view
 * flags, the last slide per page and the logical selection per page. It is one store with a single
 * writer API (`set`), it is serialisable (`toJSON` / `restore`) and it never goes into the
 * workspace, so none of it is undoable or exported.
 *
 * Persistence is opt-in: pass `{ storage, key }` and the session loads from and saves to that
 * storage (a `localStorage`-shaped object). A failing storage is ignored, never fatal.
 */

/**
 * @typedef {object} PresentationView
 * @property {boolean} inspector
 * @property {boolean} snap
 * @property {boolean} grid
 * @property {boolean} timeline
 */

/**
 * @typedef {object} SessionState
 * @property {string | null} selectedPageId
 * @property {number} zoom Percent.
 * @property {boolean} sidebarVisible
 * @property {string[]} sidebarCollapsed Ids of the sidebar branches that are folded.
 * @property {Record<string, string>} ribbonTabByType Active ribbon tab per page type (`none` when no page).
 * @property {PresentationView} presentationView
 * @property {{ objects: any[], pastes: number }} presentationClipboard Not persisted.
 * @property {Record<string, string>} slideByPage Last slide open on each presentation.
 * @property {Record<string, any>} selections Logical selection per page (see `selection.js`).
 */

/** Keys that are never written to storage. */
const VOLATILE = new Set(["presentationClipboard"]);

/** @returns {SessionState} */
function defaults() {
  return {
    selectedPageId: null,
    zoom: 100,
    sidebarVisible: true,
    sidebarCollapsed: [],
    ribbonTabByType: {},
    presentationView: { inspector: true, snap: true, grid: false, timeline: false },
    presentationClipboard: { objects: [], pastes: 0 },
    slideByPage: {},
    selections: {}
  };
}

/** @param {unknown} value */
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {Record<string, unknown>} value @returns {Record<string, string>} */
function stringMap(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string"));
}

/**
 * Per-key checks applied by `restore`: each returns the cleaned value, or `undefined` to skip it.
 * @type {Record<string, (value: unknown) => unknown>}
 */
const READERS = {
  selectedPageId: (v) => (typeof v === "string" || v === null ? v : undefined),
  zoom: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  sidebarVisible: (v) => (typeof v === "boolean" ? v : undefined),
  sidebarCollapsed: (v) => (Array.isArray(v) ? v.filter((id) => typeof id === "string") : undefined),
  ribbonTabByType: (v) => (isPlainObject(v) ? stringMap(/** @type {Record<string, unknown>} */ (v)) : undefined),
  presentationView: (v) => {
    if (!isPlainObject(v)) return undefined;
    const view = /** @type {Record<string, unknown>} */ (v);
    const out = defaults().presentationView;
    for (const key of /** @type {const} */ (["inspector", "snap", "grid", "timeline"])) {
      if (typeof view[key] === "boolean") out[key] = /** @type {boolean} */ (view[key]);
    }
    return out;
  },
  slideByPage: (v) => (isPlainObject(v) ? stringMap(/** @type {Record<string, unknown>} */ (v)) : undefined),
  selections: (v) => (isPlainObject(v) ? v : undefined)
};

/**
 * Structural equality for the small JSON-like values the session holds.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function same(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((key) => same(/** @type {any} */ (a)[key], /** @type {any} */ (b)[key]));
}

/**
 * @typedef {object} Session
 * @property {() => Readonly<SessionState>} get The current state. Read-only: change it with `set`.
 * @property {(patch: Partial<SessionState>) => string[]} set Merge a patch; returns the keys that actually changed.
 * @property {(listener: (state: Readonly<SessionState>, changed: string[]) => void) => () => void} subscribe
 * @property {() => Record<string, unknown>} toJSON The serialisable part of the state.
 * @property {(json: unknown) => void} restore Apply saved state, ignoring anything malformed.
 */

/**
 * @param {Partial<SessionState>} [initial]
 * @param {{ storage?: Pick<Storage, "getItem" | "setItem">, key?: string }} [options]
 * @returns {Session}
 */
export function createSession(initial = {}, options = {}) {
  /** @type {SessionState} */
  let state = { ...defaults(), ...structuredClone(initial) };
  /** @type {Set<(state: Readonly<SessionState>, changed: string[]) => void>} */
  const listeners = new Set();
  const { storage, key } = options;

  function persist() {
    if (!storage || !key) return;
    try {
      storage.setItem(key, JSON.stringify(session.toJSON()));
    } catch {
      // Storage full or unavailable: the session just stays in memory.
    }
  }

  /** @type {Session} */
  const session = {
    get: () => state,

    set(patch) {
      /** @type {string[]} */
      const changed = [];
      const next = { ...state };
      for (const [name, value] of Object.entries(patch)) {
        if (!(name in state)) continue;
        if (same(/** @type {any} */ (state)[name], value)) continue;
        /** @type {any} */ (next)[name] = structuredClone(value);
        changed.push(name);
      }
      if (changed.length === 0) return changed;
      state = next;
      if (changed.some((name) => !VOLATILE.has(name))) persist();
      for (const listener of [...listeners]) listener(state, changed);
      return changed;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    toJSON() {
      return Object.fromEntries(Object.entries(state).filter(([name]) => !VOLATILE.has(name)));
    },

    restore(json) {
      if (!isPlainObject(json)) return;
      /** @type {Record<string, unknown>} */
      const patch = {};
      for (const [name, read] of Object.entries(READERS)) {
        const value = read(/** @type {Record<string, unknown>} */ (json)[name]);
        if (value !== undefined) patch[name] = value;
      }
      session.set(/** @type {Partial<SessionState>} */ (patch));
    }
  };

  if (storage && key) {
    try {
      const raw = storage.getItem(key);
      if (raw) {
        session.restore(JSON.parse(raw));
      }
    } catch {
      // A corrupt saved session is ignored.
    }
  }

  return session;
}
