/**
 * Start-up: find the workspace the user had open and bring it back, or say why not.
 *
 * The id of the last-open workspace lives in a small pointer (`localStorage` in the browser);
 * the workspace itself is in the storage adapter. A stored record that fails the full rules is
 * never rewritten: a copy is kept under a recovery id, the caller is told, and the pointer is
 * left for the caller to move to a new workspace.
 *
 * @typedef {object} Pointer
 * @property {() => string | null} get
 * @property {(id: string) => void} set
 *
 * @typedef {object} Restored
 * @property {import("../workspace/store.js").Workspace | null} workspace Null when there is nothing usable.
 * @property {number} revision Revision of the record it came from.
 * @property {{ error: Error, recoveryId: string } | null} failure Set when a record was found but is unusable.
 */

import { workspaceFromJSON } from "../domain/index.js";

export const POINTER_KEY = "yourOffice.lastWorkspace";

/**
 * A pointer over a Storage-like object; one that throws (storage blocked) acts as empty.
 * @param {Pick<Storage, "getItem" | "setItem">} store
 * @param {string} [key]
 * @returns {Pointer}
 */
export function storagePointer(store, key = POINTER_KEY) {
  return {
    get() {
      try {
        return store.getItem(key);
      } catch {
        return null;
      }
    },
    set(id) {
      try {
        store.setItem(key, id);
      } catch {
        /* the pointer is a convenience; losing it only means the next visit starts fresh */
      }
    }
  };
}

/**
 * @param {{ storage: import("./storage.js").WorkspaceStorage, pointer: Pointer, now?: () => number }} deps
 * @returns {Promise<Restored>}
 */
export async function restoreWorkspace({ storage, pointer, now = Date.now }) {
  const id = pointer.get();
  if (!id) return { workspace: null, revision: 0, failure: null };
  let record;
  try {
    record = await storage.load(id);
  } catch (error) {
    return { workspace: null, revision: 0, failure: { error: asError(error), recoveryId: "" } };
  }
  if (!record) return { workspace: null, revision: 0, failure: null };
  try {
    return { workspace: workspaceFromJSON(record.data), revision: record.revision, failure: null };
  } catch (error) {
    const recoveryId = `${id}.recovery-${now()}`;
    try {
      await storage.save({ ...record, id: recoveryId });
    } catch {
      /* the original record is untouched either way */
    }
    return { workspace: null, revision: 0, failure: { error: asError(error), recoveryId } };
  }
}

/** @param {unknown} error @returns {Error} */
function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
