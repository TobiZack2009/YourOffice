/**
 * Minimal synchronous pub/sub. The store emits `change` after each committed
 * transaction; renderers and the persistence layer subscribe. Kept dependency-free.
 */
export class Emitter {
  constructor() {
    /** @type {Map<string, Set<(payload: unknown) => void>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @template P
   * @param {string} event
   * @param {(payload: P) => void} listener
   * @returns {() => void} Unsubscribe function.
   */
  on(event, listener) {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(/** @type {(payload: unknown) => void} */ (listener));
    return () => {
      set?.delete(/** @type {(payload: unknown) => void} */ (listener));
    };
  }

  /**
   * Emit an event to all current listeners, listener errors isolated.
   * @param {string} event
   * @param {unknown} [payload]
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`listener for "${event}" threw`, error);
      }
    }
  }
}
