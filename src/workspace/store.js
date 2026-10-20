/**
 * Workspace store: in-memory model, command dispatch, transactions, history,
 * dirty state. The DOM is never mutated here; renderers listen for `change`.
 *
 * Phase-1 history keeps whole-state snapshots per transaction (see AGENTS.md),
 * which is simple and correct; inverse patches are a planned upgrade.
 */

import { createId } from "../core/ids.js";
import { Emitter } from "../core/events.js";
import { CommandError, WorkspaceFormatError } from "../core/errors.js";
import {
  SCHEMA_VERSION,
  WORKSPACE_FORMAT,
  migrateWorkspace
} from "./schema.js";
import { registerWorkspaceCommands } from "./commands.js";

/** @typedef {import("./schema.js").PageEnvelope} PageEnvelope */
/** @typedef {import("./schema.js").PageType} PageType */
/** @typedef {import("./schema.js").WorkspaceDocument} WorkspaceDocument */

/**
 * An open, mutating batch of commands.
 *
 * @typedef {object} Transaction
 * @property {string} id
 * @property {string} label
 * @property {{ type: string, payload: unknown }[]} commands Applied in order.
 * @property {Set<string>} pageIds Page ids touched, for targeted rerenders.
 */

/** @typedef {{ hot: boolean, selfManaged: boolean }} CommandMeta */

/** @typedef {{ id: string, label: string, commands: string[], before: WorkspaceDocument, after: WorkspaceDocument, pageIds: string[] }} HistoryEntry */

/** @returns {string} Current time as an ISO 8601 UTC string. */
function nowIso() {
  return new Date().toISOString();
}

export class Workspace {
  constructor() {
    /** @type {WorkspaceDocument} */
    this._data = {
      format: WORKSPACE_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      metadata: {
        id: createId("workspace"),
        title: "",
        createdAt: nowIso(),
        modifiedAt: nowIso()
      },
      pages: {},
      pageOrder: { root: [] },
      settings: {}
    };

    /** @type {Emitter} */
    this.events = new Emitter();
    /** @type {boolean} Unsaved-changes flag (spec §11 dirty-state tracking). */
    this.dirty = false;

    /** @type {HistoryEntry[]} Committed transactions, most recent last. */
    this._history = [];
    /** @type {HistoryEntry[]} Undone transactions available for redo. */
    this._redo = [];

    /** @type {Transaction | null} Open transaction when batching, else null. */
    this._open = null;
    /** @type {WorkspaceDocument | null} State snapshot at transaction start. */
    this._before = null;

    /**
     * Registered command handlers. Each handler validates and mutates `_data`
     * only; throw CommandError on validation failure for transaction rollback.
     *
     * @type {Map<string, (store: Workspace, tx: Transaction, payload: unknown) => void>}
     */
    this._commands = new Map();
    /**
     * Hooks that wrap every command handler, inside its transaction, so cross-cutting
     * invariants (sections, detached content) are restored before the transaction
     * commits. A hook runs before the handler and may return a function to run after it.
     * @type {Array<(store: Workspace, tx: Transaction, type: string, payload: unknown) => (void | (() => void))>}
     */
    this._commandHooks = [];

    /**
     * Per-command registration facts, read by cross-cutting hooks (see `registerCommand`).
     * @type {Map<string, CommandMeta>}
     */
    this._commandMeta = new Map();

    /**
     * What a full workspace check adds to the envelope check: content validators per page
     * type and integrity checks. Empty until a composition root (`domain/`) configures it.
     * @type {import("./schema.js").ValidationOptions}
     */
    this._validation = {};

    // Only the workspace's own commands; features register theirs through `domain/installDomain`.
    registerWorkspaceCommands(this);
  }

  /** @returns {import("./schema.js").ValidationOptions} What a full workspace check needs. */
  get validationOptions() {
    return this._validation;
  }

  /**
   * Set the content validators and integrity checks used by import, export and `setPageContent`.
   * @param {import("./schema.js").ValidationOptions} options
   */
  configureValidation(options) {
    this._validation = options;
  }

  /**
   * Content problems for a page type; empty when the content is well formed.
   * @param {PageType} type
   * @param {unknown} content
   * @returns {string[]}
   */
  validateContent(type, content) {
    return this._validation.contentValidators?.[type]?.(content) ?? [];
  }

  // -- construction -----------------------------------------------------------

  /**
   * Create an empty workspace.
   * @param {{ title?: string }} [options]
   * @returns {Workspace}
   */
  static create(options = {}) {
    const workspace = new Workspace();
    if (typeof options.title === "string") {
      workspace._data.metadata.title = options.title;
    }
    return workspace;
  }

