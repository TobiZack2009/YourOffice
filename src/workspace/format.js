/**
 * Workspace JSON import/export (spec §4, §12).
 *
 * Validation/migration is shared with the store; this module only orchestrates
 * serialize → validate → deserialize. Import never mutates data on failure.
 */

import { WorkspaceFormatError } from "../core/errors.js";
import { Workspace } from "./store.js";
import { migrateWorkspace, validateWorkspace } from "./schema.js";

/** @typedef {import("./store.js").Workspace} Workspace */
/** @typedef {import("./schema.js").WorkspaceDocument} WorkspaceDocument */

/**
 * @param {Workspace} store
 * @param {{ pretty?: boolean }} [options]
 * @returns {string} JSON text. Dirty-state clearing is the caller's job.
 * @throws {WorkspaceFormatError} When the workspace is corrupt: it is never written out.
 */
export function exportWorkspaceJSON(store, options = {}) {
  const doc = store.serialized;
  const check = validateWorkspace(doc, store.validationOptions);
  if (!check.valid) {
    throw new WorkspaceFormatError(`refusing to export a corrupt workspace: ${check.errors.join("; ")}`);
  }
  return options.pretty === false ? JSON.stringify(doc) : JSON.stringify(doc, null, 2);
}

/**
 * Parse + validate + migrate workspace JSON text, returning the store. Without `validation`
 * only the envelope is checked; `domain/` supplies the full rules and installs the features.
 * @param {string} text
 * @param {{ validation?: import("./schema.js").ValidationOptions, install?: (workspace: Workspace) => Workspace }} [options]
 * @returns {Workspace}
 * @throws {WorkspaceFormatError} On malformed JSON or schema violations.
 */
export function importWorkspaceJSON(text, options = {}) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new WorkspaceFormatError(
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const workspace = Workspace.fromJSON(data, { validation: options.validation });
  return options.install ? options.install(workspace) : workspace;
}

/**
 * @param {WorkspaceDocument} doc
 * @returns {WorkspaceDocument | null}
 */
export function migrateDocument(doc) {
  return migrateWorkspace(doc).data;
}
