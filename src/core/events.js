/**
 * Minimal synchronous pub/sub. The store emits `change` after each committed
 * transaction; renderers and the persistence layer subscribe. Kept dependency-free.
 */
export class Emitter {
  /**
   * @param {{ onError?: (error: unknown, event: string) => void, strict?: boolean }} [options]
   *   `onError` receives what a listener threw (default: console.error); `strict` rethrows
   *   after every listener has run, so tests see failures that production isolates.
   */
  constructor(options = {}) {
    /** @type {Map<string, Set<(payload: unknown) => void>>} */
    this._listeners = new Map();
    /** @type {((error: unknown, event: string) => void) | undefined} */
    this.onError = options.onError;
    /** @type {boolean} */
    this.strict = options.strict === true;
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
   * Emit an event to the listeners subscribed now. A listener unsubscribed by an earlier
   * listener of the same emit is skipped. Listener errors are isolated and routed to `onError`.
   * @param {string} event
   * @param {unknown} [payload]
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set) return;
    /** @type {unknown[]} */
    const failures = [];
    for (const listener of [...set]) {
      if (!set.has(listener)) continue;
      try {
        listener(payload);
      } catch (error) {
        failures.push(error);
        if (this.onError) this.onError(error, event);
        else console.error(`listener for "${event}" threw`, error);
      }
    }
    if (this.strict && failures.length > 0) throw failures[0];
  }
}
