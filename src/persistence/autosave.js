/**
 * Autosave: keep the stored copy of a workspace in step with the live one.
 *
 * It listens to the workspace's `change` events and writes `workspace.serialized` after 1 s
 * without changes, or after 10 s of continuous changes at the latest. What it has persisted is
 * tracked by revision (`persistedRev`, separate from the explicit-export `savedRev` the
 * workspace keeps), so undoing back to the persisted state is clean and a failed write stays
 * pending. A write that finds a newer stored revision than the one this tab last saw reports a
 * conflict (another tab wrote) and then still writes: last write wins, the user is told.
 *
 * @typedef {"saved" | "pending" | "saving" | "failed"} AutosaveStatus
 *
 * @typedef {object} AutosaveOptions
 * @property {number} [idleMs] Quiet time before a write (default 1000).
 * @property {number} [maxWaitMs] Longest a change waits (default 10000).
 * @property {boolean} [persisted] The workspace is already what is stored (it was just loaded).
 * @property {number} [revision] Revision of the stored record it was loaded from.
 * @property {() => number} [now]
 * @property {(stored: import("./storage.js").StoredWorkspace) => void} [onConflict]
 *
 * @typedef {object} Autosave
 * @property {boolean} pending Changes not yet in storage (waiting, writing, or failed).
 * @property {AutosaveStatus} status
 * @property {Error | null} error The last write's failure, until a write succeeds.
 * @property {() => Promise<boolean>} flush Write now; true when the stored copy is current.
 * @property {(listener: () => void) => () => void} subscribe Called when `status` changes.
 * @property {() => void} destroy
 */

/**
 * @param {import("../workspace/store.js").Workspace} workspace
 * @param {import("./storage.js").WorkspaceStorage} storage
 * @param {AutosaveOptions} [options]
 * @returns {Autosave}
 */
export function createAutosave(workspace, storage, options = {}) {
  const idleMs = options.idleMs ?? 1000;
  const maxWaitMs = options.maxWaitMs ?? 10000;
  const now = options.now ?? Date.now;

  let persistedRev = options.persisted ? workspace.revision : -1;
  let knownRevision = options.revision ?? 0;
  /** @type {Error | null} */
  let error = null;
  /** @type {Promise<void> | null} */
  let writing = null;
  let destroyed = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idleTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let maxTimer = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {AutosaveStatus} */
  let current = options.persisted ? "saved" : "pending";

  const stale = () => workspace.revision !== persistedRev;

  /** @returns {AutosaveStatus} */
  function computeStatus() {
    if (writing) return "saving";
    if (error) return "failed";
    return stale() ? "pending" : "saved";
  }

  function publish() {
    const next = computeStatus();
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  }

  function clearTimers() {
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    idleTimer = maxTimer = null;
  }

  function schedule() {
    if (destroyed || writing) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void write(), idleMs);
    maxTimer ??= setTimeout(() => void write(), maxWaitMs);
  }

  async function writeOnce() {
    const id = workspace.id;
    try {
      const stored = await storage.load(id);
      if (stored && stored.revision > knownRevision) options.onConflict?.(stored);
      // Snapshot after the await: what is written and the revision it stands for go together.
      const rev = workspace.revision;
      const data = workspace.serialized;
      const revision = Math.max(knownRevision, stored?.revision ?? 0) + 1;
      await storage.save({ id, savedAt: now(), revision, data });
      knownRevision = revision;
      persistedRev = rev;
      error = null;
    } catch (failure) {
      error = failure instanceof Error ? failure : new Error(String(failure));
    }
  }

  /** @returns {Promise<void>} */
  function write() {
    clearTimers();
    if (writing) return writing;
    if (!stale() && !error) return Promise.resolve();
    writing = writeOnce().finally(() => {
      writing = null;
      publish();
      if (destroyed) return;
      // Changes that arrived during the write, or a failed write, are tried again later.
      if (!stale()) return;
      if (error) idleTimer = setTimeout(() => void write(), maxWaitMs);
      else schedule();
    });
    publish();
    return writing;
  }

  const unsubscribe = workspace.events.on("change", () => {
    if (destroyed) return;
    publish();
    schedule();
  });

  if (stale()) schedule();

  return {
    get pending() {
      return computeStatus() !== "saved";
    },
    get status() {
      return computeStatus();
    },
    get error() {
      return error;
    },
    async flush() {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await write();
        if (writing) await writing;
        if (!stale() && !error) return true;
        if (error) return false;
      }
      return !stale() && !error;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      clearTimers();
      unsubscribe();
      listeners.clear();
    }
  };
}

/**
 * Flush when the page is hidden or going away, and warn about leaving only while a write is
 * pending or failed. (An IndexedDB write begun in `pagehide` is best effort.)
 * @param {Autosave} autosave
 * @param {{ window?: Window, document?: Document }} [env]
 * @returns {() => void} Detach.
 */
export function attachPageLifecycle(autosave, env = {}) {
  const win = env.window ?? window;
  const doc = env.document ?? document;
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") void autosave.flush();
  };
  const onPageHide = () => void autosave.flush();
  /** @param {BeforeUnloadEvent} event */
  const onBeforeUnload = (event) => {
    if (!autosave.pending) return;
    void autosave.flush();
    event.preventDefault();
    event.returnValue = "";
  };
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pagehide", onPageHide);
  win.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pagehide", onPageHide);
    win.removeEventListener("beforeunload", onBeforeUnload);
  };
}
