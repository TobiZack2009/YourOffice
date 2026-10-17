/**
 * Workspace JSON import/export (spec §4, §12).
 *
 * Validation/migration is shared with the store; this module only orchestrates
 * serialize → validate → deserialize. Import never mutates data on failure.
 */

import { WorkspaceFormatError } from "../core/errors.js";
import { Workspace } from "./store.js";
import { migrateWorkspace } from "./schema.js";

/** @typedef {import("./store.js").Workspace} Workspace */
/** @typedef {import("./schema.js").WorkspaceDocument} WorkspaceDocument */

/**
 * @param {Workspace} store
 * @param {{ pretty?: boolean }} [options]
 * @returns {string} JSON text. Dirty-state clearing is the caller's job.
 */
export function exportWorkspaceJSON(store, options = {}) {
  const doc = store.serialized;
  return options.pretty === false ? JSON.stringify(doc) : JSON.stringify(doc, null, 2);
}

/**
 * Parse + validate + migrate workspace JSON text, returning the store.
 * @param {string} text
 * @returns {Workspace}
 * @throws {WorkspaceFormatError} On malformed JSON or schema violations.
 */
export function importWorkspaceJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new WorkspaceFormatError(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return Workspace.fromJSON(data);
}

/**
 * @param {WorkspaceDocument} doc
 * @returns {WorkspaceDocument | null}
 */
export function migrateDocument(doc) {
  return migrateWorkspace(doc).data;
}
