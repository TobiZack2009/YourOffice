/**
 * The workspaces kept in storage, as a list the user can choose from: what is there, how to open
 * one, how to remove one. Recovery copies (see `restore.js`) are listed too, flagged, so they can
 * be deleted; they are kept because they failed validation, so they are not openable.
 *
 * @typedef {object} WorkspaceInfo
 * @property {string} id
 * @property {string} title
 * @property {number} savedAt Milliseconds since the epoch.
 * @property {boolean} active Whether it is the one open now.
 * @property {boolean} recovery A copy kept after a failed restore.
 */

import { workspaceFromJSON } from "../domain/index.js";

const RECOVERY = /\.recovery-\d+$/;

/** @param {unknown} data @returns {string} */
function titleOf(data) {
  const title = /** @type {any} */ (data)?.metadata?.title;
  return typeof title === "string" && title.trim() ? title : "Untitled workspace";
}

/**
 * @param {import("./storage.js").WorkspaceStorage} storage
 * @param {string | null} activeId
 * @returns {Promise<WorkspaceInfo[]>} Real workspaces first, most recently saved on top.
 */
export async function listWorkspaces(storage, activeId) {
  const records = await storage.list();
  return records
    .map((record) => ({
      id: record.id,
      title: titleOf(record.data),
      savedAt: record.savedAt,
      active: record.id === activeId,
      recovery: RECOVERY.test(record.id)
    }))
    .sort((a, b) => Number(a.recovery) - Number(b.recovery) || b.savedAt - a.savedAt);
}

/**
 * @param {import("./storage.js").WorkspaceStorage} storage
 * @param {string} id
 * @returns {Promise<{ workspace: import("../workspace/store.js").Workspace, revision: number }>}
 * @throws When the record is missing or fails the full validation rules.
 */
export async function loadWorkspace(storage, id) {
  const record = await storage.load(id);
  if (!record) throw new Error("That workspace is no longer stored.");
  return { workspace: workspaceFromJSON(record.data), revision: record.revision };
}