  /**
   * Rehydrate a workspace from serialized JSON.
   * @param {unknown} json Parsed JSON.
   * @param {{ validation?: import("./schema.js").ValidationOptions }} [options]
   *   Content validators and integrity checks; without them only the envelope is checked.
   * @returns {Workspace}
   * @throws {WorkspaceFormatError} On invalid or unmigratable data.
   */
  static fromJSON(json, options = {}) {
    const workspace = new Workspace();
    workspace.configureValidation(options.validation ?? {});
    const migrated = migrateWorkspace(json, workspace.validationOptions);
    if (migrated.data === null) {
      throw new WorkspaceFormatError(migrated.errors.join("; "));
    }
    workspace._data = migrated.data;
    return workspace;
  }

  // -- accessors ----------------------------------------------------------------

  /** @returns {string} */
  get id() {
    return this._data.metadata.id;
  }

  /** @returns {string} */
  get title() {
    return this._data.metadata.title;
  }

  /**
   * The live workspace data. Strictly read-only: it exists so renderers and reference
   * lookups do not pay for a deep copy per read. Mutate only through commands.
   * @returns {WorkspaceDocument}
   */
  get data() {
    return this._data;
  }

  /** @returns {WorkspaceDocument} Deep copy of the serialized state. */
  get serialized() {
    return structuredClone(this._data);
  }

  /**
   * Page envelope by id.
   * @param {string} pageId
   * @returns {PageEnvelope | undefined}
   */
  getPage(pageId) {
    const page = this._data.pages[pageId];
    return page ? structuredClone(page) : undefined;
  }

  /** @returns {PageEnvelope[]} All page envelopes. */
  getPages() {
    return Object.values(this._data.pages).map((page) => structuredClone(page));
  }

  /**
   * Favorite page ids in the order they were favorited (settings.favoritePageIds),
   * ignoring ids that no longer exist.
   * @returns {string[]}
   */
  getFavorites() {
    const ids = this._data.settings?.favoritePageIds;
    return Array.isArray(ids) ? ids.filter((id) => Boolean(this._data.pages[id])) : [];
  }

  /**
   * Ordered child page ids (top-level when parentId is null).
   * @param {string | null} parentId
   * @returns {string[]}
   */
  getChildren(parentId) {
    return parentId === null
      ? [...this._data.pageOrder.root]
      : [...(this._data.pageOrder[parentId] ?? [])];
  }

  /**
   * @param {string} pageId
   * @returns {string | null} Parent page id, or null when top-level.
   */
  getParent(pageId) {
    if (this._data.pageOrder.root.includes(pageId)) return null;
    for (const [parentId, children] of Object.entries(this._data.pageOrder)) {
      if (parentId !== "root" && children.includes(pageId)) return parentId;
    }
    return null;
  }

  // -- transactions -------------------------------------------------------------

  /**
   * Open a transaction so several commands commit as one history entry.
   * @param {string} label
   */
  beginTransaction(label) {
    if (this._open !== null) {
      throw new CommandError("transaction already open", "transactionNested");
    }
    this._before = structuredClone(this._data);
    this._open = { id: createId("tx"), label, commands: [], pageIds: new Set() };
  }

  /** Commit the transaction opened with `beginTransaction`. */
  commitTransaction() {
    if (this._open === null) {
      throw new CommandError("no transaction open", "transactionState");
    }
    const tx = this._open;
    const before = /** @type {WorkspaceDocument} */ (this._before);
    this._open = null;
    this._before = null;
    if (tx.commands.length > 0) {
      this._commit(tx, before);
    }
  }

  /**
   * Roll back the open transaction by restoring its start snapshot. Command
   * handlers must limit their effects to `_data` for rollback to be exact.
   */
  rollbackTransaction() {
    if (this._open === null) {
      throw new CommandError("no transaction open", "transactionState");
    }
    this._data = /** @type {WorkspaceDocument} */ (this._before);
    this._open = null;
    this._before = null;
  }

  /**
   * Run a function inside a transaction; rolls back on throw. Nested calls
   * (while a transaction is open) simply join the outer transaction.
   *
   * @template R
   * @param {string} label
   * @param {() => R} fn
   * @returns {R} The callback result.
   */
  transact(label, fn) {
    if (this._open !== null) {
      return fn();
    }
    this.beginTransaction(label);
    try {
      const result = fn();
      this.commitTransaction();
      return result;
    } catch (error) {
      this.rollbackTransaction();
      throw error;
    }
  }

