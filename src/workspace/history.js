/**
 * Undo/redo history of a workspace: whole-state snapshots, one per transaction.
 *
 * Each entry stores `state`, the workspace data on the *other* side of the entry from the live
 * data. For an entry on the undo stack that is the state before the transaction; undo swaps it
 * with the live data and moves the entry to the redo stack, where `state` is now the state after
 * the transaction, and redo swaps back. A commit therefore clones the workspace once (the
 * "before" snapshot taken when the transaction opened), and undo and redo clone nothing.
 *
 * Revisions: every commit or merge takes the next number from a monotonic counter. The head
 * revision is the revision of the last entry on the undo stack, or `baseRev` when the stack is
 * empty (or has been trimmed down to the oldest state that can still be reached). `savedRev` is
 * the head revision at the last `markSaved()`, so `dirty` is "head differs from saved": undoing
 * back to the saved state is clean, and a saved state that has been trimmed out of reach stays
 * dirty.
 *
 * Coalescing: a commit that carries a key merges into the previous entry when that entry has the
 * same key, nothing has happened since (no other commit, undo, redo or save) and it is within the
 * window. The merged entry keeps the first `before` state, so one undo reverts the whole run.
 */

import { mergeEntities } from "./changes.js";

/** @typedef {import("./schema.js").WorkspaceDocument} WorkspaceDocument */

/**
 * @typedef {object} HistoryEntry
 * @property {string} id
 * @property {string} label
 * @property {string[]} commands
 * @property {WorkspaceDocument} state The workspace data on the other side of this entry (see above).
 * @property {string[]} pageIds
 * @property {Map<string, Set<string>>} entities
 * @property {boolean} registry
 * @property {number} rev
 * @property {number} at Time of the last commit merged into this entry.
 * @property {string | null} coalesce Key later commits may merge under, or null.
 */

export const DEFAULT_MAX_ENTRIES = 200;
export const DEFAULT_COALESCE_WINDOW = 1000;

export class History {
  /**
   * @param {{ maxEntries?: number, coalesceWindow?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    /** @type {number} Entries kept; the oldest are dropped beyond this. */
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    /** @type {number} Milliseconds within which same-key commits merge. */
    this.coalesceWindow = options.coalesceWindow ?? DEFAULT_COALESCE_WINDOW;
    /** @type {() => number} */
    this.now = options.now ?? Date.now;

    /** @type {HistoryEntry[]} Committed transactions, most recent last. */
    this._undo = [];
    /** @type {HistoryEntry[]} Undone transactions available for redo. */
    this._redo = [];
    /** @type {number} */
    this._counter = 0;
    /** @type {number} Revision of the oldest reachable state. */
    this.baseRev = 0;
    /** @type {number} Head revision at the last save. */
    this.savedRev = 0;
    /** @type {HistoryEntry | null} Entry a same-key commit may merge into. */
    this._tail = null;
  }

  /** @returns {boolean} */
  get canUndo() {
    return this._undo.length > 0;
  }

  /** @returns {boolean} */
  get canRedo() {
    return this._redo.length > 0;
  }

  /** @returns {number} Entries on the undo stack. */
  get size() {
    return this._undo.length;
  }

  /** @returns {number} Revision of the current state. */
  get headRev() {
    return this._undo.length > 0 ? this._undo[this._undo.length - 1].rev : this.baseRev;
  }

  /** @returns {boolean} Whether the current state differs from the saved one. */
  get dirty() {
    return this.headRev !== this.savedRev;
  }

  /** Record the current state as the saved one; later commits never merge into earlier ones. */
  markSaved() {
    this.savedRev = this.headRev;
    this._tail = null;
  }

  /**
   * Record a committed transaction.
   * @param {{ id: string, label: string, commands: string[], before: WorkspaceDocument,
   *   pageIds: string[], entities: Map<string, Set<string>>, registry: boolean }} commit
   * @param {string | null} [coalesce] Merge key, or null/undefined to always start an entry.
   */
  record(commit, coalesce = null) {
    this._redo.length = 0;
    const at = this.now();
    const tail = this._tail;
    const top = this._undo[this._undo.length - 1];
    if (
      coalesce !== null &&
      tail !== null &&
      tail === top &&
      tail.coalesce === coalesce &&
      at - tail.at <= this.coalesceWindow
    ) {
      tail.commands = [...tail.commands, ...commit.commands];
      tail.pageIds = [...new Set([...tail.pageIds, ...commit.pageIds])];
      mergeEntities(tail.entities, commit.entities);
      tail.registry = tail.registry || commit.registry;
      tail.rev = ++this._counter;
      tail.at = at;
      return;
    }
    /** @type {HistoryEntry} */
    const entry = {
      id: commit.id,
      label: commit.label,
      commands: commit.commands,
      state: commit.before,
      pageIds: commit.pageIds,
      entities: commit.entities,
      registry: commit.registry,
      rev: ++this._counter,
      at,
      coalesce
    };
    this._undo.push(entry);
    this._tail = coalesce === null ? null : entry;
    while (this._undo.length > this.maxEntries) {
      const dropped = /** @type {HistoryEntry} */ (this._undo.shift());
      this.baseRev = dropped.rev;
    }
  }

  /**
   * Step back one entry.
   * @param {WorkspaceDocument} current The live data, which becomes the entry's redo state.
   * @returns {{ entry: HistoryEntry, data: WorkspaceDocument } | null} The entry and the data to make live.
   */
  undo(current) {
    const entry = this._undo.pop();
    if (!entry) return null;
    const data = entry.state;
    entry.state = current;
    this._redo.push(entry);
    this._tail = null;
    return { entry, data };
  }

  /**
   * Step forward one entry.
   * @param {WorkspaceDocument} current The live data, which becomes the entry's undo state.
   * @returns {{ entry: HistoryEntry, data: WorkspaceDocument } | null}
   */
  redo(current) {
    const entry = this._redo.pop();
    if (!entry) return null;
    const data = entry.state;
    entry.state = current;
    this._undo.push(entry);
    this._tail = null;
    return { entry, data };
  }
}