  /**
   * Push a committed transaction onto history and notify subscribers.
   * @param {Transaction} tx
   * @param {WorkspaceDocument} before State at transaction start.
   */
  _commit(tx, before) {
    // modifiedAt belongs inside the "after" snapshot so undo/redo restore it.
    this._data.metadata.modifiedAt = nowIso();
    const entry = /** @type {HistoryEntry} */ ({
      id: tx.id,
      label: tx.label,
      commands: tx.commands.map((c) => c.type),
      before,
      after: structuredClone(this._data),
      pageIds: [...tx.pageIds]
    });
    this._redo.length = 0;
    this._history.push(entry);
    this.dirty = true;
    this.events.emit("change", {
      kind: "commit",
      transactionId: entry.id,
      label: entry.label,
      commands: entry.commands,
      pages: entry.pageIds
    });
  }

  // -- commands -------------------------------------------------------------------

  /**
   * Register a command handler.
   * @param {string} type
   * @param {(store: Workspace, tx: Transaction, payload: unknown) => void} handler
   *   Validates, then mutates `store._data`, recording touched page ids in
   *   `tx.pageIds`. Throw CommandError on invalid payload.
   * @param {Partial<CommandMeta>} [meta]
   *   `hot`: cannot move, add or remove structure other content depends on (typing, dragging),
   *   so cross-cutting hooks skip their expensive checks. `selfManaged`: the handler does its own
   *   bookkeeping for that structure, so hooks do not capture for it.
   */
  registerCommand(type, handler, meta = {}) {
    if (this._commands.has(type)) {
      throw new Error(`command "${type}" is already registered`);
    }
    this._commands.set(type, handler);
    this._commandMeta.set(type, { hot: meta.hot === true, selfManaged: meta.selfManaged === true });
  }

  /**
   * Registration facts of a command (both false for an unknown type).
   * @param {string} type
   * @returns {CommandMeta}
   */
  commandMeta(type) {
    return this._commandMeta.get(type) ?? { hot: false, selfManaged: false };
  }

  /**
   * Register a hook around every command, in the same transaction. It runs before
   * the handler and may return a callback that runs after it (and may mutate `_data`).
   * @param {(store: Workspace, tx: Transaction, type: string, payload: unknown) => (void | (() => void))} fn
   */
  aroundCommand(fn) {
    this._commandHooks.push(fn);
  }

  /**
   * Whether a command type is registered.
   * @param {string} type
   * @returns {boolean}
   */
  hasCommand(type) {
    return this._commands.has(type);
  }

  /**
   * Validate then apply a command. Inside an open transaction it is grouped;
   * otherwise it runs as its own single-command transaction.
   *
   * @param {string} type
   * @param {unknown} payload
   * @throws {CommandError} On unknown command or failed validation.
   */
  dispatch(type, payload) {
    const handler = this._commands.get(type);
    if (!handler) {
      throw new CommandError(`unknown command: ${type}`, "unknownCommand");
    }
    /** @param {Transaction} tx */
    const run = (tx) => {
      const afters = [];
      for (const hook of this._commandHooks) {
        const after = hook(this, tx, type, payload);
        if (typeof after === "function") afters.push(after);
      }
      handler(this, tx, payload);
      tx.commands.push({ type, payload });
      for (const after of afters) after();
    };
    if (this._open !== null) {
      run(this._open);
    } else {
      this.transact(type, () => run(/** @type {Transaction} */ (this._open)));
    }
  }

  // -- history ----------------------------------------------------------------

  /** @returns {boolean} Whether there is a transaction to undo. */
  get canUndo() {
    return this._history.length > 0;
  }

  /** @returns {boolean} Whether there is a transaction to redo. */
  get canRedo() {
    return this._redo.length > 0;
  }

  /**
   * Undo the most recent transaction.
   * @returns {boolean} Whether anything was undone.
   */
  undo() {
    const entry = this._history.pop();
    if (!entry) return false;
    this._data = structuredClone(entry.before);
    this._redo.push(entry);
    this.dirty = true;
    this.events.emit("change", { kind: "undo", transactionId: entry.id, label: entry.label });
    return true;
  }

  /**
   * Redo the most recently undone transaction.
   * @returns {boolean} Whether anything was redone.
   */
  redo() {
    const entry = this._redo.pop();
    if (!entry) return false;
    this._data = structuredClone(entry.after);
    this._history.push(entry);
    this.dirty = true;
    this.events.emit("change", { kind: "redo", transactionId: entry.id, label: entry.label });
    return true;
  }

  // -- persistence ------------------------------------------------------------

  /** Clear dirty state after a successful save/export. */
  markSaved() {
    this.dirty = false;
  }
}
